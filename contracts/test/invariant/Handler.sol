// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {YESToken} from "../../src/YESToken.sol";
import {NOToken} from "../../src/NOToken.sol";
import {CreditMarket} from "../../src/CreditMarket.sol";
import {CLOBSettlement} from "../../src/CLOBSettlement.sol";
import {OracleRouter} from "../../src/OracleRouter.sol";
import {InsuranceFund} from "../../src/InsuranceFund.sol";
import {LiquidationEngine} from "../../src/LiquidationEngine.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @notice Drives the real deployed Pari/credit-prediction-dex system with bounded,
/// realistic actions over a small fixed actor set, for Foundry stateful invariant
/// testing. Every action is wrapped in try/catch so a legitimate revert (paused,
/// frozen, insufficient balance, slippage, funding shortfall, ...) is tallied and
/// skipped rather than aborting the run — `fail_on_revert` can stay false in
/// foundry.toml without hiding a genuine bug, because a genuine bug shows up as an
/// invariant violation (a ghost counter going non-zero, or a state-derived check
/// failing), not as a raw revert bubbling out of the handler.
///
/// Ghost counters double as ledger/ghost accounting AND as the mechanism for
/// checking "this action should never succeed" properties (invariants 3, 5, 10)
/// that can't be phrased as a pure function of on-chain state alone.
///
/// Post-fix (docs/security/invariant-findings-2026-09-26.md): `owed(user) =
/// fundingDebt + live accrual` is now the SINGLE funding obligation everywhere —
/// there is no more `frozenFunding`/accounting freeze, and a flag is a pure LOCK.
/// The old F1/F2 compensation ghosts (`ghost_lockedLeak`, `ghost_forfeitedNoCredit`)
/// are gone: the fixed contract has no leak left to compensate for, so the
/// collateral-solvency invariant must hold with NO compensation terms at all.
contract Handler is Test {
    // ── deployed system (owned by the invariant test contract) ──────────────────
    MockUSDC public usdc;
    YESToken public yesToken;
    NOToken public noToken;
    CreditMarket public market;
    CLOBSettlement public clob;
    OracleRouter public router;
    InsuranceFund public insuranceFund;
    LiquidationEngine public liquidationEngine;

    address public teamWallet;

    // ── actors ────────────────────────────────────────────────────────────────
    uint256 public constant N_ACTORS = 5;
    address[] public actors;
    mapping(address => uint256) internal keyOf;
    mapping(address => uint256) public nextNonce;

    // ── ghost accounting ─────────────────────────────────────────────────────
    // Reconciliation ghosts (invariant 3 — complete-set / no-burn-by-liquidation):
    // yesToken.totalSupply() must equal ghost_yesMinted - ghost_yesBurnedTotal, and
    // noToken.totalSupply() must equal ghost_yesMinted - ghost_noBurnedTotal, AT ALL
    // TIMES. Since liquidation (claim()) never calls burn on either token — it only
    // calls YESToken.forcedTransfer — these ghosts are never touched by the
    // liquidation path. If a future code change ever burned YES during a claim,
    // these two reconciliations would immediately diverge from actual totalSupply().
    uint256 public ghost_yesMinted;       // == noMinted always (mint() mints 1:1)
    uint256 public ghost_yesBurnedTotal;   // redeem() + settleYES()
    uint256 public ghost_noBurnedTotal;    // redeem() only (settleYES never burns NO)

    // Invariant 10 — flagged position fully locked: these must stay 0 forever.
    uint256 public ghost_frozenMintSuccesses;
    uint256 public ghost_frozenRedeemSuccesses;
    uint256 public ghost_frozenTradeSuccesses;
    // owed()-non-decreasing-while-flagged (the new invariant 10 freeze-semantics
    // check, post-fix: there is no accounting freeze, only a lock — funding keeps
    // accruing on a flagged position, so owed() must never DECREASE for an actor
    // who remains flagged/claimable across an action; it can only grow, or stay put
    // if no time elapsed).
    uint256 public ghost_owedDecreasedWhileFlagged;

    // Invariant 5 — nothing seizes/claims during a pending credit-event motion.
    uint256 public ghost_motionPendingFlagSuccesses;
    uint256 public ghost_motionPendingClaimSuccesses;

    // F4-type direct probe (docs/security/invariant-findings-2026-09-26.md,
    // "Recommended fix" + "Next"): whenever an actor's owed() + one epoch of
    // projected accrual crosses the spec's seizure threshold (value*100 <=
    // (owed+nextEpoch)*103) and motionPending is false, flagClaimable MUST
    // succeed for that actor — no actor may be "unflaggable" while insolvent per
    // the spec. probeMissedSeizureFlag (below) independently recomputes that
    // condition (NOT by calling market.isSeizable() — that would make this probe
    // circular and blind to a mutation inside isSeizable itself, e.g. one that
    // drops the fundingDebt term back out) and attempts the flag; any revert
    // increments this ghost, which the invariant asserts stays 0.
    uint256 public ghost_missedSeizureFlag;

    // Liquidation ledger must be fully cleared (fundingDebt==0) for the original
    // holder immediately after every successful claim(). (frozenFunding no longer
    // exists post-fix — clearLiquidatedPosition only ever has fundingDebt left to
    // clear for the original holder.)
    uint256 public ghost_liquidationLedgerNotCleared;
    uint256 public ghost_normalCaseClaims;
    uint256 public ghost_tailCaseClaims;

    // Per-action ghost checks (invariant 9, decoupled from the aggregate
    // solvency formula): the USDC a user actually receives from redeem()/
    // settleYES() must equal `amount +/- the funding delta settleFunding would
    // compute for them`, independently reprojected here from public state
    // right before the call. Any deviation (e.g. a debt that gets forgiven
    // instead of deducted) increments these and must stay 0.
    uint256 public ghost_redeemPayoutMismatch;
    uint256 public ghost_settleYESPayoutMismatch;

    // a9476ea launch guard-rails (depositCap, bounded setMark/adminSetMark):
    // these three must stay 0 forever, exactly like the frozen-lock ghosts above.
    uint256 public ghost_mintExceededCap;          // a mint() succeeded that pushed
                                                    // YES.totalSupply() past depositCap
    uint256 public ghost_keeperStepViolation;      // a KEEPER_ROLE setMark() succeeded
                                                    // with |delta| > maxMarkStep
    uint256 public ghost_keeperIntervalViolation;  // a KEEPER_ROLE setMark() succeeded
                                                    // sooner than minMarkInterval after
                                                    // the previous mark update

    // ── call tallies (for the report) ────────────────────────────────────────
    string[] public actionNames;
    mapping(string => bool) internal _seenAction;
    mapping(string => uint256) public callCounts;
    mapping(string => uint256) public successCounts;
    mapping(string => uint256) public revertCounts;

    constructor(
        MockUSDC _usdc,
        YESToken _yesToken,
        NOToken _noToken,
        CreditMarket _market,
        CLOBSettlement _clob,
        OracleRouter _router,
        InsuranceFund _insuranceFund,
        LiquidationEngine _liquidationEngine,
        address _teamWallet
    ) {
        usdc = _usdc;
        yesToken = _yesToken;
        noToken = _noToken;
        market = _market;
        clob = _clob;
        router = _router;
        insuranceFund = _insuranceFund;
        liquidationEngine = _liquidationEngine;
        teamWallet = _teamWallet;

        uint256[N_ACTORS] memory keys =
            [uint256(0xA11CE1), uint256(0xA11CE2), uint256(0xA11CE3), uint256(0xA11CE4), uint256(0xA11CE5)];

        for (uint256 i = 0; i < N_ACTORS; i++) {
            address a = vm.addr(keys[i]);
            actors.push(a);
            keyOf[a] = keys[i];

            usdc.mint(a, 10_000_000e18);

            vm.startPrank(a);
            usdc.approve(address(market), type(uint256).max);
            usdc.approve(address(clob), type(uint256).max);
            usdc.approve(address(liquidationEngine), type(uint256).max);
            yesToken.approve(address(clob), type(uint256).max);
            noToken.approve(address(clob), type(uint256).max);
            vm.stopPrank();
        }

        // Pre-fund InsuranceFund generously so tail-case claims (owed > tokenValue)
        // can actually be exercised rather than reverting for lack of reserve every time.
        usdc.mint(address(insuranceFund), 10_000_000e18);
    }

    function numActors() external view returns (uint256) {
        return actors.length;
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    // ── internal helpers ─────────────────────────────────────────────────────

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % N_ACTORS];
    }

    function _record(string memory name, bool ok) internal {
        if (!_seenAction[name]) {
            _seenAction[name] = true;
            actionNames.push(name);
        }
        callCounts[name]++;
        if (ok) successCounts[name]++;
        else revertCounts[name]++;
    }

    // Independently reprojects the signed delta CreditMarket.settleFunding(user)
    // would compute RIGHT NOW, from public state only -- mirrors the contract's
    // own math exactly (including folding in any pre-existing fundingDebt[user]
    // ledger entry, and the elapsed-but-not-yet-accrued time projection, since
    // settleFunding's first action is always _accrueFunding()). Post-fix there is
    // no more claimable/frozen branch -- settleFunding always charges live, for
    // every user, flagged or not (flagged users just can't reach it except via
    // cure()/settleYES()).
    function _projectSettleDelta(address user) internal view returns (int256 delta) {
        uint256 yesBal = yesToken.balanceOf(user);
        uint256 noBal = noToken.balanceOf(user);

        uint256 mark = market.currentMark();
        uint256 elapsed = block.timestamp - market.lastFundingTime();
        uint256 projectedCum = market.cumulativeFundingPerYES() + mark * elapsed / 365 days;

        uint256 yesOwed = yesBal * (projectedCum - market.fundingSnapshot(user)) / 1e18;
        uint256 noCredit = noBal * (projectedCum - market.snapNO(user)) / 1e18;
        uint256 debit = market.fundingDebt(user) + yesOwed;

        delta = noCredit >= debit ? int256(noCredit - debit) : -int256(debit - noCredit);
    }

    function _sign(uint256 key, CLOBSettlement.Order memory order) internal view returns (bytes memory) {
        bytes32 digest = clob.hashOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // Snapshots owed() for every currently-flagged actor before the wrapped
    // action, and afterwards asserts (via ghost counter, not a hard revert — the
    // invariant test reads the counter) that any actor STILL flagged after the
    // action has a NON-DECREASING owed() value. Post-fix there is no accounting
    // freeze: a flagged position's YES balance can't change (mint/redeem/trade all
    // revert PositionFrozen while locked — invariant 10) and its funding keeps
    // accruing live off the global, monotonic index, so owed() for an actor who
    // remains flagged across any action can only grow (or hold steady if no time
    // elapsed) — it must never fall.
    modifier trackFlagged() {
        uint256 n = actors.length;
        uint256[] memory snap = new uint256[](n);
        bool[] memory wasFlagged = new bool[](n);
        for (uint256 i = 0; i < n; i++) {
            wasFlagged[i] = market.claimable(actors[i]);
            snap[i] = wasFlagged[i] ? market.owed(actors[i]) : 0;
        }
        _;
        for (uint256 i = 0; i < n; i++) {
            if (wasFlagged[i] && market.claimable(actors[i])) {
                if (market.owed(actors[i]) < snap[i]) {
                    ghost_owedDecreasedWhileFlagged++;
                }
            }
        }
    }

    // ── actions (invariant targets) ──────────────────────────────────────────

    function mint(uint256 actorSeed, uint256 amountSeed) external trackFlagged {
        address a = _actor(actorSeed);
        uint256 amount = bound(amountSeed, 1e15, 2_000e18);
        bool flagged = market.claimable(a);
        uint256 supplyBefore = yesToken.totalSupply();
        uint256 capNow = market.depositCap();

        vm.prank(a);
        try market.mint(amount) {
            ghost_yesMinted += amount;
            if (flagged) ghost_frozenMintSuccesses++;
            if (supplyBefore + amount > capNow) ghost_mintExceededCap++;
            _record("mint", true);
        } catch {
            _record("mint", false);
        }
    }

    function redeem(uint256 actorSeed, uint256 amountSeed) external trackFlagged {
        address a = _actor(actorSeed);
        uint256 yesBal = yesToken.balanceOf(a);
        uint256 noBal = noToken.balanceOf(a);
        uint256 maxAmt = yesBal < noBal ? yesBal : noBal;
        if (maxAmt == 0) {
            _record("redeem", false);
            return;
        }
        uint256 amount = bound(amountSeed, 1, maxAmt);
        bool flagged = market.claimable(a);
        int256 expectedDelta = flagged ? int256(0) : _projectSettleDelta(a);
        uint256 usdcBefore = usdc.balanceOf(a);

        vm.prank(a);
        try market.redeem(amount) {
            ghost_yesBurnedTotal += amount;
            ghost_noBurnedTotal += amount;
            if (flagged) ghost_frozenRedeemSuccesses++;
            else if (_payoutMismatch(a, usdcBefore, amount, expectedDelta)) ghost_redeemPayoutMismatch++;
            _record("redeem", true);
        } catch {
            _record("redeem", false);
        }
    }

    // Shared invariant-9 payout check for redeem()/settleYES(): the USDC the
    // user actually receives across the whole call must equal
    // `amount + expectedDelta` (a positive delta is paid inside settleFunding
    // itself; a negative one is deducted from the principal payout) -- exactly
    // reconstructing the contract's own accounting from outside it. Any
    // deviation (e.g. a debt silently forgiven instead of deducted) is a real
    // bug, independent of the aggregate solvency formula's own timing/scope.
    function _payoutMismatch(address user, uint256 usdcBefore, uint256 amount, int256 expectedDelta)
        internal
        view
        returns (bool)
    {
        uint256 actualPaidOut = usdc.balanceOf(user) - usdcBefore;
        int256 expectedTotal = int256(amount) + expectedDelta;
        if (expectedTotal < 0) return true; // the honest contract would have reverted (underflow) here
        return actualPaidOut != uint256(expectedTotal);
    }

    function settleYES(uint256 actorSeed, uint256 amountSeed) external trackFlagged {
        address a = _actor(actorSeed);
        uint256 yesBal = yesToken.balanceOf(a);
        if (yesBal == 0) {
            _record("settleYES", false);
            return;
        }
        uint256 amount = bound(amountSeed, 1, yesBal);
        int256 expectedDelta = _projectSettleDelta(a);
        uint256 usdcBefore = usdc.balanceOf(a);

        vm.prank(a);
        try market.settleYES(amount) {
            ghost_yesBurnedTotal += amount;
            if (_payoutMismatch(a, usdcBefore, amount, expectedDelta)) ghost_settleYESPayoutMismatch++;
            _record("settleYES", true);
        } catch {
            _record("settleYES", false);
        }
    }

    // Trade context hoisted into a struct (mirrors CLOBSettlement's own TradeCtx
    // pattern) to keep clobTrade's own stack frame shallow enough for solc 0.8.24.
    struct TradeVars {
        address seller;
        address buyer;
        address token;
        bool isYes;
        bool makerIsSeller;
        uint256 amount;
        uint256 tradePrice;
        uint256 sellerMinOut;
    }

    function clobTrade(
        uint256 makerSeed,
        uint256 takerSeed,
        uint256 sideSeed,
        uint256 sellerIsMakerSeed,
        uint256 amountSeed,
        uint256 priceFracSeed
    ) external trackFlagged {
        TradeVars memory t;
        {
            address makerAddr = _actor(makerSeed);
            address takerAddr = _actor(takerSeed);
            if (makerAddr == takerAddr) takerAddr = _actor(takerSeed + 1);
            if (makerAddr == takerAddr) {
                _record("clobTrade", false);
                return;
            }
            t.isYes = sideSeed % 2 == 0;
            t.makerIsSeller = sellerIsMakerSeed % 2 == 0;
            t.seller = t.makerIsSeller ? makerAddr : takerAddr;
            t.buyer = t.makerIsSeller ? takerAddr : makerAddr;
            t.token = t.isYes ? address(yesToken) : address(noToken);
        }

        uint256 sellerBal = ERC20(t.token).balanceOf(t.seller);
        if (sellerBal == 0) {
            _record("clobTrade", false);
            return;
        }
        t.amount = bound(amountSeed, 1, sellerBal);

        uint256 frac = bound(priceFracSeed, 1e15, 999e15); // 0.1% .. 99.9% of amount
        t.tradePrice = t.amount * frac / 1e18;
        if (t.tradePrice == 0) t.tradePrice = 1;
        if (t.tradePrice >= t.amount) t.tradePrice = t.amount - 1;

        t.sellerMinOut = _priceTrade(t, sellerBal);

        bool sellerFlagged = market.claimable(t.seller);
        bool buyerFlagged = market.claimable(t.buyer);

        (CLOBSettlement.Order memory makerOrder, bytes memory makerSig, CLOBSettlement.Order memory takerOrder, bytes memory takerSig) = _buildAndSign(t);

        try clob.verifyAndSettle(makerOrder, makerSig, takerOrder, takerSig) {
            if (sellerFlagged || buyerFlagged) ghost_frozenTradeSuccesses++;
            _record("clobTrade", true);
        } catch {
            _record("clobTrade", false);
        }
    }

    // Pads tradePrice up (defensively, via previewFunding) so a YES sale clears
    // the seller's real debit most of the time; computes the fee-aware seller
    // floor for a NO sale. Mutates t.tradePrice in place for the YES branch.
    function _priceTrade(TradeVars memory t, uint256 sellerBal) internal returns (uint256 sellerMinOut) {
        if (t.isYes) {
            int256 preview = market.previewFunding(t.seller, sellerBal, true);
            uint256 owed = preview < 0 ? uint256(-preview) : 0;
            uint256 fee = clob.tradeFee(t.amount, t.tradePrice);
            uint256 minNeeded = owed + fee + 1;
            if (t.tradePrice < minNeeded && minNeeded < t.amount) {
                t.tradePrice = minNeeded;
            }
            sellerMinOut = t.tradePrice;
        } else {
            uint256 fee = clob.tradeFee(t.amount, t.tradePrice);
            sellerMinOut = t.tradePrice > fee ? t.tradePrice - fee : 0;
        }
    }

    function _buildAndSign(TradeVars memory t)
        internal
        returns (
            CLOBSettlement.Order memory makerOrder,
            bytes memory makerSig,
            CLOBSettlement.Order memory takerOrder,
            bytes memory takerSig
        )
    {
        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory sellerOrder = CLOBSettlement.Order({
            maker: t.seller,
            tokenIn: t.token,
            tokenOut: address(usdc),
            amountIn: t.amount,
            minAmountOut: t.sellerMinOut,
            expiry: expiry,
            nonce: nextNonce[t.seller]++
        });
        CLOBSettlement.Order memory buyerOrder = CLOBSettlement.Order({
            maker: t.buyer,
            tokenIn: address(usdc),
            tokenOut: t.token,
            amountIn: t.tradePrice,
            minAmountOut: t.amount,
            expiry: expiry,
            nonce: nextNonce[t.buyer]++
        });

        makerOrder = t.makerIsSeller ? sellerOrder : buyerOrder;
        takerOrder = t.makerIsSeller ? buyerOrder : sellerOrder;
        makerSig = _sign(keyOf[makerOrder.maker], makerOrder);
        takerSig = _sign(keyOf[takerOrder.maker], takerOrder);
    }

    // F4-trick exerciser (docs/security/invariant-findings-2026-09-26.md,
    // required suite change #5): a YES holder approaching the seizure boundary
    // does a TINY CLOB buy of NO (price == amount, so fee == 0 regardless of
    // feeBps -- keeps this action fee-agnostic) right before it would cross --
    // exactly the F4 mechanism, since CLOBSettlement.verifyAndSettle runs
    // settleFunding(buyer) on the actor, folding its accrued YES debit into
    // fundingDebt and resetting fundingSnapshot to now. Pre-fix this reset the
    // trigger's clock to ~0 (isSeizable never saw the ledger debt); post-fix
    // owed() reads fundingDebt too, so the trigger should see straight through
    // it. Exercises exactly the snapshot-reset-with-ledger-debt path the fuzzer
    // otherwise might rarely stumble into on its own.
    function nearBoundaryTinyBuy(uint256 actorSeed, uint256 sellerSeed, uint256 amountSeed) external trackFlagged {
        address a = _actor(actorSeed);
        address seller = _actor(sellerSeed);
        if (a == seller) seller = _actor(sellerSeed + 1);
        if (a == seller || market.claimable(a) || market.claimable(seller)) {
            _record("nearBoundaryTinyBuy", false);
            return;
        }
        uint256 yesBal = yesToken.balanceOf(a);
        uint256 sellerNoBal = noToken.balanceOf(seller);
        if (yesBal == 0 || sellerNoBal == 0) {
            _record("nearBoundaryTinyBuy", false);
            return;
        }
        uint256 cap = sellerNoBal > 1e15 ? 1e15 : sellerNoBal;
        uint256 amount = bound(amountSeed, 1, cap);

        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory sellOrder = CLOBSettlement.Order({
            maker: seller,
            tokenIn: address(noToken),
            tokenOut: address(usdc),
            amountIn: amount,
            minAmountOut: 0,
            expiry: expiry,
            nonce: nextNonce[seller]++
        });
        CLOBSettlement.Order memory buyOrder = CLOBSettlement.Order({
            maker: a,
            tokenIn: address(usdc),
            tokenOut: address(noToken),
            amountIn: amount, // price == amount -> tradeFee() == 0 regardless of feeBps
            minAmountOut: amount,
            expiry: expiry,
            nonce: nextNonce[a]++
        });
        bytes memory sellSig = _sign(keyOf[seller], sellOrder);
        bytes memory buySig = _sign(keyOf[a], buyOrder);

        try clob.verifyAndSettle(sellOrder, sellSig, buyOrder, buySig) {
            _record("nearBoundaryTinyBuy", true);
        } catch {
            _record("nearBoundaryTinyBuy", false);
        }
    }

    function warpAndAccrue(uint256 seed) external trackFlagged {
        uint256 delta = bound(seed, 0, 30 days);
        vm.warp(block.timestamp + delta);
        try market.accrueFunding() {
            _record("warpAndAccrue", true);
        } catch {
            _record("warpAndAccrue", false);
        }
    }

    // Bounded up to ~400 days in a single jump (vs warpAndAccrue's 30-day cap) so
    // a position sitting at a roughly-constant mark can actually cross the
    // seizure trigger within a run's depth budget -- CLAUDE.md's own worked
    // example needs ~354 days of accrual at a constant 5% mark to do so, which
    // 8-9 draws of the small-step action would rarely stumble into by chance in
    // the same direction. Without this, flagClaimable/cure/liquidationClaim are
    // starved for eligible positions and the suite under-exercises invariants
    // 1/2/5/10's most interesting paths.
    function warpLarge(uint256 seed) external trackFlagged {
        uint256 delta = bound(seed, 0, 400 days);
        vm.warp(block.timestamp + delta);
        try market.accrueFunding() {
            _record("warpLarge", true);
        } catch {
            _record("warpLarge", false);
        }
    }

    // KEEPER_ROLE setMark, now bounded (a9476ea: maxMarkStep/minMarkInterval are
    // turned ON in the invariant setUp, unlike the unit-test defaults). Branches
    // between a small step straddling maxMarkStep (so plenty of draws land both
    // just inside and just outside the bound) and the old broad 0.01-0.60e18
    // jump (almost always beyond the bound) -- and occasionally skips warping
    // time first, so back-to-back calls also exercise MarkUpdateTooSoon. Any
    // call that SUCCEEDS is checked against the bounds actually in force at
    // that moment; a violation on a successful call means the guard-rail
    // itself is broken (M9-type regression), not that the fuzzer got unlucky.
    function setMark(uint256 seed, uint256 warpSeed) external trackFlagged {
        if (warpSeed % 3 != 0) {
            // 2-in-3 calls warp a little first (0..2h) -- sometimes enough to
            // clear minMarkInterval (1h in the invariant setUp), sometimes not.
            vm.warp(block.timestamp + bound(warpSeed, 0, 2 hours));
            // setMark() below only calls _accrueFunding() on its OWN success path
            // (after the step/interval/validity checks) -- and this action's
            // whole point is to draw plenty of calls that REVERT on those checks.
            // Without syncing here, a reverting call would leave lastFundingTime
            // stale relative to the block.timestamp we just warped to, which
            // desyncs owed()'s live projection (used by isSeizable()) from
            // invariant_SeizureTriggerConsistency's raw-index reimplementation --
            // a real bug this suite introduced, not a contract bug (caught by a
            // deep-profile run). accrueFunding() is unrestricted and can never
            // revert, so this is always safe to call unconditionally.
            market.accrueFunding();
        }
        // else: no warp at all -- back-to-back setMark calls with zero elapsed
        // time deterministically test MarkUpdateTooSoon whenever the previous
        // update was itself recent.

        uint256 oldMark = market.currentMark();
        uint256 maxStep = market.maxMarkStep();
        uint256 minInterval = market.minMarkInterval();
        uint256 lastUpdate = market.lastMarkUpdate();

        uint256 newMark;
        if (seed % 3 == 0) {
            // Small step straddling maxMarkStep: [0, maxStep + 0.02e18] --
            // roughly half the draws land inside the bound, half just beyond it.
            uint256 step = bound(seed, 0, maxStep + 0.02e18);
            newMark = (seed / 7) % 2 == 0 ? oldMark + step : (oldMark > step ? oldMark - step : oldMark + step);
        } else {
            // Broad jump -- the old unbounded behavior, almost always beyond
            // maxMarkStep, keeping that failure path well exercised too.
            newMark = bound(seed, 0.01e18, 0.60e18);
        }
        newMark = bound(newMark, 1, 1e18 - 1);

        try market.setMark(newMark) {
            uint256 actualStep = newMark > oldMark ? newMark - oldMark : oldMark - newMark;
            if (actualStep > maxStep) ghost_keeperStepViolation++;
            if (block.timestamp < lastUpdate + minInterval) ghost_keeperIntervalViolation++;
            _record("setMark", true);
        } catch {
            _record("setMark", false);
        }
    }

    // DEFAULT_ADMIN_ROLE override: bypasses maxMarkStep/minMarkInterval entirely
    // (validity check only). Provides the big, unbounded mark moves the suite
    // relies on for tail-case/seizure coverage now that the plain KEEPER setMark
    // action above is bounded -- mirrors real usage (a sudden repricing on real
    // news goes through this path, not the throttled keeper one).
    function adminSetMark(uint256 seed) external trackFlagged {
        uint256 newMark = bound(seed, 0.001e18, 0.99e18);
        try market.adminSetMark(newMark) {
            _record("adminSetMark", true);
        } catch {
            _record("adminSetMark", false);
        }
    }

    // Direct step-bound probe (mirrors probeMissedSeizureFlag/probeFlaggedActor's
    // style): jumps to whichever extreme (0.02e18 / 0.9e18) is farther from the
    // current mark, guaranteeing a step far beyond any realistic maxMarkStep
    // bound, so MarkStepTooLarge is deterministically exercised on essentially
    // every call -- rather than relying on setMark()'s own randomized draws to
    // occasionally land far enough beyond the bound by chance.
    function probeMarkStepBound() external trackFlagged {
        uint256 oldMark = market.currentMark();
        uint256 maxStep = market.maxMarkStep();
        uint256 minInterval = market.minMarkInterval();
        uint256 lastUpdate = market.lastMarkUpdate();

        uint256 newMark = oldMark < 0.5e18 ? 0.9e18 : 0.02e18;

        try market.setMark(newMark) {
            uint256 actualStep = newMark > oldMark ? newMark - oldMark : oldMark - newMark;
            if (actualStep > maxStep) ghost_keeperStepViolation++;
            if (block.timestamp < lastUpdate + minInterval) ghost_keeperIntervalViolation++;
            _record("probeMarkStepBound", true);
        } catch {
            _record("probeMarkStepBound", false);
        }
    }

    // Direct depositCap probe (mirrors probeMissedSeizureFlag/probeFlaggedActor's
    // style): sizes a mint to land EXACTLY at the remaining headroom under the
    // cap, or 1 wei past it, deterministically exercising the cap boundary on
    // essentially every call (whenever there's headroom) instead of relying on
    // the broader mint() action's uniform random amount to stumble past the cap
    // by chance.
    function probeDepositCap(uint256 actorSeed, uint256 overSeed) external trackFlagged {
        address a = _actor(actorSeed);
        uint256 supply = yesToken.totalSupply();
        uint256 cap = market.depositCap();
        if (supply >= cap) {
            _record("probeDepositCap", false);
            return;
        }
        uint256 headroom = cap - supply;
        uint256 over = bound(overSeed, 0, 1); // 0 -> exactly at cap, 1 -> 1 wei over
        uint256 amount = headroom + over;

        vm.prank(a);
        try market.mint(amount) {
            ghost_yesMinted += amount;
            if (supply + amount > cap) ghost_mintExceededCap++;
            _record("probeDepositCap", true);
        } catch {
            _record("probeDepositCap", false);
        }
    }

    function flagClaimable(uint256 actorSeed) external trackFlagged {
        address a = _actor(actorSeed);
        bool pendingBefore = market.motionPending();
        try market.flagClaimable(a) {
            if (pendingBefore) ghost_motionPendingFlagSuccesses++;
            _record("flagClaimable", true);
        } catch {
            _record("flagClaimable", false);
        }
    }

    // Sets mark to (an approximation of) the EXACT boundary mark at which the
    // given actor's isSeizable() would flip, then nudges it +/-2% either side.
    // Solving `m <= 1.03*(fNow + m*epochLength/365days)` for m at equality,
    // with fNow = owed(a) per unit (fundingDebt + live accrual -- post-fix the
    // trigger's f_now includes the ledger, so the boundary-seeking math must
    // too, or it would aim at the wrong mark whenever any debt is outstanding):
    //   m*(100*365days - 103*epochLength) <= 103*owedPerUnit*365days
    //   boundaryMark = 103*owedPerUnit*365days / (100*365days - 103*epochLength)
    // Without this, random setMark/warp draws rarely land close enough to the
    // 103%-buffer boundary to distinguish it from a subtly wrong constant (e.g.
    // 104%) -- this action exists purely to make invariant_SeizureTriggerConsistency
    // actually exercise the boundary, and as a side effect makes flagClaimable
    // itself far more reachable (feeding cure/liquidationClaim/frozen-lock
    // coverage too).
    function seekSeizureBoundary(uint256 actorSeed, uint256 nudgeSeed) external trackFlagged {
        address a = _actor(actorSeed);
        uint256 yesBal = yesToken.balanceOf(a);
        if (yesBal == 0 || market.claimable(a)) {
            _record("seekSeizureBoundary", false);
            return;
        }
        uint256 owedPerUnit = market.owed(a) * 1e18 / yesBal;
        uint256 epochLength = market.epochLength();
        uint256 denom = 100 * 365 days - 103 * epochLength;
        if (denom == 0 || owedPerUnit == 0) {
            _record("seekSeizureBoundary", false);
            return;
        }
        uint256 boundaryMark = (103 * owedPerUnit * 365 days) / denom;

        int256 nudgePct = int256(bound(nudgeSeed, 0, 400)) - 200; // -2.00% .. +2.00%
        uint256 newMark;
        if (nudgePct >= 0) {
            newMark = boundaryMark + boundaryMark * uint256(nudgePct) / 10000;
        } else {
            uint256 down = boundaryMark * uint256(-nudgePct) / 10000;
            newMark = boundaryMark > down ? boundaryMark - down : 0;
        }
        newMark = bound(newMark, 0.001e18, 0.65e18);

        // Uses adminSetMark, not the plain keeper setMark: this action needs to
        // land PRECISELY at the computed boundary mark in one shot regardless of
        // distance from the current mark, and a9476ea's maxMarkStep/minMarkInterval
        // bounds (turned on for the keeper path in this suite's setUp) would
        // otherwise block exactly the large, well-timed jumps this probe depends on.
        try market.adminSetMark(newMark) {
            _record("seekSeizureBoundary", true);
        } catch {
            _record("seekSeizureBoundary", false);
        }
    }

    // Directly re-probes invariant 10 (flagged-position lockout) on a KNOWN
    // currently-flagged actor, rather than relying on mint()/redeem()'s own
    // uniform random actor selection to happen to land on that specific actor
    // before it resolves (cure/claim). A no-op (recorded as such) whenever the
    // selected actor isn't currently flagged.
    // Scans ALL actors (not just one random pick) so this deterministically
    // fires on every currently-flagged actor whenever it's called -- a single
    // random actor pick would only have a 1-in-N_ACTORS chance of landing on
    // whichever actor happens to be flagged, which made invariant 10 coverage
    // (and hence catching a mint()-ignores-freeze mutation) too unreliable at
    // the default profile's smaller runs/depth budget.
    function probeFlaggedActor(uint256 amountSeed) external trackFlagged {
        bool probedAny;
        uint256 n = actors.length;
        for (uint256 i = 0; i < n; i++) {
            address a = actors[i];
            if (!market.claimable(a)) continue;
            probedAny = true;
            uint256 amount = bound(amountSeed, 1e15, 100e18);
            uint256 supplyBefore = yesToken.totalSupply();
            uint256 capNow = market.depositCap();

            // This probe exists specifically to test the FREEZE check (invariant
            // 10) -- not the depositCap check (that's probeDepositCap's job).
            // Guarantee headroom so a cap collision can never masquerade as (or
            // mask) a mint-ignores-freeze regression: without this, depositCap
            // being nearly full (probeDepositCap deliberately drives it there)
            // would make this attempt revert DepositCapExceeded regardless of
            // whether the freeze check itself is intact, silently starving
            // invariant_FlaggedPositionsLocked's coverage of this exact path.
            if (supplyBefore + amount > capNow) {
                capNow = supplyBefore + amount + 1;
                market.setDepositCap(capNow);
            }

            vm.prank(a);
            try market.mint(amount) {
                ghost_yesMinted += amount;
                ghost_frozenMintSuccesses++;
                if (supplyBefore + amount > capNow) ghost_mintExceededCap++;
            } catch {}

            uint256 yesBal = yesToken.balanceOf(a);
            uint256 noBal = noToken.balanceOf(a);
            uint256 maxAmt = yesBal < noBal ? yesBal : noBal;
            if (maxAmt > 0) {
                vm.prank(a);
                try market.redeem(maxAmt) {
                    ghost_yesBurnedTotal += maxAmt;
                    ghost_noBurnedTotal += maxAmt;
                    ghost_frozenRedeemSuccesses++;
                } catch {}
            }
        }
        _record("probeFlaggedActor", probedAny);
    }

    // Direct F4-type probe (required suite change #3, second part): whenever an
    // UNFLAGGED actor's position satisfies the spec's seizure condition --
    // value*100 <= (owed()+nextEpoch)*103, independently recomputed here from
    // owed() (NOT by calling market.isSeizable(), which would make this probe
    // blind to a mutation that breaks isSeizable() itself while leaving owed()
    // intact -- e.g. M6, reverting the F4 fix inside isSeizable only) -- then
    // flagClaimable() MUST succeed. Any revert is a direct violation of the
    // trigger spec and increments ghost_missedSeizureFlag.
    function probeMissedSeizureFlag() external trackFlagged {
        if (market.motionPending()) {
            _record("probeMissedSeizureFlag", false);
            return;
        }
        uint256 m = market.currentMark();
        uint256 epochLength = market.epochLength();
        bool probedAny;
        uint256 n = actors.length;
        for (uint256 i = 0; i < n; i++) {
            address a = actors[i];
            if (market.claimable(a)) continue;
            uint256 yesBal = yesToken.balanceOf(a);
            if (yesBal == 0) continue;

            uint256 owedNow = market.owed(a);
            uint256 value = yesBal * m / 1e18;
            uint256 nextEpoch = yesBal * (m * epochLength / 365 days) / 1e18;
            bool shouldBeSeizable = value * 100 <= (owedNow + nextEpoch) * 103;
            if (!shouldBeSeizable) continue;

            probedAny = true;
            try market.flagClaimable(a) {
                // expected -- success
            } catch {
                ghost_missedSeizureFlag++;
            }
        }
        _record("probeMissedSeizureFlag", probedAny);
    }

    function cure(uint256 actorSeed) external trackFlagged {
        address a = _actor(actorSeed);
        if (!market.claimable(a)) {
            _record("cure", false);
            return;
        }

        vm.prank(a);
        try market.cure() {
            _record("cure", true);
        } catch {
            _record("cure", false);
        }
    }

    function liquidationClaim(uint256 liqSeed, uint256 targetSeed) external trackFlagged {
        address liquidator = _actor(liqSeed);
        address target = _actor(targetSeed);
        if (!market.claimable(target)) {
            _record("liquidationClaim", false);
            return;
        }
        // Post-fix (F2): clearLiquidatedPosition reverts PositionFrozen if the
        // liquidator is itself flagged (rather than silently no-op'ing the
        // liquidator's own fresh-start reset, as the pre-fix _syncUserFunding
        // did). No special-casing needed here any more -- a flagged liquidator's
        // claim attempt is just another expected revert, tallied like any other.
        bool pendingBefore = market.motionPending();
        uint256 Q = yesToken.balanceOf(target);
        uint256 m = market.currentMark();
        uint256 owedTotal = market.owed(target);
        uint256 tokenValue = Q * m / 1e18;
        bool tailCase = owedTotal > tokenValue;

        vm.prank(liquidator);
        try liquidationEngine.claim(target) {
            if (pendingBefore) ghost_motionPendingClaimSuccesses++;
            if (market.fundingDebt(target) != 0) {
                ghost_liquidationLedgerNotCleared++;
            }
            if (tailCase) ghost_tailCaseClaims++;
            else ghost_normalCaseClaims++;
            _record("liquidationClaim", true);
        } catch {
            _record("liquidationClaim", false);
        }
    }

    // Throttled: confirming a credit event permanently pauses CreditMarket for
    // the rest of THIS campaign (mint/redeem/cure all revert Pausable.EnforcedPause
    // from that point on), so an unthrottled ~1-in-13 chance of this action would
    // burn most of a 256-deep run on the post-event tail and starve pre-event
    // coverage (mint/redeem/CLOB/flag/cure/claim). Gating it to a low, seed-driven
    // probability keeps it reachable (so the credit-event/settleYES path is still
    // exercised every campaign) while leaving most of the depth budget for the
    // richer pre-event state space.
    function confirmCreditEvent(uint256 seed) external trackFlagged {
        if (seed % 25 != 0) {
            _record("confirmCreditEvent", false);
            return;
        }
        try router.confirmCreditEvent() {
            _record("confirmCreditEvent", true);
        } catch {
            _record("confirmCreditEvent", false);
        }
    }

    function setMotionPending(uint256 seed) external trackFlagged {
        bool pending = seed % 2 == 0;
        try market.setMotionPending(pending) {
            _record("setMotionPending", true);
        } catch {
            _record("setMotionPending", false);
        }
    }

    function toggleFee(uint256 seed) external trackFlagged {
        uint256 newFee = seed % 2 == 0 ? 0 : 50;
        try clob.setFeeConfig(newFee, teamWallet, address(insuranceFund), 5_000) {
            _record("toggleFee", true);
        } catch {
            _record("toggleFee", false);
        }
    }

    function fundInsurance(uint256 seed) external trackFlagged {
        uint256 amount = bound(seed, 0, 1_000e18);
        usdc.mint(address(this), amount);
        usdc.approve(address(insuranceFund), amount);
        try insuranceFund.deposit(amount) {
            _record("fundInsurance", true);
        } catch {
            _record("fundInsurance", false);
        }
    }

    // ── reporting ─────────────────────────────────────────────────────────────

    function callSummary() external view returns (string memory out) {
        out = "action,calls,success,revert\n";
        for (uint256 i = 0; i < actionNames.length; i++) {
            string memory n = actionNames[i];
            out = string.concat(
                out,
                n,
                ",",
                vm.toString(callCounts[n]),
                ",",
                vm.toString(successCounts[n]),
                ",",
                vm.toString(revertCounts[n]),
                "\n"
            );
        }
    }
}
