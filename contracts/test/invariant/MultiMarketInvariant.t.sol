// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, StdInvariant, console2} from "forge-std/Test.sol";
import {MarketRegistry} from "../../src/MarketRegistry.sol";
import {InsuranceFund} from "../../src/InsuranceFund.sol";
import {Handler, MockUSDC} from "./Handler.sol";
import {MarketSetBuilder} from "../helpers/MarketSetBuilder.sol";

/// @title Multi-market stateful invariants
///
/// Two complete market sets (A, B) share ONE MockUSDC and ONE InsuranceFund; one Handler
/// per market (same five actors in both, so every actor can hold positions in both) and
/// both handlers are fuzz targets, interleaved. The single-market invariants from
/// CreditMarketInvariant.t.sol are asserted for EACH market, plus the cross-market ones:
///
///  (a) a market's CreditMarket USDC balance moves only through its own contracts —
///      every Handler action snapshots the OTHER market's collateral and counts any
///      change (`ghost_foreignCollateralDelta`), and every liquidation claim must move
///      its own market's collateral by exactly owed(user) (less the liquidator's NO
///      credit payout) — so a tail-case shortfall can only land in the claiming market
///      (`ghost_claimCollateralMismatch`);
///  (b) shared InsuranceFund balance == Σ seeds + Σ deposits + Σ FeeCharged.toInsurance
///      (both CLOBs, from emitted events) − Σ tail-case shortfalls (owed − m×Q).
contract MultiMarketInvariantTest is StdInvariant, Test {
    MockUSDC usdc;
    InsuranceFund insuranceFund;
    MarketRegistry registry;
    MarketSetBuilder.MarketSet A;
    MarketSetBuilder.MarketSet B;
    Handler hA;
    Handler hB;

    address admin = address(this);
    address teamWallet = makeAddr("teamWallet");

    uint256 lastCumA;
    uint256 lastCumB;

    function setUp() public {
        usdc = new MockUSDC();
        insuranceFund = new InsuranceFund(admin, address(usdc));
        registry = new MarketRegistry(admin, address(usdc), address(insuranceFund));
        A = MarketSetBuilder.build(address(usdc), insuranceFund, "YES-A", "NO-A", 0.05e18);
        B = MarketSetBuilder.build(address(usdc), insuranceFund, "YES-B", "NO-B", 0.08e18);

        _configure(A);
        _configure(B);
        _register(A, "market-a");
        _register(B, "market-b");

        hA = new Handler(usdc, A.yes, A.no, A.market, A.clob, A.router, insuranceFund, A.engine, teamWallet);
        hB = new Handler(usdc, B.yes, B.no, B.market, B.clob, B.router, insuranceFund, B.engine, teamWallet);
        _grantHandler(A, hA);
        _grantHandler(B, hB);
        hA.setWatchedMarket(address(B.market));
        hB.setWatchedMarket(address(A.market));

        lastCumA = A.market.cumulativeFundingPerYES();
        lastCumB = B.market.cumulativeFundingPerYES();

        targetContract(address(hA));
        targetContract(address(hB));
        bytes4[] memory sel = _selectors();
        targetSelector(StdInvariant.FuzzSelector({addr: address(hA), selectors: sel}));
        targetSelector(StdInvariant.FuzzSelector({addr: address(hB), selectors: sel}));
    }

    function _configure(MarketSetBuilder.MarketSet memory s) internal {
        s.market.setMarkBounds(0.05e18, 1 hours);
        s.market.setDepositCap(10_000e18);
        s.clob.setFeeConfig(50, teamWallet, address(insuranceFund), 5_000);
    }

    function _register(MarketSetBuilder.MarketSet memory s, string memory slug) internal {
        registry.register(
            slug,
            slug,
            MarketRegistry.EntityType.Corporate,
            MarketRegistry.MarketContracts({
                creditMarket: address(s.market),
                yesToken: address(s.yes),
                noToken: address(s.no),
                clobSettlement: address(s.clob),
                oracleRouter: address(s.router),
                liquidationEngine: address(s.engine)
            }),
            1
        );
    }

    function _grantHandler(MarketSetBuilder.MarketSet memory s, Handler h) internal {
        s.market.grantRole(s.market.KEEPER_ROLE(), address(h));
        s.market.grantRole(s.market.ORACLE_ROLE(), address(h));
        s.market.grantRole(s.market.DEFAULT_ADMIN_ROLE(), address(h));
        s.router.grantRole(s.router.ORACLE_ROLE(), address(h));
        s.clob.grantRole(s.clob.DEFAULT_ADMIN_ROLE(), address(h));
    }

    function _selectors() internal pure returns (bytes4[] memory s) {
        s = new bytes4[](23);
        s[0] = Handler.mint.selector;
        s[1] = Handler.redeem.selector;
        s[2] = Handler.settleYES.selector;
        s[3] = Handler.clobTrade.selector;
        s[4] = Handler.warpAndAccrue.selector;
        s[5] = Handler.warpLarge.selector;
        s[6] = Handler.setMark.selector;
        s[7] = Handler.flagClaimable.selector;
        s[8] = Handler.cure.selector;
        s[9] = Handler.liquidationClaim.selector;
        s[10] = Handler.confirmCreditEvent.selector;
        s[11] = Handler.setMotionPending.selector;
        s[12] = Handler.toggleFee.selector;
        s[13] = Handler.fundInsurance.selector;
        s[14] = Handler.seekSeizureBoundary.selector;
        s[15] = Handler.probeFlaggedActor.selector;
        s[16] = Handler.nearBoundaryTinyBuy.selector;
        s[17] = Handler.probeMissedSeizureFlag.selector;
        s[18] = Handler.adminSetMark.selector;
        s[19] = Handler.probeMarkStepBound.selector;
        s[20] = Handler.probeDepositCap.selector;
        s[21] = Handler.scenarioTailClaim.selector; // multi-market only: forces the IF shortfall path
        s[22] = Handler.scenarioFeeTrade.selector; // multi-market only: forces fee -> IF
    }

    // ── per-market invariants (each market, same checks as the single-market suite) ──

    function _completeSet(MarketSetBuilder.MarketSet memory s, Handler h) internal view {
        assertEq(s.yes.totalSupply(), h.ghost_yesMinted() - h.ghost_yesBurnedTotal(), "YES supply != mint/burn ledger");
        assertEq(s.no.totalSupply(), h.ghost_yesMinted() - h.ghost_noBurnedTotal(), "NO supply != mint/burn ledger");
        if (s.market.creditEventConfirmed()) return;
        assertEq(s.yes.totalSupply(), s.no.totalSupply(), "complete-set violated");
    }

    // Same exact equality as invariant_CollateralSolvencyPreEvent, per market.
    function _solvency(MarketSetBuilder.MarketSet memory s, Handler h) internal view {
        if (s.market.creditEventConfirmed()) return;
        uint256 cumYES = s.market.cumulativeFundingPerYES();
        uint256 cumNO = s.market.cumFundingPerNO();
        int256 sumDebt;
        int256 sumYesDebit;
        int256 sumNoCredit;
        uint256 n = h.numActors();
        for (uint256 i = 0; i < n; i++) {
            address u = h.actorAt(i);
            sumDebt += int256(s.market.fundingDebt(u));
            sumYesDebit += int256(s.yes.balanceOf(u) * (cumYES - s.market.fundingSnapshot(u)) / 1e18);
            sumNoCredit += int256(s.no.balanceOf(u) * (cumNO - s.market.snapNO(u)) / 1e18);
        }
        int256 expected = int256(s.yes.totalSupply()) - sumDebt - sumYesDebit + sumNoCredit;
        assertApproxEqAbs(
            int256(usdc.balanceOf(address(s.market))),
            expected,
            2 * n,
            "market collateral diverged from the derived solvency formula"
        );
    }

    function invariant_A_CompleteSetAndSupply() public view {
        _completeSet(A, hA);
    }

    function invariant_B_CompleteSetAndSupply() public view {
        _completeSet(B, hB);
    }

    function invariant_A_CollateralSolvencyPreEvent() public view {
        _solvency(A, hA);
    }

    function invariant_B_CollateralSolvencyPreEvent() public view {
        _solvency(B, hB);
    }

    function invariant_FundingIndicesEqualAndMonotonic() public {
        uint256 a = A.market.cumulativeFundingPerYES();
        uint256 b = B.market.cumulativeFundingPerYES();
        assertEq(a, A.market.cumFundingPerNO(), "A: YES index != NO index");
        assertEq(b, B.market.cumFundingPerNO(), "B: YES index != NO index");
        assertGe(a, lastCumA, "A: funding index decreased");
        assertGe(b, lastCumB, "B: funding index decreased");
        lastCumA = a;
        lastCumB = b;
    }

    function invariant_PerMarketHandlerGhostsClean() public view {
        Handler[2] memory hs = [hA, hB];
        for (uint256 i = 0; i < 2; i++) {
            Handler h = hs[i];
            assertEq(h.ghost_frozenMintSuccesses(), 0, "frozen mint succeeded");
            assertEq(h.ghost_frozenRedeemSuccesses(), 0, "frozen redeem succeeded");
            assertEq(h.ghost_frozenTradeSuccesses(), 0, "frozen trade succeeded");
            assertEq(h.ghost_owedDecreasedWhileFlagged(), 0, "owed decreased while flagged");
            assertEq(h.ghost_mintExceededCap(), 0, "deposit cap exceeded");
            assertEq(h.ghost_motionPendingFlagSuccesses(), 0, "flag during motion");
            assertEq(h.ghost_motionPendingClaimSuccesses(), 0, "claim during motion");
            assertEq(h.ghost_liquidationLedgerNotCleared(), 0, "ledger not cleared after claim");
            assertEq(h.ghost_missedSeizureFlag(), 0, "missed seizure flag");
            assertEq(h.ghost_redeemPayoutMismatch(), 0, "redeem payout mismatch");
            assertEq(h.ghost_settleYESPayoutMismatch(), 0, "settleYES payout mismatch");
        }
    }

    // ── cross-market invariants ─────────────────────────────────────────────────

    // (a) no action in one market ever changes the other market's CreditMarket USDC balance.
    function invariant_NoCrossMarketCollateralMovement() public view {
        assertEq(hA.ghost_foreignCollateralDelta(), 0, "an action on market A moved market B's collateral");
        assertEq(hB.ghost_foreignCollateralDelta(), 0, "an action on market B moved market A's collateral");
    }

    // (a) a claim's collateral inflow (P + tail-case shortfall) lands in the claiming market, in full.
    function invariant_ClaimsFundOwnMarketExactly() public view {
        assertEq(hA.ghost_claimCollateralMismatch(), 0, "A: claim moved A's collateral by != owed");
        assertEq(hB.ghost_claimCollateralMismatch(), 0, "B: claim moved B's collateral by != owed");
    }

    // (b) shared InsuranceFund ledger: seeds + deposits + fees from BOTH CLOBs - tail-case shortfalls.
    function invariant_SharedInsuranceFundAccounting() public view {
        uint256 inflow = hA.ghost_insuranceSeeded() + hB.ghost_insuranceSeeded() + hA.ghost_insuranceDeposited()
            + hB.ghost_insuranceDeposited() + hA.ghost_insuranceFeesIn() + hB.ghost_insuranceFeesIn();
        uint256 outflow = hA.ghost_insuranceShortfallOut() + hB.ghost_insuranceShortfallOut();
        assertEq(usdc.balanceOf(address(insuranceFund)), inflow - outflow, "shared InsuranceFund balance != ledger");
    }

    function invariant_RegistryUnchanged() public view {
        assertEq(registry.marketCount(), 2);
        assertEq(registry.getMarket(0).creditMarket, address(A.market));
        assertEq(registry.getMarket(1).creditMarket, address(B.market));
    }

    function afterInvariant() public view {
        console2.log("A claims normal/tail", hA.ghost_normalCaseClaims(), hA.ghost_tailCaseClaims());
        console2.log("B claims normal/tail", hB.ghost_normalCaseClaims(), hB.ghost_tailCaseClaims());
        console2.log("IF fees in A/B", hA.ghost_insuranceFeesIn(), hB.ghost_insuranceFeesIn());
        console2.log("IF shortfall out A/B", hA.ghost_insuranceShortfallOut(), hB.ghost_insuranceShortfallOut());
    }
}
