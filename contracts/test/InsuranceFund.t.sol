// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {InsuranceFund} from "../src/InsuranceFund.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
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
}
