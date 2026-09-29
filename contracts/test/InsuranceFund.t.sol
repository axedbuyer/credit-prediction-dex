// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {InsuranceFund} from "../src/InsuranceFund.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

// A "USDC-like" token with a transfer hook, standing in for the reentrancy
// vector real USDC doesn't have (plain ERC20, no hooks) so coverShortfall's
// nonReentrant guard can actually be exercised: on every transfer OUT of the
// InsuranceFund, if armed, it calls back into coverShortfall before the
// original call returns -- exactly the shape of a malicious/hookful token
// trying to drain the fund twice off a single authorized call.
contract MaliciousHookUSDC is ERC20 {
    InsuranceFund public fund;
    address public attackRecipient;
    bool public armed;

    constructor() ERC20("Malicious Hook USDC", "mUSDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFund(InsuranceFund _fund) external {
        fund = _fund;
    }

    function arm(address recipient) external {
        armed = true;
        attackRecipient = recipient;
    }

    function _update(address from, address to, uint256 amount) internal override {
        super._update(from, to, amount);
        if (armed && from == address(fund)) {
            armed = false; // disarm first -- a single reentry attempt is enough to prove the guard
            fund.coverShortfall(1, attackRecipient);
        }
    }
}

contract InsuranceFundTest is Test {
    MockUSDC usdc;
    InsuranceFund fund;

    address admin     = address(this);
    address alice     = makeAddr("alice");
    address recipient = makeAddr("recipient");

    uint256 constant DEPOSIT_AMOUNT = 1_000e18;

    function setUp() public {
        usdc = new MockUSDC();
        fund = new InsuranceFund(admin, address(usdc));
    }

    // Fund the contract with USDC via alice (simulates fee inflows).
    function _deposit(uint256 amount) internal {
        usdc.mint(alice, amount);
        vm.prank(alice);
        usdc.approve(address(fund), amount);
        vm.prank(alice);
        fund.deposit(amount);
    }

    // ─── tests ────────────────────────────────────────────────────────────────

    function test_Deposit_Works() public {
        assertEq(fund.getBalance(), 0, "empty initially");

        _deposit(DEPOSIT_AMOUNT);

        assertEq(fund.getBalance(), DEPOSIT_AMOUNT,          "balance after deposit");
        assertEq(usdc.balanceOf(address(fund)), DEPOSIT_AMOUNT, "USDC held by contract");
        assertEq(usdc.balanceOf(alice), 0,                   "alice paid in full");
    }

    function test_WithdrawalBeforeTimelock_Reverts() public {
        _deposit(DEPOSIT_AMOUNT);

        // admin == address(this), so no prank needed
        uint256 wid = fund.initiateWithdrawal(DEPOSIT_AMOUNT, recipient);

        uint256 executeAfter = block.timestamp + 48 hours;
        vm.expectRevert(
            abi.encodeWithSelector(InsuranceFund.TimelockNotExpired.selector, executeAfter)
        );
        fund.executeWithdrawal(wid);
    }

    function test_WithdrawalAfterTimelock_Succeeds() public {
        _deposit(DEPOSIT_AMOUNT);

        uint256 wid = fund.initiateWithdrawal(DEPOSIT_AMOUNT, recipient);

        vm.warp(block.timestamp + 48 hours);
        fund.executeWithdrawal(wid);

        assertEq(usdc.balanceOf(recipient), DEPOSIT_AMOUNT, "recipient received USDC");
        assertEq(fund.getBalance(), 0,                      "fund drained");

        // Second execute must revert with AlreadyExecuted.
        vm.expectRevert(InsuranceFund.AlreadyExecuted.selector);
        fund.executeWithdrawal(wid);
    }

    function test_OnlyAdmin_CanInitiate() public {
        _deposit(DEPOSIT_AMOUNT);

        bytes32 adminRole = fund.DEFAULT_ADMIN_ROLE(); // cache before prank — external call
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                adminRole
            )
        );
        fund.initiateWithdrawal(DEPOSIT_AMOUNT, recipient);
    }

    function test_OnlyAdmin_CanExecute() public {
        _deposit(DEPOSIT_AMOUNT);
        uint256 wid = fund.initiateWithdrawal(DEPOSIT_AMOUNT, recipient);

        vm.warp(block.timestamp + 48 hours);

        bytes32 adminRole = fund.DEFAULT_ADMIN_ROLE(); // cache before prank — external call
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                adminRole
            )
        );
        fund.executeWithdrawal(wid);
    }

    // ─── a9476ea: constructor ZeroAddress guard ────────────────────────────────

    function test_Constructor_ZeroAddress_Reverts() public {
        vm.expectRevert(InsuranceFund.ZeroAddress.selector);
        new InsuranceFund(address(0), address(usdc));

        vm.expectRevert(InsuranceFund.ZeroAddress.selector);
        new InsuranceFund(admin, address(0));
    }

    // ─── a9476ea: coverShortfall (LIQUIDATOR_ROLE + nonReentrant) ──────────────

    function test_CoverShortfall_NonLiquidator_Reverts() public {
        _deposit(DEPOSIT_AMOUNT);

        bytes32 liquidatorRole = fund.LIQUIDATOR_ROLE(); // cache before prank — external call
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                liquidatorRole
            )
        );
        fund.coverShortfall(1e18, recipient);
    }

    function test_CoverShortfall_Liquidator_Succeeds() public {
        _deposit(DEPOSIT_AMOUNT);
        fund.grantRole(fund.LIQUIDATOR_ROLE(), admin); // admin == address(this), no prank needed

        fund.coverShortfall(100e18, recipient);

        assertEq(usdc.balanceOf(recipient), 100e18, "recipient received the covered shortfall");
        assertEq(fund.getBalance(), DEPOSIT_AMOUNT - 100e18, "fund balance reduced accordingly");
    }

    // Real USDC has no transfer hooks, so a live reentrancy through
    // coverShortfall's own safeTransfer is not reachable with the production
    // token — this test substitutes a mock ERC20 with a transfer hook (see
    // MaliciousHookUSDC above) purely to exercise the nonReentrant guard itself:
    // the hook calls back into coverShortfall mid-transfer, and the guard must
    // reject that nested call, reverting the ENTIRE outer call (Solidity's
    // default call semantics bubble the inner revert all the way up) so no
    // funds move at all.
    function test_CoverShortfall_NonReentrant_BlocksReentry() public {
        MaliciousHookUSDC mal = new MaliciousHookUSDC();
        InsuranceFund malFund = new InsuranceFund(admin, address(mal));
        malFund.grantRole(malFund.LIQUIDATOR_ROLE(), admin);

        mal.mint(address(malFund), 1_000e18);
        mal.setFund(malFund);
        mal.arm(recipient);

        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        malFund.coverShortfall(100e18, recipient);

        // The whole call reverted -- no funds moved, armed hook never got to fire twice.
        assertEq(mal.balanceOf(address(malFund)), 1_000e18, "reentrant call fully reverted, no funds moved");
        assertEq(mal.balanceOf(recipient), 0, "recipient received nothing from the reverted call");
    }
}
