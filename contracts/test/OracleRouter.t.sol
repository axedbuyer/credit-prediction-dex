// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {YESToken} from "../src/YESToken.sol";
import {NOToken} from "../src/NOToken.sol";
import {CreditMarket} from "../src/CreditMarket.sol";
import {OracleRouter} from "../src/OracleRouter.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract OracleRouterTest is Test {
    MockUSDC usdc;
    YESToken yesToken;
    NOToken noToken;
    CreditMarket market;
    OracleRouter router;

    address admin = address(this);
    address oracle = makeAddr("oracle");
    address alice = makeAddr("alice");

    uint256 constant INITIAL_USDC = 1_000e18;
    uint256 constant MARK = 0.30e18; // 30 % → alice gets 300 YES + 700 NO

    function setUp() public {
        usdc     = new MockUSDC();
        yesToken = new YESToken(admin);
        noToken  = new NOToken(admin);
        market   = new CreditMarket(
            admin, address(usdc), address(yesToken), address(noToken), MARK
        );
        router = new OracleRouter(admin, address(market));

        // Wire token roles for CreditMarket
        yesToken.grantRole(yesToken.MINTER_ROLE(), address(market));
        yesToken.grantRole(yesToken.BURNER_ROLE(), address(market));
        noToken.grantRole(noToken.MINTER_ROLE(), address(market));
        noToken.grantRole(noToken.BURNER_ROLE(), address(market));

        // OracleRouter holds ORACLE_ROLE on CreditMarket; oracle EOA holds it on OracleRouter.
        market.grantRole(market.ORACLE_ROLE(), address(router));
        router.grantRole(router.ORACLE_ROLE(), oracle);

        // Fund alice and mint tokens so the market holds collateral.
        usdc.mint(alice, INITIAL_USDC);
        vm.prank(alice);
        usdc.approve(address(market), type(uint256).max);
        vm.prank(alice);
        market.mint(INITIAL_USDC);
        // state: alice has 300e18 YES + 700e18 NO; market holds 1000e18 USDC
    }

    // ─── tests ────────────────────────────────────────────────────────────────

    function test_ConfirmEvent_RequiresRole() public {
        bytes32 oracleRole = router.ORACLE_ROLE(); // cache before prank — external call
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                alice,
                oracleRole
            )
        );
        router.confirmCreditEvent();
    }

    function test_ConfirmEvent_PausesMarket() public {
        assertFalse(market.paused(), "market not paused initially");

        vm.prank(oracle);
        router.confirmCreditEvent();

        assertTrue(market.paused(),              "market paused after event");
        assertTrue(market.creditEventConfirmed(), "flag set");
    }

    function test_ConfirmEvent_EnablesSettleYES() public {
        // Before credit event, settleYES must revert.
        vm.prank(alice);
        vm.expectRevert(CreditMarket.CreditEventNotConfirmed.selector);
        market.settleYES(1);

        // After credit event via router.
        vm.prank(oracle);
        router.confirmCreditEvent();

        // settleYES must now succeed for alice (she has YES tokens).
        uint256 yesBalance = yesToken.balanceOf(alice);
        assertGt(yesBalance, 0, "alice holds YES");
        vm.prank(alice);
        market.settleYES(yesBalance); // must not revert
        assertEq(yesToken.balanceOf(alice), 0, "YES fully burned");
    }

    function test_DoubleConfirm_Reverts() public {
        vm.prank(oracle);
        router.confirmCreditEvent();

        vm.prank(oracle);
        vm.expectRevert(CreditMarket.CreditEventAlreadyConfirmed.selector);
        router.confirmCreditEvent();
    }

    function test_SettleYES_ReturnsFullNotional() public {
        vm.prank(oracle);
        router.confirmCreditEvent();

        uint256 yesBalance     = yesToken.balanceOf(alice); // 300e18
        uint256 aliceUsdcBefore = usdc.balanceOf(alice);   // 0 (spent minting)

        vm.prank(alice);
        market.settleYES(yesBalance);

        assertEq(yesToken.balanceOf(alice), 0,                          "YES burned");
        assertEq(usdc.balanceOf(alice), aliceUsdcBefore + yesBalance,   "full notional");
    }

    function test_SettleNO_Reverts() public {
        vm.prank(oracle);
        router.confirmCreditEvent();

        // An address with no YES tokens cannot call settleYES.
        address noHolder = makeAddr("noHolder");
        assertGt(noToken.balanceOf(alice), 0, "alice has NO as proxy for NO holder");
        vm.prank(noHolder);
        vm.expectRevert(); // ERC20InsufficientBalance — no YES to burn
        market.settleYES(1);
    }

    function test_RedeemAfterEvent_Reverts() public {
        vm.prank(oracle);
        router.confirmCreditEvent(); // sets flag + pauses

        vm.prank(alice);
        vm.expectRevert(); // whenNotPaused fires before CreditEventAlreadyConfirmed
        market.redeem(1e18);
    }
}
