// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {YESToken} from "../src/YESToken.sol";
import {NOToken} from "../src/NOToken.sol";
import {CreditMarket} from "../src/CreditMarket.sol";
import {InsuranceFund} from "../src/InsuranceFund.sol";
import {LiquidationEngine} from "../src/LiquidationEngine.sol";
import {OracleRouter} from "../src/OracleRouter.sol";

contract MockUSDCEscrow is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// Batch 4: informational motions + carry escrow from the EDD
/// (docs/design/motion-escrow-and-mark.md §5). Alice holds Upbets only, Bob Downbets
/// only, so carry flows one way and every number can be checked exactly.
contract MotionEscrowTest is Test {
    MockUSDCEscrow usdc;
    YESToken yes;
    NOToken no;
    CreditMarket market;
    InsuranceFund fund;
    LiquidationEngine engine;
    OracleRouter router;

    address admin = address(this);
    address oracle = makeAddr("oracle");
    address keeper = makeAddr("keeper");
    address alice = makeAddr("alice"); // Upbets
    address bob = makeAddr("bob"); // Downbets
    address dave = makeAddr("dave"); // buys Bob's Downbets
    address liq = makeAddr("liquidator");
    address opener = makeAddr("motionOpener");

    uint256 constant Q = 1_000e18;
    uint256 constant MARK = 0.10e18;

    function setUp() public {
        usdc = new MockUSDCEscrow();
        yes = new YESToken(admin, "YES", "YES");
        no = new NOToken(admin, "NO", "NO");
        fund = new InsuranceFund(admin, address(usdc));
        market = new CreditMarket(admin, address(usdc), address(yes), address(no), MARK, 1 days);
        engine = new LiquidationEngine(address(market), address(fund));
        router = new OracleRouter(admin, address(market));

        yes.grantRole(yes.MINTER_ROLE(), address(market));
        yes.grantRole(yes.BURNER_ROLE(), address(market));
        no.grantRole(no.MINTER_ROLE(), address(market));
        no.grantRole(no.BURNER_ROLE(), address(market));
        yes.grantRole(yes.CLOB_ROLE(), address(engine));
        yes.grantRole(yes.CLOB_ROLE(), admin); // _move below stands in for a CLOB fill
        no.grantRole(no.CLOB_ROLE(), admin);
        market.grantRole(market.LIQUIDATOR_ROLE(), address(engine));
        market.grantRole(market.KEEPER_ROLE(), keeper);
        market.grantRole(market.ORACLE_ROLE(), oracle);
        market.grantRole(market.ORACLE_ROLE(), address(router));
        fund.grantRole(fund.LIQUIDATOR_ROLE(), address(engine));
        router.grantRole(router.ORACLE_ROLE(), oracle);
        router.grantRole(router.MOTION_ROLE(), opener);
        usdc.mint(address(fund), 100_000e18);

        address[4] memory users = [alice, bob, dave, liq];
        for (uint256 i = 0; i < users.length; i++) {
            usdc.mint(users[i], 10_000e18);
            vm.startPrank(users[i]);
            usdc.approve(address(market), type(uint256).max);
            usdc.approve(address(engine), type(uint256).max);
            yes.approve(admin, type(uint256).max);
            no.approve(admin, type(uint256).max);
            vm.stopPrank();
        }

        // Alice mints Q pairs and "sells" the Downbets to Bob.
        vm.prank(alice);
        market.mint(Q);
        _move(IERC20(address(no)), alice, bob, Q);
    }

    // A CLOB fill without the USDC leg: settle both parties' funding, then move tokens.
    function _move(IERC20 token, address from, address to, uint256 amount) internal {
        market.settleFunding(from);
        market.settleFunding(to);
        token.transferFrom(from, to, amount);
    }

    // Carry on Q tokens over `dt`, as the index would accrue it (Downbet credit, rounded down).
    function _carry(uint256 dt) internal view returns (uint256) {
        return Q * (market.currentCarryRate() * dt / 365 days) / 1e18;
    }

    function _open() internal {
        vm.prank(oracle);
        router.setMotionPending(true);
    }

    // ── motion lifecycle ────────────────────────────────────────────────────────

    function test_OpenMotion_RecordsEddIndex() public {
        vm.warp(block.timestamp + 10 days);
        _open();
        assertTrue(market.motionPending());
        assertEq(market.motionId(), 1);
        assertEq(market.motionIndex(1), market.cumulativeFundingPerYES(), "EDD index = index at open");
        assertEq(uint256(market.motionOutcome(1)), uint256(CreditMarket.MotionOutcome.Open));
    }

    function test_SetMotionPending_SameState_Reverts() public {
        vm.prank(oracle);
        vm.expectRevert(CreditMarket.MotionStateUnchanged.selector);
        router.setMotionPending(false);
        _open();
        vm.prank(oracle);
        vm.expectRevert(CreditMarket.MotionStateUnchanged.selector);
        router.setMotionPending(true);
    }

    function test_MotionOpener_CanOpenButNotClose() public {
        vm.prank(opener);
        router.openMotion();
        assertTrue(market.motionPending(), "opener opened");

        vm.prank(opener);
        vm.expectRevert();
        router.setMotionPending(false);

        vm.prank(opener);
        vm.expectRevert();
        router.confirmCreditEvent();

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(OracleRouter.NotMotionOpener.selector, alice));
        router.openMotion();
    }

    function test_SetMotion_AfterConfirm_Reverts() public {
        vm.prank(oracle);
        router.confirmCreditEvent();
        vm.prank(oracle);
        vm.expectRevert(CreditMarket.CreditEventAlreadyConfirmed.selector);
        router.setMotionPending(true);
    }

    // ── §5.6: a Downbet seller during a motion ─────────────────────────────────

    function test_DownbetSeller_DcNo_ReleasesEscrow() public {
        vm.warp(block.timestamp + 10 days);
        _open();
        vm.warp(block.timestamp + 15 days);

        uint256 before = usdc.balanceOf(bob);
        _move(IERC20(address(no)), bob, dave, Q); // Bob exits 15 days after the EDD
        uint256 paidOnSale = usdc.balanceOf(bob) - before;
        (uint256 escrowed,,,) = market.escrowOf(bob);

        assertApproxEqAbs(paidOnSale, _carry(10 days), 2, "pre-EDD carry paid in cash on the sale");
        assertApproxEqAbs(escrowed, _carry(15 days), 2, "post-EDD carry escrowed, not paid");

        vm.prank(oracle);
        router.setMotionPending(false); // DC rules No

        before = usdc.balanceOf(bob);
        market.settleFunding(bob); // anyone can trigger Bob's payout
        assertEq(usdc.balanceOf(bob) - before, escrowed, "escrow released to Bob on a No");
        (escrowed,,,) = market.escrowOf(bob);
        assertEq(escrowed, 0, "record folded");
    }

    function test_DownbetSeller_DcYes_CancelsEscrow() public {
        vm.warp(block.timestamp + 10 days);
        _open();
        vm.warp(block.timestamp + 15 days);
        _move(IERC20(address(no)), bob, dave, Q);

        vm.prank(oracle);
        router.confirmCreditEvent(); // DC rules Yes

        uint256 before = usdc.balanceOf(bob);
        market.settleFunding(bob);
        assertEq(usdc.balanceOf(bob), before, "escrow cancelled on a Yes");
    }

    // ── carry stops at the EDD on a Yes ─────────────────────────────────────────

    function test_DcYes_UpbetPaysOnlyPreEddCarry() public {
        vm.warp(block.timestamp + 10 days);
        _open();
        vm.warp(block.timestamp + 30 days);
        vm.prank(oracle);
        router.confirmCreditEvent();

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        market.settleYES(Q);
        uint256 payout = usdc.balanceOf(alice) - before;
        assertApproxEqAbs(payout, Q - _carry(10 days), 2, "$1 per Upbet minus pre-EDD carry only");
    }

    function test_DcNo_UpbetOwesAllCarry() public {
        vm.warp(block.timestamp + 10 days);
        _open();
        vm.warp(block.timestamp + 30 days);
        vm.prank(oracle);
        router.setMotionPending(false);
        assertApproxEqAbs(market.owed(alice), _carry(40 days), 1e4, "a No makes post-EDD carry ordinary"); // helper floors per day-span
    }

    function test_ConfirmWithoutMotion_VoidsNothing() public {
        vm.warp(block.timestamp + 40 days);
        vm.prank(oracle);
        router.confirmCreditEvent();
        assertEq(market.motionId(), 1, "implicit motion recorded");
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        market.settleYES(Q);
        assertApproxEqAbs(usdc.balanceOf(alice) - before, Q - _carry(40 days), 2, "EDD = confirm time");
    }

    // ── pay carry during a motion, refunded on a Yes ───────────────────────────

    function test_PayCarryDuringMotion_RefundedOnYes() public {
        vm.warp(block.timestamp + 10 days);
        _open();
        vm.warp(block.timestamp + 15 days);

        uint256 owedNow = market.owed(alice);
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        market.cure();
        assertEq(before - usdc.balanceOf(alice), owedNow, "paid everything owed");
        (,, uint256 refundable,) = market.escrowOf(alice);
        assertApproxEqAbs(refundable, _carry(15 days), 3, "post-EDD part refundable");

        vm.prank(oracle);
        router.confirmCreditEvent();
        before = usdc.balanceOf(alice);
        vm.prank(alice);
        market.settleYES(Q);
        assertEq(usdc.balanceOf(alice) - before, Q + refundable, "$1 per Upbet plus the refund");
    }

    function test_PayCarryDuringMotion_KeptOnNo() public {
        vm.warp(block.timestamp + 10 days);
        _open();
        vm.warp(block.timestamp + 15 days);
        vm.prank(alice);
        market.cure();
        vm.prank(oracle);
        router.setMotionPending(false);
        market.settleFunding(alice);
        (,, uint256 refundable,) = market.escrowOf(alice);
        assertEq(refundable, 0, "refund lapses on a No");
        assertApproxEqAbs(market.owed(alice), 0, 1, "nothing more owed");
    }

    // ── liquidation during a motion ─────────────────────────────────────────────

    function _flagAlice() internal {
        vm.prank(keeper);
        market.flagClaimable(alice);
    }

    function test_ClaimDuringMotion_LiquidatorRefundedOnYes() public {
        vm.warp(block.timestamp + 360 days);
        _open();
        vm.warp(block.timestamp + 20 days);
        market.accrueFunding();
        assertTrue(market.isSeizable(alice), "seizable (pre + post carry counted)");
        _flagAlice();

        uint256 owedAtClaim = market.owed(alice);
        uint256 before = usdc.balanceOf(liq);
        vm.prank(liq);
        engine.claim(alice);
        assertEq(before - usdc.balanceOf(liq), owedAtClaim, "normal case: P = owed");
        (,, uint256 refundable,) = market.escrowOf(liq);
        assertApproxEqAbs(refundable, _carry(20 days), 3, "post-EDD part of P refundable to the liquidator");

        vm.prank(oracle);
        router.confirmCreditEvent();
        before = usdc.balanceOf(liq);
        vm.prank(liq);
        market.settleYES(Q);
        assertEq(usdc.balanceOf(liq) - before, Q + refundable, "liquidator: $1 per Upbet + refund");
    }

    function test_TailClaimDuringMotion_FundRefundedOnYes() public {
        vm.warp(block.timestamp + 360 days);
        _open();
        vm.warp(block.timestamp + 20 days);
        _flagAlice();
        uint256 postCarry = _carry(20 days); // at the 10% rate, before the gap
        market.adminSetMark(0.01e18); // gap the mark: tail case
        uint256 owedAtClaim = market.owed(alice);
        uint256 tokenValue = Q * market.currentMark() / 1e18;
        assertGt(owedAtClaim, tokenValue, "setup: tail case");

        vm.prank(liq);
        engine.claim(alice);
        (,, uint256 liqRefund,) = market.escrowOf(liq);
        (,, uint256 fundRefund,) = market.escrowOf(address(fund));
        assertEq(liqRefund, 0, "P = m*Q < pre-EDD debt: the liquidator paid no post-EDD carry");
        assertApproxEqAbs(fundRefund, postCarry, 3, "the fund's top-up covered the post-EDD part");

        vm.prank(oracle);
        router.confirmCreditEvent();
        uint256 before = usdc.balanceOf(address(fund));
        market.settleFunding(address(fund));
        assertEq(usdc.balanceOf(address(fund)) - before, fundRefund, "refund paid to the InsuranceFund");
    }

    // ── a motion blocks nothing ─────────────────────────────────────────────────

    function test_FlagDuringMotion_Succeeds() public {
        vm.warp(block.timestamp + 360 days);
        _open();
        vm.warp(block.timestamp + 20 days);
        _flagAlice();
        assertTrue(market.claimable(alice));
    }

    // ── previewFunding stays exact for the off-chain formulas during a motion ──

    function test_PreviewFunding_ExactDuringMotion() public {
        vm.warp(block.timestamp + 10 days);
        _open();
        vm.warp(block.timestamp + 15 days);

        int256 pAlice = market.previewFunding(alice, yes.balanceOf(alice), true);
        int256 pBob = market.previewFunding(bob, no.balanceOf(bob), false);
        int256 debtBeforeAlice = int256(market.fundingDebt(alice));
        int256 debtBeforeBob = int256(market.fundingDebt(bob));

        market.settleFunding(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        market.settleFunding(bob);

        assertEq(debtBeforeAlice - pAlice, int256(market.fundingDebt(alice)), "Upbet: fundingDebt - preview = debt after");
        assertEq(pBob - debtBeforeBob, int256(usdc.balanceOf(bob) - bobBefore), "Downbet: preview - fundingDebt = cash paid");
    }

    // ── conservation end-to-end ─────────────────────────────────────────────────

    function test_YesResolution_CollateralCoversEveryone() public {
        vm.warp(block.timestamp + 10 days);
        _open();
        vm.warp(block.timestamp + 15 days);
        _move(IERC20(address(no)), bob, dave, Q / 2); // mixed: Bob keeps half, Dave buys half
        vm.prank(alice);
        market.cure(); // Alice pays pre + post carry
        vm.warp(block.timestamp + 5 days);
        vm.prank(oracle);
        router.confirmCreditEvent();

        market.settleFunding(bob);
        market.settleFunding(dave);
        vm.prank(alice);
        market.settleYES(Q);
        assertLe(usdc.balanceOf(address(market)), 10, "only rounding dust left");
    }

    function test_NoResolution_CollateralCoversEveryone() public {
        vm.warp(block.timestamp + 10 days);
        _open();
        vm.warp(block.timestamp + 15 days);
        _move(IERC20(address(no)), bob, dave, Q / 2);
        vm.prank(oracle);
        router.setMotionPending(false);
        vm.warp(block.timestamp + 5 days);

        // Unwind: everyone settles; Alice pays what she owes; then pairs back out.
        vm.prank(alice);
        market.cure();
        market.settleFunding(bob);
        market.settleFunding(dave);
        // Q pairs are still outstanding: collateral must cover them (plus dust).
        uint256 bal = usdc.balanceOf(address(market));
        assertGe(bal, Q, "pairs fully backed after a No");
        assertLe(bal - Q, 10, "only rounding dust above the pairs");
    }
}
