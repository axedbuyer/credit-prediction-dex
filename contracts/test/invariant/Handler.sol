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
    // Frozen-funding-immutable-while-flagged (part of invariant 10's freeze semantics).
    uint256 public ghost_frozenFundingChangedWhileFlagged;

    // Invariant 5 — nothing seizes/claims during a pending credit-event motion.
    uint256 public ghost_motionPendingFlagSuccesses;
    uint256 public ghost_motionPendingClaimSuccesses;

    // Liquidation ledger must be fully cleared (fundingDebt==0 && frozenFunding==0)
    // for the original holder immediately after every successful claim().
    uint256 public ghost_liquidationLedgerNotCleared;
    uint256 public ghost_normalCaseClaims;
    uint256 public ghost_tailCaseClaims;

    // KNOWN-VIOLATION compensation ledger (see CreditMarketInvariant.t.sol's
    // invariant_CollateralSolvencyPreEvent for the full writeup and derivation).
    // CreditMarket.settleFunding's claimable-branch prices a flagged holder's
    // YES-side debt at a value CAPPED at flag time (frozenFunding), while ANY NO
    // holder who syncs during the freeze window still collects credit off the
    // LIVE, uncapped cumFundingPerNO -- a real, permanent, uncollateralized
    // leak. For a position that is CURRENTLY still flagged, the outstanding
    // leak is a pure function of live state (yesBal(u) * (cumFundingPerNO_now -
    // frozenFunding(u)) / 1e18) and needs no ghost -- the invariant recomputes
    // it fresh every check. But once a flagged position RESOLVES (cure,
    // settleYES, or a liquidation claim), frozenFunding is zeroed and the
    // position's own live-state terms go back to normal, so the (by-then
    // already-realized, permanent) leak amount has to be captured HERE, at the
    // moment of resolution, using the values immediately before that call, or
    // it would vanish from the aggregate solvency formula even though the cash
    // never came back.
    mapping(address => uint256) public ghost_lockedLeak;

    // KNOWN-VIOLATION #2 (distinct from the freeze leak above; see
    // CreditMarketInvariant.t.sol for the full writeup): CreditMarket's
    // internal `_syncUserFunding` (CreditMarket.sol ~L87-96) -- invoked on the
    // LIQUIDATOR inside `clearLiquidatedPosition` to give them a "fresh start"
    // on the seized YES -- resets `snapNO[user]` to the current index WITHOUT
    // ever computing or paying out any NO-side credit the liquidator had
    // accrued (it only ever touches the YES side / fundingDebt). If the
    // liquidator happens to ALSO hold NO tokens with a stale snapNO at claim
    // time, that pending NO credit is silently forfeited -- never paid, and
    // the ledger no longer remembers it (their NEXT sync starts counting from
    // the reset point, not the old one). This does not threaten solvency (the
    // cash stays IN collateral -- if anything makes the pool MORE solvent) but
    // it does shortchange that specific liquidator. Captured here, at the
    // moment of a successful claim(), from the liquidator's PRE-call state.
    mapping(address => uint256) public ghost_forfeitedNoCredit;

    // Per-action ghost checks (invariant 9, decoupled from the aggregate
    // solvency formula): the USDC a user actually receives from redeem()/
    // settleYES() must equal `amount +/- the funding delta settleFunding would
    // compute for them`, independently reprojected here from public state
    // right before the call. Any deviation (e.g. a debt that gets forgiven
    // instead of deducted) increments these and must stay 0.
    uint256 public ghost_redeemPayoutMismatch;
    uint256 public ghost_settleYESPayoutMismatch;

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

        // Pre-fund InsuranceFund generously so tail-case claims (fFrozenTotal >
        // tokenValue) can actually be exercised rather than reverting for lack of
        // reserve every time.
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
    // settleFunding's first action is always _accrueFunding()). `claimableNow`
    // selects the claimable-branch (frozen, capped) vs the live branch, exactly
    // as settleFunding itself does.
    function _projectSettleDelta(address user, bool claimableNow) internal view returns (int256 delta) {
        uint256 yesBal = yesToken.balanceOf(user);
        uint256 noBal = noToken.balanceOf(user);

        uint256 mark = market.currentMark();
        uint256 elapsed = block.timestamp - market.lastFundingTime();
        uint256 projectedCum = market.cumulativeFundingPerYES() + mark * elapsed / 365 days;

        uint256 yesOwed = claimableNow
            ? market.frozenFunding(user) * yesBal / 1e18
            : yesBal * (projectedCum - market.fundingSnapshot(user)) / 1e18;
        uint256 noCredit = noBal * (projectedCum - market.snapNO(user)) / 1e18;
        uint256 debit = market.fundingDebt(user) + yesOwed;

        delta = noCredit >= debit ? int256(noCredit - debit) : -int256(debit - noCredit);
    }

    // The (not-yet-locked) frozen-window leak for a CURRENTLY flagged `user`,
    // computed from live state. Callers read this BEFORE the resolving call
    // (cure/settleYES/claim) and only fold it into ghost_lockedLeak[user] if
    // that call actually succeeds -- see ghost_lockedLeak's own comment and
    // invariant_CollateralSolvencyPreEvent for the full derivation.
    //
    // IMPORTANT: frozenFunding(user) is a DELTA (accrued since the user's OWN
    // pre-flag fundingSnapshot), not the absolute cumFundingPerYES index value
    // at flag time -- fundingSnapshot(user) is left untouched while flagged
    // (CreditMarket.sol's _syncUserFunding/settleFunding both skip advancing it
    // for a claimable user), so it's still readable here and must be ADDED BACK
    // to reconstruct the absolute index at flag time: cumYESAtFlag =
    // frozenFunding(user) + fundingSnapshot(user). Using frozenFunding(user)
    // alone (as an early draft of this helper did) silently double-subtracts
    // the user's own pre-flag backlog and overstates the leak by that amount
    // for any position that sat unsynced for a while before being flagged --
    // caught via invariant_CollateralSolvencyPreEvent itself failing on a
    // freshly-flagged position with zero actual elapsed post-flag time (see
    // scratchpad notes / mutation-testing follow-up).
    function _pendingLeak(address user) internal view returns (uint256) {
        uint256 q = yesToken.balanceOf(user);
        uint256 cumYESAtFlag = market.frozenFunding(user) + market.fundingSnapshot(user);
        uint256 cumNO = market.cumFundingPerNO();
        return cumNO > cumYESAtFlag ? q * (cumNO - cumYESAtFlag) / 1e18 : 0;
    }

    function _sign(uint256 key, CLOBSettlement.Order memory order) internal view returns (bytes memory) {
        bytes32 digest = clob.hashOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // Snapshots frozenFunding for every currently-flagged actor before the wrapped
    // action, and afterwards asserts (via ghost counter, not a hard revert — the
    // invariant test reads the counter) that any actor STILL flagged after the
    // action has an UNCHANGED frozenFunding value. Per CreditMarket.sol,
    // frozenFunding[user] is written only by flagClaimable (set), and consumed
    // (zeroed) only inside settleFunding when claimable[user] is true — which only
    // happens via cure()/settleYES() (both also flip claimable=false in the same
    // call) or clearLiquidatedPosition (claim(), also flips claimable=false). So an
    // actor that is STILL flagged after some unrelated action ran must have an
    // untouched frozenFunding.
    modifier trackFrozen() {
        uint256 n = actors.length;
        uint256[] memory snap = new uint256[](n);
        bool[] memory wasFlagged = new bool[](n);
        for (uint256 i = 0; i < n; i++) {
            wasFlagged[i] = market.claimable(actors[i]);
            snap[i] = market.frozenFunding(actors[i]);
        }
        _;
        for (uint256 i = 0; i < n; i++) {
            if (wasFlagged[i] && market.claimable(actors[i])) {
                if (market.frozenFunding(actors[i]) != snap[i]) {
                    ghost_frozenFundingChangedWhileFlagged++;
                }
            }
        }
    }

    // ── actions (invariant targets) ──────────────────────────────────────────

    function mint(uint256 actorSeed, uint256 amountSeed) external trackFrozen {
        address a = _actor(actorSeed);
        uint256 amount = bound(amountSeed, 1e15, 2_000e18);
        bool flagged = market.claimable(a);

        vm.prank(a);
        try market.mint(amount) {
            ghost_yesMinted += amount;
            if (flagged) ghost_frozenMintSuccesses++;
            _record("mint", true);
        } catch {
            _record("mint", false);
        }
    }

    function redeem(uint256 actorSeed, uint256 amountSeed) external trackFrozen {
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
        int256 expectedDelta = flagged ? int256(0) : _projectSettleDelta(a, false);
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

    function settleYES(uint256 actorSeed, uint256 amountSeed) external trackFrozen {
        address a = _actor(actorSeed);
        uint256 yesBal = yesToken.balanceOf(a);
        if (yesBal == 0) {
            _record("settleYES", false);
            return;
        }
        uint256 amount = bound(amountSeed, 1, yesBal);
        bool wasFlagged = market.claimable(a);
        int256 expectedDelta = _projectSettleDelta(a, wasFlagged);
        uint256 usdcBefore = usdc.balanceOf(a);
        // Pre-compute the leak (if any) BEFORE the call, using pre-call state --
        // only actually recorded into the ghost if the call succeeds (settleYES
        // "auto-cures" a flagged position by clearing the flag), never on revert.
        uint256 preLeak = wasFlagged ? _pendingLeak(a) : 0;

        vm.prank(a);
        try market.settleYES(amount) {
            ghost_yesBurnedTotal += amount;
            if (wasFlagged) ghost_lockedLeak[a] += preLeak;
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
    ) external trackFrozen {
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

    function warpAndAccrue(uint256 seed) external trackFrozen {
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
    function warpLarge(uint256 seed) external trackFrozen {
        uint256 delta = bound(seed, 0, 400 days);
        vm.warp(block.timestamp + delta);
        try market.accrueFunding() {
            _record("warpLarge", true);
        } catch {
            _record("warpLarge", false);
        }
    }

    function setMark(uint256 seed) external trackFrozen {
        uint256 newMark = bound(seed, 0.01e18, 0.60e18);
        try market.setMark(newMark) {
            _record("setMark", true);
        } catch {
            _record("setMark", false);
        }
    }

    function flagClaimable(uint256 actorSeed) external trackFrozen {
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
    // Solving `m <= 1.03*(fNow + m*epochLength/365days)` for m at equality:
    //   m*(100*365days - 103*epochLength) <= 103*fNow*365days
    //   boundaryMark = 103*fNow*365days / (100*365days - 103*epochLength)
    // Without this, random setMark/warp draws rarely land close enough to the
    // 103%-buffer boundary to distinguish it from a subtly wrong constant (e.g.
    // 104%) -- this action exists purely to make invariant_SeizureTriggerConsistency
    // actually exercise the boundary, and as a side effect makes flagClaimable
    // itself far more reachable (feeding cure/liquidationClaim/frozen-lock
    // coverage too).
    function seekSeizureBoundary(uint256 actorSeed, uint256 nudgeSeed) external trackFrozen {
        address a = _actor(actorSeed);
        uint256 yesBal = yesToken.balanceOf(a);
        if (yesBal == 0 || market.claimable(a)) {
            _record("seekSeizureBoundary", false);
            return;
        }
        uint256 fNow = market.cumulativeFundingPerYES() - market.fundingSnapshot(a);
        uint256 epochLength = market.epochLength();
        uint256 denom = 100 * 365 days - 103 * epochLength;
        if (denom == 0 || fNow == 0) {
            _record("seekSeizureBoundary", false);
            return;
        }
        uint256 boundaryMark = (103 * fNow * 365 days) / denom;

        int256 nudgePct = int256(bound(nudgeSeed, 0, 400)) - 200; // -2.00% .. +2.00%
        uint256 newMark;
        if (nudgePct >= 0) {
            newMark = boundaryMark + boundaryMark * uint256(nudgePct) / 10000;
        } else {
            uint256 down = boundaryMark * uint256(-nudgePct) / 10000;
            newMark = boundaryMark > down ? boundaryMark - down : 0;
        }
        newMark = bound(newMark, 0.001e18, 0.65e18);

        try market.setMark(newMark) {
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
    function probeFlaggedActor(uint256 amountSeed) external trackFrozen {
        bool probedAny;
        uint256 n = actors.length;
        for (uint256 i = 0; i < n; i++) {
            address a = actors[i];
            if (!market.claimable(a)) continue;
            probedAny = true;
            uint256 amount = bound(amountSeed, 1e15, 100e18);

            vm.prank(a);
            try market.mint(amount) {
                ghost_yesMinted += amount;
                ghost_frozenMintSuccesses++;
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

    function cure(uint256 actorSeed) external trackFrozen {
        address a = _actor(actorSeed);
        if (!market.claimable(a)) {
            _record("cure", false);
            return;
        }
        uint256 preLeak = _pendingLeak(a);

        vm.prank(a);
        try market.cure() {
            ghost_lockedLeak[a] += preLeak;
            _record("cure", true);
        } catch {
            _record("cure", false);
        }
    }

    function liquidationClaim(uint256 liqSeed, uint256 targetSeed) external trackFrozen {
        address liquidator = _actor(liqSeed);
        address target = _actor(targetSeed);
        if (!market.claimable(target)) {
            _record("liquidationClaim", false);
            return;
        }
        // OBSERVATION (not compensated, scoped out): claim() is permissionless
        // and never checks the CALLER's own claimable status. If the liquidator
        // is themselves currently flagged, clearLiquidatedPosition's
        // _syncUserFunding(liquidator) call no-ops (it early-returns whenever
        // claimable[user] is true), skipping the "fresh start" reset the spec
        // promises liquidators -- the newly-seized YES then gets retroactively
        // priced against the liquidator's OWN stale frozen state at their next
        // resolution. Real keeper/liquidator bots would not practically be
        // flagged YES holders themselves, and precisely modeling this exotic
        // double-flagged interaction is out of scope here -- skip it so the
        // suite stays focused on the realistic (non-flagged liquidator) path.
        if (market.claimable(liquidator)) {
            _record("liquidationClaim", false);
            return;
        }
        bool pendingBefore = market.motionPending();
        uint256 prevDebt = market.fundingDebt(target);
        uint256 frozenPerUnit = market.frozenFunding(target);
        uint256 Q = yesToken.balanceOf(target);
        uint256 m = market.currentMark();
        uint256 fFrozenTotal = prevDebt + frozenPerUnit * Q / 1e18;
        uint256 tokenValue = Q * m / 1e18;
        bool tailCase = fFrozenTotal > tokenValue;
        uint256 preLeak = _pendingLeak(target);
        // See ghost_forfeitedNoCredit's comment: clearLiquidatedPosition's
        // _syncUserFunding(liquidator) call resets the liquidator's snapNO
        // without paying out any pending NO credit -- capture it here, from
        // pre-call state, before that reset silently erases it.
        uint256 preForfeit = noToken.balanceOf(liquidator) * (market.cumFundingPerNO() - market.snapNO(liquidator)) / 1e18;

        vm.prank(liquidator);
        try liquidationEngine.claim(target) {
            ghost_lockedLeak[target] += preLeak;
            ghost_forfeitedNoCredit[liquidator] += preForfeit;
            if (pendingBefore) ghost_motionPendingClaimSuccesses++;
            if (market.fundingDebt(target) != 0 || market.frozenFunding(target) != 0) {
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
    function confirmCreditEvent(uint256 seed) external trackFrozen {
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

    function setMotionPending(uint256 seed) external trackFrozen {
        bool pending = seed % 2 == 0;
        try market.setMotionPending(pending) {
            _record("setMotionPending", true);
        } catch {
            _record("setMotionPending", false);
        }
    }

    function toggleFee(uint256 seed) external trackFrozen {
        uint256 newFee = seed % 2 == 0 ? 0 : 50;
        try clob.setFeeConfig(newFee, teamWallet, address(insuranceFund), 5_000) {
            _record("toggleFee", true);
        } catch {
            _record("toggleFee", false);
        }
    }

    function fundInsurance(uint256 seed) external trackFrozen {
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
