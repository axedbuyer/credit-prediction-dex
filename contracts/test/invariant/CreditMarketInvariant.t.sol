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
/// ("fundingDebt/frozenFunding ledger correctness across all settlement paths...
/// this remains squarely a testing/fuzzing/formal-methods concern").
///
/// ── The flagship invariant: Collateral Solvency (invariant_CollateralSolvencyPreEvent) ──
///
/// Derivation (see comments on the function itself for the line-by-line proof):
/// at any point before a credit event is confirmed,
///
///   usdc.balanceOf(market)
///     == YES.totalSupply()                                    (full $1-per-pair backing)
///      - Σ_u fundingDebt[u]                                    (uncollected YES-side debt)
///      - Σ_{u flagged}   frozenFunding[u] * YES.balanceOf(u) / 1e18   (frozen, uncollected)
///      - Σ_{u unflagged} YES.balanceOf(u) * (cumYES - fundingSnapshot[u]) / 1e18  (live accrual, uncollected)
///      + Σ_u NO.balanceOf(u) * (cumNO - snapNO[u]) / 1e18       (live NO credit, unpaid)
///
/// This is an EXACT equality (not a bound) because every term is computed with the
/// same floor-division the contract itself uses internally, and because
/// YES.totalSupply() == NO.totalSupply() always pre-event (complete-set). It
/// directly encodes CLAUDE.md invariants 4 (NO always made whole), 7 (every
/// settlement path nets funding through the same ledger), and 9 (a funding debit
/// is never erased without equivalent USDC reaching collateral) — if any code path
/// ever paid out a NO credit, or forgave a YES debit, or mis-collected a
/// liquidation payment, without the corresponding cash actually landing in (or
/// staying in) `market`, this equality breaks immediately.
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

        // ── deploy handler, then grant it the privileged roles it drives ───────
        handler = new Handler(usdc, yesToken, noToken, market, clob, router, insuranceFund, liquidationEngine, teamWallet);

        market.grantRole(market.KEEPER_ROLE(), address(handler));
        market.grantRole(market.ORACLE_ROLE(), address(handler)); // setMotionPending
        router.grantRole(router.ORACLE_ROLE(), address(handler)); // confirmCreditEvent
        clob.grantRole(clob.DEFAULT_ADMIN_ROLE(), address(handler)); // toggleFee

        // Trading fee live from the start (50 bps, 50/50) per root CLAUDE.md —
        // "set a nonzero fee config in setUp" — handler's toggleFee action then
        // flips it to 0 and back over the course of a run, exercising both the
        // fee and fee-free code paths.
        clob.setFeeConfig(50, teamWallet, address(insuranceFund), 5_000);

        lastCumYES = market.cumulativeFundingPerYES();

        targetContract(address(handler));

        bytes4[] memory selectors = new bytes4[](16);
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

    // KNOWN-VIOLATION (compensated, not skipped): CreditMarket.settleFunding's
    // claimable-branch (see CreditMarket.sol ~L368-378) prices a FLAGGED
    // holder's YES-side obligation at a value CAPPED at flag time
    // (frozenFunding), while ANY NO holder who next syncs (a CLOB sale, redeem,
    // settleYES) still collects credit off the LIVE, uncapped
    // `cumFundingPerNO` -- which keeps climbing globally at the full
    // mark-implied rate regardless of the freeze. This is a real, PERMANENT
    // (never later collected from anyone), uncollateralized collateral leak,
    // proportional to mark x (time the position sits flagged before
    // cure/claim) x (the frozen holder's balance) -- proven with a minimal,
    // deterministic, two-actor repro in test_Repro_FrozenYesLiveNoCreditLeak
    // (this file), which shows the market can no longer fully back every
    // outstanding YES+NO pair at $1 even AFTER the frozen holder pays their
    // entire (capped) bill via cure(). This breaks invariant 4 ("NO holders
    // are ALWAYS made whole") and invariant 9 ("a funding debit is never
    // erased without equivalent USDC landing in collateral") -- here it's a
    // funding CREDIT paid out of collateral with no matching debit ever
    // collected. NOT fixed here (contracts/src is off limits for this task).
    //
    // Rather than going silent for the rest of a campaign the first time any
    // position is ever flagged (which would blind this invariant to every
    // OTHER bug for the remainder of the run -- e.g. it originally hid a
    // planted debt-forgiveness mutation in redeem() during mutation testing),
    // the KNOWN leak is instead precisely QUANTIFIED and added back to the
    // expected side of the equation, leaving the formula fully sensitive to
    // any OTHER deviation:
    //   - for a position CURRENTLY still flagged, the outstanding leak is a
    //     pure function of live state: yesBal(u) * (cumFundingPerNO_now -
    //     frozenFunding(u)) / 1e18 (recomputed fresh every check, needs no
    //     ghost -- both frozenFunding(u) and yesBal(u) stay pinned while
    //     flagged).
    //   - once a flagged position RESOLVES (cure/settleYES/liquidation
    //     claim), the (by-then realized, permanent) leak amount is captured
    //     by the Handler at that moment (Handler.ghost_lockedLeak, computed
    //     from pre-call state -- see Handler.sol's `_pendingLeak`) and added
    //     here forever after, since the position's own live-state terms
    //     revert to normal post-resolution and would otherwise "forget" it.
    function invariant_CollateralSolvencyPreEvent() public view {
        if (market.creditEventConfirmed()) return;

        uint256 cumYES = market.cumulativeFundingPerYES();
        uint256 cumNO = market.cumFundingPerNO();

        int256 sumFundingDebt;
        int256 sumUnsyncedYesDebit;
        int256 sumUnsyncedNoCredit;
        int256 sumKnownLeak;
        int256 sumForfeitedNoCredit;

        uint256 n = handler.numActors();
        for (uint256 i = 0; i < n; i++) {
            address u = handler.actorAt(i);

            sumFundingDebt += int256(market.fundingDebt(u));
            // KNOWN-VIOLATION #2: see Handler.ghost_forfeitedNoCredit's comment --
            // clearLiquidatedPosition's liquidator-sync step silently forfeits
            // (never pays) any NO credit the liquidator had accrued before a
            // stale snapNO. That cash never leaves collateral, so it must be
            // added back here or this invariant would (wrongly) expect a lower
            // balance than the market actually, correctly, holds.
            sumForfeitedNoCredit += int256(handler.ghost_forfeitedNoCredit(u));

            uint256 yesBal = yesToken.balanceOf(u);
            if (market.claimable(u)) {
                uint256 frozen = market.frozenFunding(u);
                sumUnsyncedYesDebit += int256(frozen * yesBal / 1e18);
                // frozen is a DELTA since u's own pre-flag fundingSnapshot (left
                // untouched while claimable), NOT the absolute cumYES index at
                // flag time -- reconstruct that index as frozen + fundingSnapshot(u)
                // before comparing to the current absolute cumNO. See
                // Handler._pendingLeak's comment for the full explanation of why
                // using `frozen` alone here overstates the leak.
                uint256 cumYESAtFlag = frozen + market.fundingSnapshot(u);
                if (cumNO > cumYESAtFlag) {
                    sumKnownLeak += int256(yesBal * (cumNO - cumYESAtFlag) / 1e18); // still-open leak
                }
            } else {
                uint256 fPerUnit = cumYES - market.fundingSnapshot(u);
                sumUnsyncedYesDebit += int256(yesBal * fPerUnit / 1e18);
            }
            sumKnownLeak += int256(handler.ghost_lockedLeak(u)); // permanently-realized leak

            uint256 noBal = noToken.balanceOf(u);
            uint256 nPerUnit = cumNO - market.snapNO(u);
            sumUnsyncedNoCredit += int256(noBal * nPerUnit / 1e18);
        }

        int256 expected = int256(yesToken.totalSupply()) - sumFundingDebt - sumUnsyncedYesDebit
            + sumUnsyncedNoCredit - sumKnownLeak + sumForfeitedNoCredit;

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

    function invariant_FrozenFundingImmutableWhileFlagged() public view {
        assertEq(
            handler.ghost_frozenFundingChangedWhileFlagged(),
            0,
            "frozenFunding[user] changed for a user who remained flagged/claimable across an action"
        );
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
            "fundingDebt/frozenFunding for the original holder were not both zero immediately after claim()"
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

    // Recomputes isSeizable(user) independently from public state, using exactly
    // the spec formula (m <= 1.03 * f_next, f_next = f_now + one epoch of accrual)
    // with NO reference to costBasis anywhere -- costBasis is not even read here,
    // which is itself part of what's being asserted: the trigger cannot depend on
    // it if an independent, cost-basis-free reimplementation always agrees with
    // the contract's own isSeizable().
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
                uint256 fNow = cumYES - market.fundingSnapshot(u);
                uint256 deltaF = m * epochLength / 365 days;
                uint256 fNext = fNow + deltaF;
                expected = m <= (fNext * 103) / 100;
            }

            assertEq(
                market.isSeizable(u),
                expected,
                "isSeizable() diverged from an independent, cost-basis-free reimplementation of the spec formula"
            );
        }
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

    // ── KNOWN-VIOLATION: frozen-YES / live-NO asymmetry leaks collateral ────────
    //
    // Minimal, deterministic, standalone repro (independent of Handler/fuzzing)
    // of a genuine invariant-4/9 violation discovered via the fuzzer above
    // (invariant_CollateralSolvencyPreEvent, sequence: mint -> two large warps ->
    // flagClaimable -> another warp -> check). See the top-of-contract comment
    // and the report for the full writeup; this test isolates the mechanism with
    // two independent actors (no shared wallet) to show it's a systemic pricing
    // asymmetry, not merely a self-dealing curiosity.
    //
    // Root cause: CreditMarket.settleFunding's claimable-branch (CreditMarket.sol
    // ~L368-378) prices the YES side at the FROZEN value (frozenFunding[user],
    // fixed at flag time) but ALWAYS prices the NO side off the LIVE
    // `cumFundingPerNO - snapNO[user]`, uncapped, regardless of whether the
    // *matching* YES supply for that NO is currently frozen. Once ANY YES
    // position is flagged, the global `cumulativeFundingPerYES`/`cumFundingPerNO`
    // indices keep climbing at the full mark-implied rate (accrual is global,
    // per-unit, and does not exempt frozen balances) — so every NO holder's
    // *live* credit keeps growing through the freeze window as if the frozen
    // holder's YES were still paying in full, while that holder's ACTUAL
    // obligation is capped at the frozen snapshot. The gap (mark * frozen-window
    // length * frozen holder's balance, roughly) is paid out of collateral to
    // whichever NO holder next syncs, funded by nothing — not the frozen
    // holder (whose bill stopped growing) and not InsuranceFund (which only
    // ever tops up LiquidationEngine.claim's own P-formula shortfall, never this
    // path). It is realized as real cash the moment that NO holder's own
    // settleFunding runs (a CLOB sale, redeem, or settleYES) — cure()/settleYES()
    // on the FROZEN holder's own side never realize it (their own freeze exempts
    // them from paying it), so it is a pure, uncompensated leak.
    //
    // Impact: breaks invariant 4 ("NO holders are ALWAYS made whole") in the
    // general case — the leak comes out of the SAME collateral pool that must
    // still fully back every other outstanding YES/NO pair at $1, so if the
    // frozen position stays flagged for a while before cure()/claim(), the
    // payout to the syncing NO holder can leave the pool short of what later
    // redemptions need. It also breaks invariant 9 ("a funding debit is never
    // erased without equivalent USDC landing in collateral") from the other
    // direction: a funding CREDIT is being paid out of collateral that was never
    // matched by an equivalent debit collection. Severity scales with mark ×
    // (time a large YES position sits flagged before cure/claim) × (total NO
    // supply that syncs during the window) — plausibly small per-incident given
    // KEEPER_ROLE is expected to flag promptly, but it is a real, unbounded (in
    // principle) collateral drain with no code path that stops it, not a rounding
    // artifact.
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

    function test_Repro_FrozenYesLiveNoCreditLeak() public {
        ReproActors memory a = _reproSetup();

        // 1. Alice mints $1000, sells all NO to Bob -> alice pure YES, bob pure NO.
        _reproMintAndSplit(a);

        // 2. Warp 354 days (the CLAUDE.md worked example) so alice is seizable
        //    at the 5% initial mark, then flag her -- freezing her YES-side debt.
        vm.warp(block.timestamp + 354 days);
        market.accrueFunding();
        assertTrue(market.isSeizable(a.alice), "alice should be seizable after 354 days at 5% mark");
        market.flagClaimable(a.alice);
        uint256 frozenPerUnit = market.frozenFunding(a.alice);

        // 3. MORE time passes while alice sits flagged (unclaimed/uncured) --
        //    cumFundingPerNO keeps climbing globally; alice's frozen debt does not.
        vm.warp(block.timestamp + 30 days);
        market.accrueFunding();
        uint256 cumNOAfterFreeze = market.cumFundingPerNO();
        assertGt(cumNOAfterFreeze, frozenPerUnit, "global index advanced past the frozen snapshot");

        // 4. Bob (holds his original 1000 NO, snapNO==0 since the initial trade)
        //    triggers his own settleFunding via a trivial CLOB sale to Carol --
        //    this nets his funding over his FULL NO balance, using the LIVE index.
        //    This payout is a mix of (a) his LEGITIMATE pre-flag credit, which is
        //    merely FRONTED from base collateral ahead of alice's not-yet-collected
        //    frozen debt (fine -- restored the moment alice cures/gets claimed),
        //    and (b) the permanent, uncollateralized post-flag sliver. Isolate (b)
        //    by having alice cure IMMEDIATELY afterward: cure() pays in exactly her
        //    frozen obligation (frozenPerUnit * balance), which tops collateral
        //    back up for (a) in full -- whatever shortfall remains after that is
        //    purely (b), the permanent leak.
        _reproBobTriggeredSync(a);

        uint256 aliceMaxObligation = 1_000e18 * frozenPerUnit / 1e18;
        vm.prank(a.alice);
        market.cure(); // pays in exactly aliceMaxObligation; frozenFunding is capped there, no more

        uint256 fullPeriodCredit = 1_000e18 * cumNOAfterFreeze / 1e18;
        uint256 uncollateralizedLeak = fullPeriodCredit - aliceMaxObligation;
        assertGt(uncollateralizedLeak, 0, "sanity: the freeze window should create a real, permanent gap");

        // The market is now missing EXACTLY the permanent leak relative to full
        // backing for every outstanding YES+NO pair -- not fronted, not
        // recoverable from alice (her bill was capped at flag time), not covered
        // by InsuranceFund (that only ever tops up LiquidationEngine.claim's own
        // formula, never this path).
        uint256 shortfall = yesToken.totalSupply() - usdc.balanceOf(address(market));
        assertApproxEqAbs(
            shortfall,
            uncollateralizedLeak,
            2, // dust from the trivial 1e18 trade's own tiny funding leg
            "post-cure collateral shortfall == the frozen window's uncollateralized NO credit, permanently"
        );

        // Concretely: the market can no longer fully back every outstanding
        // YES+NO pair at $1 -- the base invariant this whole protocol rests on --
        // even though alice has ALREADY paid her entire (frozen-capped) bill.
        assertLt(
            usdc.balanceOf(address(market)),
            yesToken.totalSupply(),
            "market can no longer fully redeem all outstanding pairs, even after alice paid her full frozen bill"
        );
    }

    // ── F4 (docs/security/invariant-findings-2026-09-26.md) ─────────────────────
    //
    // isSeizable() measures f_now as cumulativeFundingPerYES - fundingSnapshot[user]
    // only; it never reads the fundingDebt ledger. But every CLOB trade runs
    // settleFunding on BOTH parties (CLOBSettlement.sol:250-251), and for a buyer
    // that moves the accrued YES debit into fundingDebt and resets the snapshot.
    // So a YES holder can reset their liquidation clock with a tiny purchase every
    // < ~353 days (at a constant mark) while their debt keeps growing in a ledger
    // the trigger ignores: the position ends up owing far more than it's worth,
    // yet can never be flagged or claimed.
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

    function test_Repro_F4_TradeResetsSeizureClockWhileDebtGrows() public {
        ReproActors memory a = _reproSetup();
        _reproMintAndSplit(a); // alice: 1000 YES, bob: 1000 NO

        uint256 m = market.currentMark();
        uint256 marketBefore = usdc.balanceOf(address(market));

        // Three 300-day stretches (each < the ~353-day trigger), with one tiny
        // NO purchase before each stretch ends. 900 days of carry in total.
        for (uint256 i = 0; i < 3; i++) {
            vm.warp(block.timestamp + 300 days);
            market.accrueFunding();
            assertFalse(market.isSeizable(a.alice), "not yet seizable within a 300-day stretch");
            _reproAliceBuysOneNoFromBob(a, 10 + i);
        }

        uint256 yesBal = yesToken.balanceOf(a.alice);
        uint256 positionValue = yesBal * m / 1e18;
        uint256 debt = market.fundingDebt(a.alice);

        // Alice now owes ~2.4x what her position is worth (900d at the mark vs
        // 1x the mark), and her equity m - f is deeply negative...
        assertGt(debt, 2 * positionValue, "debt far exceeds position value");

        // ...yet the trigger still reads f_now ~= 0 (snapshot just reset), so she
        // can't be flagged, so LiquidationEngine can never claim her.
        assertFalse(market.isSeizable(a.alice), "BUG: deeply insolvent position is not seizable");
        vm.expectRevert(CreditMarket.PositionNotSeizable.selector);
        market.flagClaimable(a.alice);

        // Meanwhile bob (the paired NO side) has been paid his accrued credit out of
        // collateral at every sync: collateral is down by roughly that amount,
        // backed only by alice's ledger IOU, which exceeds anything she could ever
        // realise by selling her YES (a sale must clear >= her debit, and her
        // whole position is worth `positionValue` < debt).
        uint256 marketOutflow = marketBefore - usdc.balanceOf(address(market));
        assertGt(marketOutflow, positionValue, "collateral already paid out more than the debtor's position is worth");
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
