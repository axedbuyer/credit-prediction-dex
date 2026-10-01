// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, StdInvariant, console2} from "forge-std/Test.sol";
import {YESToken} from "../../src/YESToken.sol";
import {NOToken} from "../../src/NOToken.sol";
import {CreditMarket} from "../../src/CreditMarket.sol";
import {CLOBSettlement} from "../../src/CLOBSettlement.sol";
import {OracleRouter} from "../../src/OracleRouter.sol";
import {InsuranceFund} from "../../src/InsuranceFund.sol";
import {LiquidationEngine} from "../../src/LiquidationEngine.sol";
import {Handler, MockUSDC} from "./Handler.sol";

/// @title Stateful invariant suite for the Credit Prediction DEX protocol
///
/// Encodes the 10 "Critical invariants" from root CLAUDE.md's Funding Model
/// section against the REAL deployed contracts (contracts/src/*.sol), driven by
/// Handler.sol over a small fixed actor set. See docs/security/slither-2026-09-26.md
/// "Not covered by Slither" — this suite exists specifically to close that gap
/// ("fundingDebt ledger correctness across all settlement paths... this remains
/// squarely a testing/fuzzing/formal-methods concern").
///
/// ── Post-fix (docs/security/invariant-findings-2026-09-26.md) ──
///
/// `owed(user) = fundingDebt + yesBal * (cumYES - fundingSnapshot) / 1e18` is now the
/// SINGLE funding obligation, used everywhere (trigger, claim price, cure, display).
/// `frozenFunding` and the `_syncUserFunding`/`syncUserFunding` accounting-freeze path
/// are gone: a flag is a pure LOCK — funding keeps accruing live on a flagged position
/// exactly like an unflagged one. This closes F1 (frozen-YES/live-NO collateral leak)
/// and F4 (a CLOB trade resetting the seizure clock while ledger debt grows unseen) at
/// the root — there is no compensation term left to carry in the solvency formula, and
/// the seizure trigger reads live, ledger-inclusive `owed()` so a trade can no longer
/// hide debt from it.
///
/// ── The flagship invariant: Collateral Solvency (invariant_CollateralSolvencyPreEvent) ──
///
/// Derivation (see comments on the function itself for the line-by-line proof):
/// at any point before a credit event is confirmed,
///
///   usdc.balanceOf(market)
///     == YES.totalSupply()                                    (full $1-per-pair backing)
///      - Σ_u fundingDebt[u]                                    (uncollected YES-side debt)
///      - Σ_u YES.balanceOf(u) * (cumYES - fundingSnapshot[u]) / 1e18  (live accrual, uncollected)
///      + Σ_u NO.balanceOf(u) * (cumNO - snapNO[u]) / 1e18       (live NO credit, unpaid)
///
/// This is an EXACT equality (not a bound, modulo floor-rounding slack — see below) because
/// every term is computed with the same floor-division the contract itself uses internally,
/// and because YES.totalSupply() == NO.totalSupply() always pre-event (complete-set). It
/// directly encodes CLAUDE.md invariants 4 (NO always made whole), 7 (every settlement path
/// nets funding through the same ledger), and 9 (a funding debit is never erased without
/// equivalent USDC reaching collateral) — if any code path ever paid out a NO credit, or
/// forgave a YES debit, or mis-collected a liquidation payment, without the corresponding
/// cash actually landing in (or staying in) `market`, this equality breaks immediately.
/// Post-fix there is NO per-actor claimable/frozen branch and NO compensation ghost terms —
/// every actor (flagged or not) is summed identically, because there is no longer a frozen
/// state for the formula to special-case.
contract CreditMarketInvariantTest is StdInvariant, Test {
    MockUSDC usdc;
    YESToken yesToken;
    NOToken noToken;
    CreditMarket market;
    CLOBSettlement clob;
    OracleRouter router;
    InsuranceFund insuranceFund;
    LiquidationEngine liquidationEngine;

    Handler handler;

    address admin = address(this);
    address teamWallet = makeAddr("teamWallet");

    uint256 constant INITIAL_MARK = 0.05e18; // 5% — the CLAUDE.md worked example

    // Ghost for the monotonic-funding-index invariant; persists across the whole
    // campaign for a given invariant_* function (StdInvariant re-runs setUp per
    // invariant function, so this resets appropriately between them).
    uint256 internal lastCumYES;

    function setUp() public {
        // ── deploy (mirrors Integration.t.sol / IntegrationV1bTest) ────────────
        usdc = new MockUSDC();
        yesToken = new YESToken(admin);
        noToken = new NOToken(admin);
        market = new CreditMarket(admin, address(usdc), address(yesToken), address(noToken), INITIAL_MARK, 1 days);
        clob = new CLOBSettlement(address(market), admin);
        router = new OracleRouter(admin, address(market));
        insuranceFund = new InsuranceFund(admin, address(usdc));
        liquidationEngine = new LiquidationEngine(address(market), address(insuranceFund));

        // token roles
        yesToken.grantRole(yesToken.MINTER_ROLE(), address(market));
        yesToken.grantRole(yesToken.BURNER_ROLE(), address(market));
        noToken.grantRole(noToken.MINTER_ROLE(), address(market));
        noToken.grantRole(noToken.BURNER_ROLE(), address(market));

        // CLOB roles
        yesToken.grantRole(yesToken.CLOB_ROLE(), address(clob));
        noToken.grantRole(noToken.CLOB_ROLE(), address(clob));
        market.grantRole(market.CLOB_ROLE(), address(clob));

        // OracleRouter wiring
        market.grantRole(market.ORACLE_ROLE(), address(router));

        // LiquidationEngine wiring
        yesToken.grantRole(yesToken.CLOB_ROLE(), address(liquidationEngine)); // forcedTransfer
        market.grantRole(market.LIQUIDATOR_ROLE(), address(liquidationEngine));
        insuranceFund.grantRole(insuranceFund.LIQUIDATOR_ROLE(), address(liquidationEngine));

        // a9476ea launch guard-rails: turn ON both, with realistic values, so the
        // suite actually exercises the bounds (not just the unbounded defaults
        // the unit tests use). depositCap is set high enough to leave headroom
        // for test_Repro_SolvencyFormulaOneWeiRoundingSlack's own ~5024.13e18
        // mint total (same setUp(), so it must stay under this cap too) while
        // still being reachable by the fuzz campaign's mints well within a
        // single run's depth budget -- Handler.probeDepositCap additionally
        // drives supply deterministically up against the cap every call it
        // fires, rather than relying on mint()'s random amounts alone.
        market.setMarkBounds(0.05e18, 1 hours);
        market.setDepositCap(10_000e18);

        // ── deploy handler, then grant it the privileged roles it drives ───────
        handler = new Handler(usdc, yesToken, noToken, market, clob, router, insuranceFund, liquidationEngine, teamWallet);

        market.grantRole(market.KEEPER_ROLE(), address(handler));
        market.grantRole(market.ORACLE_ROLE(), address(handler)); // setMotionPending
        market.grantRole(market.DEFAULT_ADMIN_ROLE(), address(handler)); // adminSetMark (bypasses the bounds above)
        router.grantRole(router.ORACLE_ROLE(), address(handler)); // confirmCreditEvent
        clob.grantRole(clob.DEFAULT_ADMIN_ROLE(), address(handler)); // toggleFee

        // Trading fee live from the start (50 bps, 50/50) per root CLAUDE.md —
        // "set a nonzero fee config in setUp" — handler's toggleFee action then
        // flips it to 0 and back over the course of a run, exercising both the
        // fee and fee-free code paths.
        clob.setFeeConfig(50, teamWallet, address(insuranceFund), 5_000);

        lastCumYES = market.cumulativeFundingPerYES();

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](21);
        selectors[0] = Handler.mint.selector;
        selectors[1] = Handler.redeem.selector;
        selectors[2] = Handler.settleYES.selector;
        selectors[3] = Handler.clobTrade.selector;
        selectors[4] = Handler.warpAndAccrue.selector;
        selectors[5] = Handler.warpLarge.selector;
        selectors[6] = Handler.setMark.selector;
        selectors[7] = Handler.flagClaimable.selector;
        selectors[8] = Handler.cure.selector;
        selectors[9] = Handler.liquidationClaim.selector;
        selectors[10] = Handler.confirmCreditEvent.selector;
        selectors[11] = Handler.setMotionPending.selector;
        selectors[12] = Handler.toggleFee.selector;
        selectors[13] = Handler.fundInsurance.selector;
        selectors[14] = Handler.seekSeizureBoundary.selector;
        selectors[15] = Handler.probeFlaggedActor.selector;
        selectors[16] = Handler.nearBoundaryTinyBuy.selector;
        selectors[17] = Handler.probeMissedSeizureFlag.selector;
        selectors[18] = Handler.adminSetMark.selector;
        selectors[19] = Handler.probeMarkStepBound.selector;
        selectors[20] = Handler.probeDepositCap.selector;
        targetSelector(StdInvariant.FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    // ── invariant 3 + complete-set: YES/NO supply reconciliation ────────────────

    // yesToken.totalSupply() must always equal (total ever minted) - (total ever
    // burned via redeem+settleYES). Liquidation (claim()) never burns YES — it
    // only calls forcedTransfer — so if this ever diverged from actual
    // totalSupply(), it would mean some code path burned YES outside those two
    // tracked sites (i.e., liquidation burning YES, the invariant-3 violation).
    function invariant_YesSupplyReconciliation() public view {
        assertEq(
            yesToken.totalSupply(),
            handler.ghost_yesMinted() - handler.ghost_yesBurnedTotal(),
            "YES.totalSupply() diverged from mint/redeem/settleYES ledger -- something else is minting or burning YES (invariant 3 candidate)"
        );
    }

    // noToken.totalSupply() must always equal (total ever minted) - (total ever
    // burned via redeem). settleYES never burns NO (NO holders get nothing on a
    // credit event) so it is deliberately absent from this reconciliation.
    function invariant_NoSupplyReconciliation() public view {
        assertEq(
            noToken.totalSupply(),
            handler.ghost_yesMinted() - handler.ghost_noBurnedTotal(),
            "NO.totalSupply() diverged from mint/redeem ledger"
        );
    }

    // Complete-set invariant, scoped to BEFORE a credit event: settleYES only
    // burns YES post-event, so YES.totalSupply() < NO.totalSupply() afterwards is
    // expected and correct, not a violation (per root CLAUDE.md's own scoping
    // note on this invariant).
    function invariant_CompleteSetPreEvent() public view {
        if (market.creditEventConfirmed()) return;
        assertEq(
            yesToken.totalSupply(),
            noToken.totalSupply(),
            "YES.totalSupply() != NO.totalSupply() before a credit event (complete-set invariant)"
        );
    }

    // ── the flagship solvency invariant ─────────────────────────────────────────

    // Post-fix: NO compensation terms. Every actor is summed identically —
    // fundingDebt (uncollected ledger debt) + live unsynced YES accrual, netted
    // against live unsynced NO credit — regardless of whether they're currently
    // flagged, because a flag no longer changes how funding is priced (it only
    // locks mint/redeem/trade). See the contract-level doc comment above for the
    // full derivation.
    function invariant_CollateralSolvencyPreEvent() public view {
        if (market.creditEventConfirmed()) return;

        uint256 cumYES = market.cumulativeFundingPerYES();
        uint256 cumNO = market.cumFundingPerNO();

        int256 sumFundingDebt;
        int256 sumUnsyncedYesDebit;
        int256 sumUnsyncedNoCredit;

        uint256 n = handler.numActors();
        for (uint256 i = 0; i < n; i++) {
            address u = handler.actorAt(i);

            sumFundingDebt += int256(market.fundingDebt(u));

            uint256 yesBal = yesToken.balanceOf(u);
            uint256 fPerUnit = cumYES - market.fundingSnapshot(u);
            sumUnsyncedYesDebit += int256(yesBal * fPerUnit / 1e18);

            uint256 noBal = noToken.balanceOf(u);
            uint256 nPerUnit = cumNO - market.snapNO(u);
            sumUnsyncedNoCredit += int256(noBal * nPerUnit / 1e18);
        }

        int256 expected =
            int256(yesToken.totalSupply()) - sumFundingDebt - sumUnsyncedYesDebit + sumUnsyncedNoCredit;

        // Tolerance, not laxity: the contract settles each user's funding with its
        // OWN independent floor division at the moment that user is actually
        // synced (settleFunding), so the real on-chain balance is always exact by
        // construction. This invariant instead reconstructs "what balance SHOULD
        // be right now" by projecting every actor's unsynced funding as-if they
        // were all synced simultaneously -- and floor(a/d) + floor(b/d) can fall
        // up to 1 wei short of floor((a+b)/d) per actor whose YES/NO holdings for
        // the same unsynced interval are fragmented across a different set of
        // holders on the YES side vs the NO side (verified: a 2-mint + 1-YES-sale
        // sequence with N_ACTORS=5 reproduces an exact, deterministic 1-wei gap
        // this way -- see test_Repro_SolvencyFormulaOneWeiRoundingSlack). This is
        // pure measurement noise in the projection, not a real leak: it can never
        // exceed 1 wei per actor per side, so a tolerance of 2*N_ACTORS wei is
        // generous and still catches any real drift many orders of magnitude
        // below the token amounts in play (1e15+ per mint).
        assertApproxEqAbs(
            int256(usdc.balanceOf(address(market))),
            expected,
            2 * handler.numActors(),
            "CreditMarket USDC balance diverged from the derived solvency formula beyond floor-rounding slack (invariants 4/7/9)"
        );
    }

    // ── funding index invariants ─────────────────────────────────────────────────

    function invariant_FundingIndicesEqualAndMonotonic() public {
        uint256 cur = market.cumulativeFundingPerYES();
        assertEq(cur, market.cumFundingPerNO(), "cumulativeFundingPerYES != cumFundingPerNO");
        assertGe(cur, lastCumYES, "cumulativeFundingPerYES decreased -- funding index must be monotonic");
        lastCumYES = cur;
    }

    // ── invariant 10: flagged positions are fully locked ─────────────────────────

    function invariant_FlaggedPositionsLocked() public view {
        assertEq(handler.ghost_frozenMintSuccesses(), 0, "mint() succeeded for a flagged (claimable) user");
        assertEq(handler.ghost_frozenRedeemSuccesses(), 0, "redeem() succeeded for a flagged (claimable) user");
        assertEq(
            handler.ghost_frozenTradeSuccesses(),
            0,
            "a CLOB trade succeeded with a flagged (claimable) party on either side"
        );
    }

    // Post-fix replacement for invariant_FrozenFundingImmutableWhileFlagged:
    // frozenFunding no longer exists -- a flag is a pure LOCK, not an accounting
    // freeze, so funding must keep accruing live on a flagged position. owed()
    // for any actor who remains flagged/claimable across an action must never
    // DECREASE (it can only grow with time, or hold steady if none elapsed) --
    // see Handler.trackFlagged.
    function invariant_OwedNonDecreasingWhileFlagged() public view {
        assertEq(
            handler.ghost_owedDecreasedWhileFlagged(),
            0,
            "owed(user) decreased for a user who remained flagged/claimable across an action -- funding must keep accruing (no freeze) while locked"
        );
    }

    // ── a9476ea launch guard-rails: depositCap and bounded setMark ──────────────

    function invariant_DepositCapRespected() public view {
        assertEq(
            handler.ghost_mintExceededCap(),
            0,
            "mint() succeeded that pushed YES.totalSupply() above the depositCap in force at that moment"
        );
    }

    function invariant_MarkStepAndIntervalBoundsRespected() public view {
        assertEq(
            handler.ghost_keeperStepViolation(),
            0,
            "a KEEPER_ROLE setMark() succeeded with |newMark - oldMark| > maxMarkStep"
        );
        assertEq(
            handler.ghost_keeperIntervalViolation(),
            0,
            "a KEEPER_ROLE setMark() succeeded sooner than minMarkInterval after the previous mark update"
        );
    }

    // currentMark must always satisfy the same 0 < mark < 1e18 validity the
    // constructor and every setMark/adminSetMark call enforce -- across every
    // action in the campaign, including adminSetMark's bypass of the step/
    // interval bounds (which still enforces this validity check).
    function invariant_MarkAlwaysInValidRange() public view {
        uint256 m = market.currentMark();
        assertTrue(m > 0 && m < 1e18, "currentMark left the valid (0, 1e18) range");
    }

    // ── invariant 5: no flag/claim succeeds during a pending motion ─────────────

    function invariant_NoActionDuringMotionPending() public view {
        assertEq(
            handler.ghost_motionPendingFlagSuccesses(),
            0,
            "flagClaimable() succeeded while motionPending was true"
        );
        assertEq(
            handler.ghost_motionPendingClaimSuccesses(),
            0,
            "LiquidationEngine.claim() succeeded while motionPending was true"
        );
    }

    // ── liquidation ledger fully cleared after every claim ───────────────────────

    function invariant_LiquidationLedgerCleared() public view {
        assertEq(
            handler.ghost_liquidationLedgerNotCleared(),
            0,
            "fundingDebt for the original holder was not zero immediately after claim()"
        );
    }

    // ── invariant 9 (decoupled, per-action): redeem()/settleYES() payouts ──────
    // exactly match an independent reprojection of the funding delta
    // settleFunding would compute, for every SUCCESSFUL call (Handler._payoutMismatch,
    // checked at the call site). This exists specifically so a bug like "forgive
    // fundingDebt without deducting it from the payout" is caught directly and
    // immediately, without depending on the aggregate solvency formula's own
    // scope/timing/compensation logic above.
    function invariant_RedeemAndSettleYESPayoutMatchesLedger() public view {
        assertEq(
            handler.ghost_redeemPayoutMismatch(),
            0,
            "redeem() paid out an amount that does not match amount +/- the independently reprojected funding delta"
        );
        assertEq(
            handler.ghost_settleYESPayoutMismatch(),
            0,
            "settleYES() paid out an amount that does not match amount +/- the independently reprojected funding delta"
        );
    }

    // ── invariants 1 & 2: seizure trigger consistency, cost-basis independence ──

    // Recomputes isSeizable(user) independently from public state, using the
    // SPEC's formula re-derived from docs/security/invariant-findings-2026-09-26.md's
    // "Recommended fix": f_now is the TOTAL owed per unit, INCLUDING fundingDebt --
    // NOT just cumYES - fundingSnapshot(u) alone (that was the pre-fix formula this
    // suite used to mirror, which is exactly how F4 slipped through: a CLOB trade
    // resets fundingSnapshot and moves the accrued debit into fundingDebt, and the
    // old trigger-consistency check never looked at fundingDebt either, so it
    // couldn't have caught the bug it was nominally guarding). costBasis is not
    // even read here, which is itself part of what's being asserted: the trigger
    // cannot depend on it if an independent, cost-basis-free reimplementation
    // always agrees with the contract's own isSeizable().
    function invariant_SeizureTriggerConsistency() public view {
        uint256 cumYES = market.cumulativeFundingPerYES();
        uint256 m = market.currentMark();
        uint256 epochLength = market.epochLength();

        uint256 n = handler.numActors();
        for (uint256 i = 0; i < n; i++) {
            address u = handler.actorAt(i);
            uint256 yesBal = yesToken.balanceOf(u);

            bool expected;
            if (yesBal != 0) {
                uint256 accruedPerUnit = cumYES - market.fundingSnapshot(u);
                uint256 owedTotal = market.fundingDebt(u) + yesBal * accruedPerUnit / 1e18;
                uint256 value = yesBal * m / 1e18;
                uint256 nextEpoch = yesBal * (m * epochLength / 365 days) / 1e18;
                // Evaluated in totals (value vs owed+nextEpoch) rather than
                // per-unit, to avoid dividing by the balance -- equivalent to the
                // spec's per-unit "m <= 1.03 * f_next" scaled by yesBal on both sides.
                expected = value * 100 <= (owedTotal + nextEpoch) * 103;
            }

            assertEq(
                market.isSeizable(u),
                expected,
                "isSeizable() diverged from an independent, spec-derived (fundingDebt-inclusive) reimplementation"
            );
        }
    }

    // F4-type direct probe (docs/security/invariant-findings-2026-09-26.md,
    // "Next" section): no actor whose owed() + one epoch of projected accrual
    // crosses the spec's seizure threshold may remain unflaggable while
    // motionPending is false. Handler.probeMissedSeizureFlag independently
    // recomputes that threshold (not via market.isSeizable()) and attempts the
    // flag for every actor that satisfies it; any revert increments
    // ghost_missedSeizureFlag, asserted here to stay 0.
    function invariant_NoMissedSeizureFlags() public view {
        assertEq(
            handler.ghost_missedSeizureFlag(),
            0,
            "an actor whose owed()+one epoch crossed the seizure threshold could not be flagged (F4-type regression)"
        );
    }

    // ── CLOBSettlement never custodies funds; fees never touch collateral ───────
    // (Fee routing bugs would show up here directly, and any collateral leakage
    // via fees would also break invariant_CollateralSolvencyPreEvent above, since
    // fee flows are absent from that formula by design.)
    function invariant_CLOBNeverHoldsFunds() public view {
        assertEq(usdc.balanceOf(address(clob)), 0, "CLOBSettlement is holding USDC after settlement");
        assertEq(yesToken.balanceOf(address(clob)), 0, "CLOBSettlement is holding YES after settlement");
        assertEq(noToken.balanceOf(address(clob)), 0, "CLOBSettlement is holding NO after settlement");
    }

    // ── documented rounding-slack repro (NOT a contract bug) ────────────────────
    //
    // Minimal deterministic reproduction of the 1-wei gap described above:
    // 2 mints of different sizes to 2 different actors, then actor1 sells their
    // entire YES balance to actor0 on the CLOB, then a warp+accrual. At that
    // point actor0 holds ALL the YES (one term) while the NO supply from both
    // mints is still split across actor0 and actor1 (two terms) -- summing two
    // independent floor divisions on the NO side undershoots a single floor
    // division of the combined total by exactly 1 wei here. The ACTUAL
    // usdc.balanceOf(market) is exactly right (== YES.totalSupply(), since no
    // cash has moved from either mint); only the "reconstruct expected balance
    // from live per-user projections" measurement has the 1-wei artifact, which
    // is exactly why invariant_CollateralSolvencyPreEvent tolerates 2*N_ACTORS
    // wei instead of asserting bit-exact equality.
    function test_Repro_SolvencyFormulaOneWeiRoundingSlack() public {
        address actor0 = handler.actorAt(0);
        address actor1 = handler.actorAt(1);

        uint256 mintAmount0 = 4999999999999995000;
        uint256 mintAmount1 = 24125071490131303;
        handler.mint(0, mintAmount0);
        handler.mint(1, mintAmount1);

        // actor1 sells its entire YES balance to actor0 (mirrors the fuzz-found
        // clobTrade: side=YES, seller=actor1 (taker), buyer=actor0 (maker)).
        handler.clobTrade(
            0, // makerSeed => actor0 (buyer)
            1, // takerSeed => actor1 (seller)
            0, // sideSeed even => YES
            1, // sellerIsMakerSeed odd => makerIsSeller=false (maker is the buyer)
            mintAmount1, // sell actor1's entire YES balance
            5e17 // 50% price fraction
        );

        handler.warpAndAccrue(37680);

        uint256 cumYES = market.cumulativeFundingPerYES();
        uint256 actor0Yes = yesToken.balanceOf(actor0);
        uint256 actor0No = noToken.balanceOf(actor0);
        uint256 actor1No = noToken.balanceOf(actor1);

        // Naive "single combined floor" reconstruction (what a bit-exact formula
        // would need if balances weren't fragmented across actors) vs. the
        // per-actor floors the invariant actually computes:
        uint256 combinedNoCredit = (actor0No + actor1No) * cumYES / 1e18;
        uint256 perActorNoCredit = (actor0No * cumYES / 1e18) + (actor1No * cumYES / 1e18);

        assertEq(combinedNoCredit - perActorNoCredit, 1, "expected exactly the documented 1-wei rounding gap");

        uint256 actualBalance = usdc.balanceOf(address(market));
        uint256 yesDebit = actor0Yes * cumYES / 1e18; // actor0 holds ALL the YES (single term)
        uint256 exactExpected = yesToken.totalSupply() - yesDebit + perActorNoCredit;

        assertEq(actualBalance, yesToken.totalSupply(), "actual balance is exactly the mint total (no cash moved)");
        assertEq(actualBalance, exactExpected + 1, "the per-actor-floor projection undershoots actual by 1 wei");
    }

    // ── regression: F1 (frozen-YES / live-NO asymmetry) fixed ───────────────────
    //
    // Was test_Repro_FrozenYesLiveNoCreditLeak (KNOWN-VIOLATION), demonstrating a
    // real, permanent, uncollateralized collateral leak: CreditMarket.settleFunding's
    // claimable-branch priced a flagged holder's YES-side obligation at a value
    // CAPPED at flag time (frozenFunding), while any NO holder who synced during
    // the freeze window kept collecting credit off the LIVE, uncapped cumFundingPerNO.
    //
    // Post-fix, there is no claimable branch and no frozenFunding: settleFunding
    // always charges live accrual, for every user, flagged or not. Same scenario,
    // flipped assertion: the market must be FULLY backed (no leak) after alice's
    // cure, because her live owed() at cure time exactly matches what was already
    // paid out to bob (same live index, same balance size) -- there is no longer a
    // frozen/live asymmetry for a flagged window to leak through.
    struct ReproActors {
        address alice;
        uint256 aliceKey;
        address bob;
        uint256 bobKey;
        address carol;
        uint256 carolKey;
    }

    function _reproSetup() internal returns (ReproActors memory a) {
        (a.alice, a.aliceKey) = makeAddrAndKey("alice_repro");
        (a.bob, a.bobKey) = makeAddrAndKey("bob_repro");
        (a.carol, a.carolKey) = makeAddrAndKey("carol_repro");

        usdc.mint(a.alice, 10_000e18);
        usdc.mint(a.bob, 10_000e18);
        usdc.mint(a.carol, 10_000e18);

        vm.startPrank(a.alice);
        usdc.approve(address(market), type(uint256).max);
        usdc.approve(address(clob), type(uint256).max);
        yesToken.approve(address(clob), type(uint256).max);
        noToken.approve(address(clob), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(a.bob);
        usdc.approve(address(clob), type(uint256).max);
        yesToken.approve(address(clob), type(uint256).max);
        noToken.approve(address(clob), type(uint256).max);
        vm.stopPrank();
        vm.startPrank(a.carol);
        usdc.approve(address(clob), type(uint256).max);
        yesToken.approve(address(clob), type(uint256).max);
        noToken.approve(address(clob), type(uint256).max);
        vm.stopPrank();

        market.grantRole(market.KEEPER_ROLE(), address(this));
    }

    function _reproMintAndSplit(ReproActors memory a) internal {
        vm.prank(a.alice);
        market.mint(1_000e18);

        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory aOrder = CLOBSettlement.Order({
            maker: a.alice,
            tokenIn: address(noToken),
            tokenOut: address(usdc),
            amountIn: 1_000e18,
            minAmountOut: 1_000e18,
            expiry: expiry,
            nonce: 0
        });
        CLOBSettlement.Order memory bOrder = CLOBSettlement.Order({
            maker: a.bob,
            tokenIn: address(usdc),
            tokenOut: address(noToken),
            amountIn: 1_000e18,
            minAmountOut: 1_000e18,
            expiry: expiry,
            nonce: 0
        });
        clob.verifyAndSettle(aOrder, _sign(a.aliceKey, aOrder), bOrder, _sign(a.bobKey, bOrder));
    }

    function _reproBobTriggeredSync(ReproActors memory a) internal returns (uint256 bobPayout, uint256 marketOutflow) {
        uint256 marketBalanceBefore = usdc.balanceOf(address(market));
        uint256 bobUsdcBefore = usdc.balanceOf(a.bob);

        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory bSell = CLOBSettlement.Order({
            maker: a.bob,
            tokenIn: address(noToken),
            tokenOut: address(usdc),
            amountIn: 1e18, // trivial size -- funding nets over bob's FULL balance regardless
            minAmountOut: 0,
            expiry: expiry,
            nonce: 1
        });
        CLOBSettlement.Order memory cBuy = CLOBSettlement.Order({
            maker: a.carol,
            tokenIn: address(usdc),
            tokenOut: address(noToken),
            amountIn: 1e18,
            minAmountOut: 1e18,
            expiry: expiry,
            nonce: 0
        });
        clob.verifyAndSettle(bSell, _sign(a.bobKey, bSell), cBuy, _sign(a.carolKey, cBuy));

        bobPayout = usdc.balanceOf(a.bob) - bobUsdcBefore;
        marketOutflow = marketBalanceBefore - usdc.balanceOf(address(market));
    }

    function test_Regression_NoFreezeNoCollateralLeak() public {
        ReproActors memory a = _reproSetup();

        // 1. Alice mints $1000, sells all NO to Bob -> alice pure YES, bob pure NO.
        _reproMintAndSplit(a);

        // 2. Warp 354 days (the CLAUDE.md worked example) so alice is seizable
        //    at the 5% initial mark, then flag her -- post-fix this is a pure
        //    LOCK, not an accounting freeze.
        vm.warp(block.timestamp + 354 days);
        market.accrueFunding();
        assertTrue(market.isSeizable(a.alice), "alice should be seizable after 354 days at 5% mark");
        market.flagClaimable(a.alice);

        // 3. MORE time passes while alice sits flagged (unclaimed/uncured) --
        //    her funding keeps accruing LIVE (no freeze), in lockstep with the
        //    paired NO side's live credit.
        vm.warp(block.timestamp + 30 days);
        market.accrueFunding();

        // 4. Bob (holds his original 1000 NO) triggers his own settleFunding via
        //    a trivial CLOB sale to Carol -- pays his full LIVE NO credit from
        //    collateral (nets his funding over his FULL NO balance).
        _reproBobTriggeredSync(a);

        // 5. Alice cures -- pays her full LIVE owed() (fundingDebt + accrual
        //    since her last sync, uncapped), exactly matching what was already
        //    paid out to Bob at the same live index, same balance size.
        vm.prank(a.alice);
        market.cure();

        // The market must be FULLY backed again -- no permanent leak survives
        // the fix: every outstanding YES+NO pair can still redeem at $1. (Small
        // dust tolerance from the trivial 1e18 trade's own funding leg, same as
        // the original repro's tolerance.)
        assertApproxEqAbs(
            usdc.balanceOf(address(market)),
            yesToken.totalSupply(),
            2,
            "post-cure collateral must be fully backed -- the F1 freeze/live asymmetry no longer exists"
        );
    }

    // ── regression: F4 (trade resets the seizure clock) fixed ──────────────────
    //
    // Was test_Repro_F4_TradeResetsSeizureClockWhileDebtGrows (KNOWN-VIOLATION):
    // isSeizable() measured f_now as cumulativeFundingPerYES - fundingSnapshot[user]
    // only, never reading fundingDebt. Every CLOB trade runs settleFunding on both
    // parties, and for a buyer that moves the accrued YES debit into fundingDebt
    // and resets the snapshot -- so a YES holder could reset their liquidation
    // clock with a tiny purchase every < ~353 days while real debt grew in a
    // ledger the trigger ignored, ending up owing far more than the position was
    // worth yet remaining permanently unflaggable.
    //
    // Post-fix, isSeizable() reads owed() (fundingDebt included), so the same
    // repeated-tiny-buy trick can no longer hide debt from the trigger: this test
    // performs the identical pattern and asserts the position becomes seizable
    // once owed() crosses the spec threshold, flagClaimable() succeeds, and the
    // debt at that point never blew past the position's value (allowing the
    // trigger's own one-epoch look-ahead plus this test's 1-day step granularity).
    function _reproAliceBuysOneNoFromBob(ReproActors memory a, uint256 nonce) internal {
        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory bSell = CLOBSettlement.Order({
            maker: a.bob,
            tokenIn: address(noToken),
            tokenOut: address(usdc),
            amountIn: 1e18,
            minAmountOut: 0,
            expiry: expiry,
            nonce: nonce
        });
        CLOBSettlement.Order memory aBuy = CLOBSettlement.Order({
            maker: a.alice,
            tokenIn: address(usdc),
            tokenOut: address(noToken),
            amountIn: 1e18,
            minAmountOut: 1e18,
            expiry: expiry,
            nonce: nonce
        });
        clob.verifyAndSettle(bSell, _sign(a.bobKey, bSell), aBuy, _sign(a.aliceKey, aBuy));
    }

    function test_Regression_F4_TradeResetsSeizureClockWhileDebtGrows() public {
        ReproActors memory a = _reproSetup();
        _reproMintAndSplit(a); // alice: 1000 YES, bob: 1000 NO

        uint256 m = market.currentMark();
        uint256 yesBal = yesToken.balanceOf(a.alice);
        uint256 positionValue = yesBal * m / 1e18;

        // Step in 1-day increments (== epochLength) so the boundary crossing is
        // caught tightly, with alice doing the tiny F4 buy from bob every 60 days
        // (well inside the ~353-day natural trigger window on its own -- only the
        // ACCUMULATED ledger debt across repeated resets should ever trip it).
        uint256 nonce = 10;
        bool becameSeizable;
        for (uint256 i = 0; i < 500 && !becameSeizable; i++) {
            vm.warp(block.timestamp + 1 days);
            market.accrueFunding();

            if (i % 60 == 59) {
                _reproAliceBuysOneNoFromBob(a, nonce++);
            }

            if (market.isSeizable(a.alice)) {
                becameSeizable = true;
            }
        }

        assertTrue(becameSeizable, "sanity: alice's position must eventually cross the seizure threshold");

        uint256 debtAtTrigger = market.owed(a.alice);

        // The core F4 regression: flagClaimable must SUCCEED once isSeizable is
        // true, regardless of how many snapshot resets happened along the way --
        // the ledger debt is no longer invisible to the trigger.
        market.flagClaimable(a.alice);
        assertTrue(market.claimable(a.alice), "alice must be flaggable once owed() crosses the spec threshold");

        // And debt must not have blown past the position's value by the time it's
        // flagged -- not the pre-fix behaviour, where debt reached ~2.5x position
        // value with isSeizable() permanently false. Allow slack for the
        // trigger's own one-epoch look-ahead plus this test's 1-day step
        // granularity (two epochs' worth of accrual, generously).
        uint256 oneEpochAccrual = yesBal * (m * 1 days / 365 days) / 1e18;
        assertLe(
            debtAtTrigger,
            positionValue + 2 * oneEpochAccrual + 1,
            "debt must not exceed position value (beyond the one-epoch look-ahead) by the time it's flagged"
        );

        // Bob (the paired NO side) was paid legitimate LIVE credit throughout,
        // matched step-for-step by alice's growing ledger debt via owed() -- not
        // an unbacked IOU exceeding her position's worth (the pre-fix bug's
        // impact). Aggregate solvency itself is covered continuously by
        // invariant_CollateralSolvencyPreEvent in the fuzz campaign.
    }

    // ── regression: F2 (liquidator's own NO credit forfeited on claim) fixed ───
    //
    // Pre-fix, clearLiquidatedPosition routed the liquidator through
    // `_syncUserFunding`, which folded their YES debit into fundingDebt but reset
    // `snapNO[liquidator]` WITHOUT ever paying out any NO credit they had
    // accrued — silently forfeiting it (the cash stayed in collateral, so this
    // was never a solvency risk, just a liquidator shortchanged). Post-fix,
    // clearLiquidatedPosition routes the liquidator through the same
    // `settleFunding` every other settlement path uses, so a pending NO credit
    // is paid out in cash exactly like anywhere else.
    //
    // Reuses the F1/F4 repro's own setup: alice mints and sells her NO to bob,
    // so bob holds a large, genuinely UNSYNCED NO credit (he never trades again)
    // in parallel with alice's YES position becoming seizable — bob then claims
    // alice's own flagged position as the liquidator.
    function test_Regression_F2_LiquidatorNoCreditPaid() public {
        ReproActors memory a = _reproSetup();
        _reproMintAndSplit(a); // alice: 1000 YES, bob: 1000 NO

        vm.prank(a.bob);
        usdc.approve(address(liquidationEngine), type(uint256).max);

        // Warp so alice is seizable; bob's paired NO accrues a large, entirely
        // unsynced credit alongside it (he performs no other action here).
        vm.warp(block.timestamp + 354 days);
        market.accrueFunding();
        assertTrue(market.isSeizable(a.alice), "alice should be seizable after 354 days at 5% mark");
        market.flagClaimable(a.alice);

        uint256 bobNoBal = noToken.balanceOf(a.bob);
        uint256 cumNO = market.cumFundingPerNO();
        uint256 expectedBobCredit = bobNoBal * (cumNO - market.snapNO(a.bob)) / 1e18;
        assertGt(expectedBobCredit, 0, "sanity: bob must have real unsynced NO credit going into the claim");

        uint256 Q = yesToken.balanceOf(a.alice);
        uint256 m = market.currentMark();
        uint256 owedTotal = market.owed(a.alice);
        uint256 tokenValue = Q * m / 1e18;
        uint256 P = owedTotal > tokenValue ? tokenValue : owedTotal;

        uint256 bobUsdcBefore = usdc.balanceOf(a.bob);

        // Bob (the liquidator) holds zero YES, so clearLiquidatedPosition's
        // settleFunding(bob) call is a pure credit: it must pay expectedBobCredit
        // in cash, net of the P he pays in as the claim price.
        vm.prank(a.bob);
        liquidationEngine.claim(a.alice);

        int256 actualDelta = int256(usdc.balanceOf(a.bob)) - int256(bobUsdcBefore);
        int256 expectedDelta = int256(expectedBobCredit) - int256(P);
        assertEq(
            actualDelta,
            expectedDelta,
            "bob's pending NO credit must be paid out as part of the claim, not silently forfeited (F2 regression)"
        );
    }

    function _sign(uint256 key, CLOBSettlement.Order memory order) internal view returns (bytes memory) {
        bytes32 digest = clob.hashOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // ── reporting ─────────────────────────────────────────────────────────────

    function afterInvariant() public view {
        console2.log("=== Handler call summary ===");
        console2.log(handler.callSummary());
        console2.log("normalCaseClaims", handler.ghost_normalCaseClaims());
        console2.log("tailCaseClaims", handler.ghost_tailCaseClaims());
        console2.log("yesMinted", handler.ghost_yesMinted());
        console2.log("yesBurnedTotal", handler.ghost_yesBurnedTotal());
        console2.log("noBurnedTotal", handler.ghost_noBurnedTotal());
    }
}
