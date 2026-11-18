// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {FixedPointMathLib} from "solady/utils/FixedPointMathLib.sol";

interface IRestrictedToken {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

contract CreditMarket is ReentrancyGuard, Pausable, AccessControl {
    using SafeERC20 for IERC20;

    bytes32 public constant ORACLE_ROLE      = keccak256("ORACLE_ROLE");
    bytes32 public constant KEEPER_ROLE     = keccak256("KEEPER_ROLE");
    bytes32 public constant PAUSER_ROLE     = keccak256("PAUSER_ROLE");
    bytes32 public constant CLOB_ROLE       = keccak256("CLOB_ROLE");
    bytes32 public constant LIQUIDATOR_ROLE = keccak256("LIQUIDATOR_ROLE");
    // Batch 4: the mark updater's own key (setMark), separate from KEEPER_ROLE (flagging),
    // so a compromised flagging key can't move the mark and vice versa.
    bytes32 public constant MARK_ROLE       = keccak256("MARK_ROLE");

    address public usdc;
    address public yesToken;
    address public noToken;
    uint256 public currentMark;
    // Annual carry per unit of YES (1e18-scaled) at currentMark: carryRateFor(currentMark).
    // Recomputed only when the mark changes; every accrual uses it, never the mark.
    uint256 public currentCarryRate;
    bool public creditEventConfirmed;
    bool public motionPending; // true while a credit-event motion is open (informational: blocks nothing)

    uint256 public cumulativeFundingPerYES; // 1e18-scaled; rises monotonically
    uint256 public cumFundingPerNO;         // always equals cumulativeFundingPerYES (complete-set invariant)
    uint256 public lastFundingTime;
    uint256 public epochLength;             // seconds per epoch (used for epochsToExpire)
    mapping(address => uint256) public fundingSnapshot; // YES snapshot per holder
    mapping(address => uint256) public snapNO;          // NO snapshot per holder
    // Ordinary (pre-EDD) recorded debt. The public `fundingDebt(user)` view adds the
    // live motion debt, so off-chain readers keep one "recorded debt" number.
    mapping(address => uint256) internal _debt;
    mapping(address => uint256) public costBasis;       // 1e18-scaled entry mark (weighted avg)
    mapping(address => bool)    public claimable;       // true once keeper flags position (a lock, not a freeze)

    // Launch guard-rails (admin-set; the constructor leaves both OFF so tests and the
    // local demo can move freely — the deploy script turns them on):
    // - depositCap: max outstanding complete sets (YES.totalSupply) mint() may create.
    // - setMark bound: a KEEPER_ROLE update may move the mark by at most maxMarkStep
    //   (absolute, 1e18-scaled) and no sooner than minMarkInterval after the previous
    //   one, so a compromised keeper key can't teleport the mark (it would take
    //   (Δ / maxMarkStep) × minMarkInterval to walk it). The admin can override.
    uint256 public depositCap      = type(uint256).max;
    uint256 public maxMarkStep     = 1e18;
    uint256 public minMarkInterval;
    uint256 public lastMarkUpdate;

    // ─── credit-event motions (batch 4, docs/design/motion-escrow-and-mark.md) ────
    // A motion is informational: trading, flagging, claims and cure all run normally.
    // Opening one records the funding index at that moment (the EDD on Pari). Carry
    // accrued after it is escrowed per address until the motion resolves:
    //   - DC "No" (setMotionPending(false)): escrowed Downbet credit is released, and
    //     post-EDD Upbet debt becomes ordinary debt.
    //   - DC "Yes" (confirmCreditEvent): all post-EDD carry is void — escrowed credit
    //     and unpaid post-EDD debt are cancelled, and post-EDD carry already paid in
    //     cash is refunded to whoever paid it.
    // One motion at a time; an open motion is always the latest (`motionId`).
    enum MotionOutcome { None, Open, No, Yes }
    uint256 public motionId;                                  // latest motion; 0 = none yet
    mapping(uint256 => uint256) public motionIndex;           // cumulativeFundingPerYES when it opened
    mapping(uint256 => MotionOutcome) public motionOutcome;
    // Per address, for the motion its record belongs to (`userMotion`); folded lazily at
    // the address's next settleFunding once that motion has resolved.
    mapping(address => uint256) public userMotion;
    mapping(address => uint256) internal _escrowCredit; // post-EDD Downbet credit, net of own post-EDD debit
    mapping(address => uint256) internal _motionDebt;   // unpaid post-EDD Upbet debt, net of own post-EDD credit
    mapping(address => uint256) internal _refund;       // post-EDD carry this address PAID in cash (refund on Yes)

    event TokensMinted(address indexed user, uint256 amount);
    event TokensRedeemed(address indexed user, uint256 tokenAmount);
    event YESSettled(address indexed user, uint256 amount);
    event CreditEventTriggered();
    event FundingAccrued(uint256 cumulativeFundingPerYES, uint256 cumFundingPerNO, uint256 timestamp);
    event FlaggedClaimable(address indexed user, uint256 owedPerUnit, uint256 timestamp);
    event FundingSettled(address indexed user, int256 delta);
    event PositionCured(address indexed user, uint256 amountPaid);
    event MarkUpdated(uint256 oldMark, uint256 newMark, bool adminOverride);
    event DepositCapUpdated(uint256 depositCap);
    event MarkBoundsUpdated(uint256 maxMarkStep, uint256 minMarkInterval);
    event MotionPendingSet(bool pending);
    event MotionOpened(uint256 indexed motionId, uint256 eddIndex);
    event MotionResolved(uint256 indexed motionId, bool creditEvent);
    event MotionRefundRecorded(address indexed payer, uint256 indexed motionId, uint256 amount);

    error CreditEventAlreadyConfirmed();
    error CreditEventNotConfirmed();
    error PositionNotSeizable();
    error AlreadyFlagged();
    error PositionFrozen();
    error MotionStateUnchanged();
    error ZeroAddress();
    error DepositCapExceeded();
    error InvalidMark();
    error MarkStepTooLarge();
    error MarkUpdateTooSoon();
    error DebtCollectionExceedsDebt();

    constructor(
        address admin,
        address _usdc,
        address _yesToken,
        address _noToken,
        uint256 _initialMark,
        uint256 _epochLength
    ) {
        if (admin == address(0) || _usdc == address(0) || _yesToken == address(0) || _noToken == address(0)) {
            revert ZeroAddress();
        }
        if (_initialMark == 0 || _initialMark >= 1e18) revert InvalidMark();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        usdc = _usdc;
        yesToken = _yesToken;
        noToken = _noToken;
        currentMark = _initialMark;
        currentCarryRate = carryRateFor(_initialMark);
        epochLength = _epochLength;
        lastFundingTime = block.timestamp;
        lastMarkUpdate  = block.timestamp;
    }

    // ─── funding ────────────────────────────────────────────────────────────────

    // Fair annual carry for a YES priced at `mark` (the 12-month default probability):
    //   carry = h × (1 − m), with hazard h = −ln(1 − m)
    // h is the hazard implied by a 12-month probability of m; (1 − m) is what a YES
    // holder actually stands to gain on a credit event (the token jumps from m to $1),
    // so it is the notional the NO side really protects. At this rate a YES held at a
    // steady mark has zero expected P&L, which is what makes "price = probability"
    // exact (constant hazard, zero rates). Always m(1 − m) <= carry <= m; it peaks at
    // 1/e when m = 1 − 1/e. Derivation: docs/carry-formula.md.
    function carryRateFor(uint256 mark) public pure returns (uint256) {
        if (mark == 0 || mark >= 1e18) revert InvalidMark();
        int256 lnOneMinusM = FixedPointMathLib.lnWad(int256(1e18 - mark));
        if (lnOneMinusM >= 0) return 0; // dust marks round ln(1 − m) to 0
        uint256 carry = (1e18 - mark) * uint256(-lnOneMinusM) / 1e18;
        return carry > mark ? mark : carry; // rounding guard: carry never exceeds m
    }

    function _accrueFunding() internal {
        uint256 elapsed = block.timestamp - lastFundingTime;
        if (elapsed == 0) return;
        cumulativeFundingPerYES += currentCarryRate * elapsed / 365 days;
        cumFundingPerNO = cumulativeFundingPerYES; // exact equality; YES.totalSupply()==NO.totalSupply() always
        lastFundingTime = block.timestamp;
        emit FundingAccrued(cumulativeFundingPerYES, cumFundingPerNO, block.timestamp);
    }

    // Index value as of now, without writing it (views project accrual forward).
    function _projectedCumYES() internal view returns (uint256) {
        return cumulativeFundingPerYES + currentCarryRate * (block.timestamp - lastFundingTime) / 365 days;
    }

    // THE single measure of a holder's YES-side funding obligation, used by the
    // seizure trigger, the liquidation claim price, cure, and the display layer:
    // the recorded ledger debt (already net of NO credit at the last settlement)
    // plus live accrual on the current YES balance since the snapshot. There is no
    // freeze — a flag only LOCKS the position; accrual continues until it is
    // claimed, cured, or settled.
    // During an open motion owed() also counts post-EDD debt (recorded and live), so
    // the trigger and the claim price see it — liquidations stay fully live. After a
    // confirmed event post-EDD debt is void and excluded.
    function owed(address user) public view returns (uint256) {
        (uint256 pre, uint256 post) = _owedSplit(user);
        return pre + post;
    }

    // Recorded debt: ordinary debt plus the address's post-EDD debt while it still
    // counts (motion open, or resolved No and not yet folded). Excludes live accrual.
    function fundingDebt(address user) public view returns (uint256) {
        MotionOutcome o = motionOutcome[userMotion[user]];
        return _debt[user] + (o == MotionOutcome.Open || o == MotionOutcome.No ? _motionDebt[user] : 0);
    }

    // Escrow record for `user`: escrowed post-EDD Downbet credit ("pending carry, paid if
    // the DC rules No"), unpaid post-EDD Upbet debt, post-EDD carry paid in cash
    // ("refunded if the DC rules Yes"), and the motion they belong to. Raw values; read
    // motionOutcome(motion) to interpret a record that hasn't been folded yet.
    function escrowOf(address user)
        external
        view
        returns (uint256 escrowedCredit, uint256 motionDebt, uint256 refundable, uint256 motion)
    {
        return (_escrowCredit[user], _motionDebt[user], _refund[user], userMotion[user]);
    }

    // (pre-EDD part, post-EDD part) of owed(user), each rounded up as settleFunding
    // records it. post is non-zero only while a motion is open.
    function _owedSplit(address user) internal view returns (uint256 pre, uint256 post) {
        uint256 yesBal = IERC20(yesToken).balanceOf(user);
        (uint256 yPre, uint256 yPost) = _splitDelta(fundingSnapshot[user], _projectedCumYES());
        pre = _debt[user] + _yesDebit(yesBal, yPre);
        MotionOutcome o = motionOutcome[userMotion[user]];
        if (o == MotionOutcome.No) pre += _motionDebt[user];
        else if (o == MotionOutcome.Open) post = _motionDebt[user];
        if (motionPending) post += _yesDebit(yesBal, yPost);
    }

    // Splits an index move from `snap` to `idx` at the EDD index: an open motion's, or
    // the confirmed motion's after a Yes. Without either, all of it is ordinary.
    function _splitDelta(uint256 snap, uint256 idx) internal view returns (uint256 pre, uint256 post) {
        if (!motionPending && !creditEventConfirmed) return (idx - snap, 0);
        uint256 edd = motionIndex[motionId];
        if (snap >= edd) return (0, idx - snap);
        if (idx <= edd) return (idx - snap, 0);
        return (edd - snap, idx - edd);
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    // Collects `amount` of `user`'s recorded debt that `user` has just paid in cash (or
    // that stays in collateral from their payout): ordinary debt first, then post-EDD
    // debt, which is recorded as refundable to `user` if the DC rules Yes.
    function _takeDebt(address user, uint256 amount) internal {
        uint256 fromPre = _min(amount, _debt[user]);
        _debt[user] -= fromPre;
        uint256 rest = amount - fromPre;
        if (rest > 0) {
            _motionDebt[user] -= rest;
            _refund[user] += rest;
            emit MotionRefundRecorded(user, motionId, rest);
        }
    }

    // A YES holder's carry for `bal` tokens over an index move of `indexDelta`, rounded
    // UP: the < 1 wei remainder lands in collateral, never against it. (A NO credit
    // rounds down, so every rounding favours solvency; flooring both let collateral
    // drift short by < 1 wei per YES settlement — found by the batch-3 invariant run.)
    // Every YES-debit computation goes through here, so owed() / previewFunding()
    // agree exactly with what settleFunding records.
    function _yesDebit(uint256 bal, uint256 indexDelta) internal pure returns (uint256) {
        uint256 x = bal * indexDelta;
        return x == 0 ? 0 : (x - 1) / 1e18 + 1;
    }

    // owed() per unit of YES held (1e18-scaled) — the spec's f_now.
    function _owedPerUnit(address user, uint256 yesBal) internal view returns (uint256) {
        return owed(user) * 1e18 / yesBal;
    }

    // ─── core ───────────────────────────────────────────────────────────────────

    // Deposit usdcAmount USDC; receive equal YES and NO tokens 1:1 (Polymarket-style).
    // currentMark is the CLOB price of YES, not the mint ratio.
    function mint(uint256 usdcAmount) external nonReentrant whenNotPaused {
        if (claimable[msg.sender]) revert PositionFrozen();
        if (IERC20(yesToken).totalSupply() + usdcAmount > depositCap) revert DepositCapExceeded();
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcAmount);
        _accrueFunding();
        // Read pre-mint balance before settling so cost basis uses the same snapshot.
        uint256 prevBalance = IERC20(yesToken).balanceOf(msg.sender);
        settleFunding(msg.sender); // settle (pay credit / record debit) before balance increases
        // Weighted-average cost basis: must use pre-mint balance (read above).
        uint256 newBalance = prevBalance + usdcAmount;
        costBasis[msg.sender] = (costBasis[msg.sender] * prevBalance + currentMark * usdcAmount) / newBalance;
        IRestrictedToken(yesToken).mint(msg.sender, usdcAmount);
        IRestrictedToken(noToken).mint(msg.sender, usdcAmount);
        emit TokensMinted(msg.sender, usdcAmount);
    }

    // Burn tokenAmount YES + tokenAmount NO; receive tokenAmount USDC (pre-settlement only).
    // Funding is settled via settleFunding on the full pre-burn balance: any NO-side
    // credit is paid out inside settleFunding; any net YES-side debit is deducted from
    // this payout and stays in collateral — no accretion pool.
    function redeem(uint256 tokenAmount) external nonReentrant whenNotPaused {
        if (creditEventConfirmed) revert CreditEventAlreadyConfirmed();
        if (claimable[msg.sender]) revert PositionFrozen();
        settleFunding(msg.sender);
        IRestrictedToken(yesToken).burn(msg.sender, tokenAmount);
        IRestrictedToken(noToken).burn(msg.sender, tokenAmount);
        // Deducting the recorded debt from the payout keeps that USDC in collateral,
        // which IS the collection — so the ledger is cleared too (post-EDD debt first
        // becomes refundable to the holder, see _takeDebt).
        uint256 debt = fundingDebt(msg.sender);
        uint256 usdcOut = tokenAmount - debt;
        if (debt > 0) _takeDebt(msg.sender, debt);
        IERC20(usdc).safeTransfer(msg.sender, usdcOut);
        emit TokensRedeemed(msg.sender, tokenAmount);
    }

    // Called by OracleRouter after a DC "Yes" on a covered event. Resolves the open
    // motion Yes: post-EDD carry becomes void. Without an open motion the EDD is now
    // (an implicit motion opened and resolved in this call), so nothing is voided —
    // the runbook always opens a motion first.
    function confirmCreditEvent() external onlyRole(ORACLE_ROLE) {
        if (creditEventConfirmed) revert CreditEventAlreadyConfirmed();
        _accrueFunding();
        if (!motionPending) _openMotion();
        uint256 k = motionId;
        motionOutcome[k] = MotionOutcome.Yes;
        motionPending = false;
        creditEventConfirmed = true;
        if (!paused()) _pause();
        emit MotionResolved(k, true);
        emit CreditEventTriggered();
    }

    function _openMotion() internal {
        uint256 k = ++motionId;
        motionIndex[k] = cumulativeFundingPerYES;
        motionOutcome[k] = MotionOutcome.Open;
        emit MotionOpened(k, cumulativeFundingPerYES);
    }

    // Burn YES tokens at 1:1 USDC after a confirmed credit event. NO holders get nothing.
    // Funding settles the same way as redeem: settleFunding pays out any NO-side
    // credit directly; a net YES-side debit is deducted from notional and stays in
    // collateral.
    function settleYES(uint256 amount) external nonReentrant {
        if (!creditEventConfirmed) revert CreditEventNotConfirmed();
        bool wasFlagged = claimable[msg.sender];
        settleFunding(msg.sender); // folds the motion record: post-EDD carry void, refunds paid
        IRestrictedToken(yesToken).burn(msg.sender, amount);
        // Only ordinary (pre-EDD) debt remains after a Yes; deducting it from the payout
        // keeps that USDC in collateral, which IS the collection.
        uint256 debt = _debt[msg.sender];
        uint256 usdcOut = amount - debt;
        _debt[msg.sender] = 0;
        IERC20(usdc).safeTransfer(msg.sender, usdcOut);
        // Auto-cure: settleYES stays open to flagged holders (never confiscate
        // protection about to pay), and settleFunding above already folded the
        // holder's entire live obligation into the payout deduction — the debt is
        // fully collected by construction. Clear the flag so a later claim() can't
        // seize the remaining YES.
        if (wasFlagged) claimable[msg.sender] = false;
        emit YESSettled(msg.sender, amount);
    }

    // ─── funding views ──────────────────────────────────────────────────────────

    function yesFundingOwed(address user) public view returns (uint256) {
        return _yesDebit(IERC20(yesToken).balanceOf(user), cumulativeFundingPerYES - fundingSnapshot[user]);
    }

    function noFundingCredit(address user) public view returns (uint256) {
        return IERC20(noToken).balanceOf(user) * (cumFundingPerNO - snapNO[user]) / 1e18;
    }

    // ─── v1b display-layer views (1e18-scaled, per unit of YES held) ────────────

    // m − f_now, with f_now = owed() per unit (ledger debt + live accrual); floors at 0.
    function equity(address user) public view returns (uint256) {
        uint256 yesBal = IERC20(yesToken).balanceOf(user);
        if (yesBal == 0) return 0;
        uint256 fPerUnit = _owedPerUnit(user, yesBal);
        return currentMark > fPerUnit ? currentMark - fPerUnit : 0;
    }

    // equity − costBasis; negative when mark has fallen or funding has accumulated.
    function pnl(address user) public view returns (int256) {
        return int256(equity(user)) - int256(costBasis[user]);
    }

    // Mark needed so that P&L = 0: costBasis + f_now.
    function breakevenMark(address user) public view returns (uint256) {
        uint256 yesBal = IERC20(yesToken).balanceOf(user);
        if (yesBal == 0) return costBasis[user];
        return costBasis[user] + _owedPerUnit(user, yesBal);
    }

    // Epochs of runway before the seizure trigger fires, holding mark constant. Each
    // epoch adds currentCarryRate × epoch / year of owed per unit.
    // Returns type(uint256).max when already at/past trigger (UI should show "0" / warning).
    function epochsToExpire(address user) public view returns (uint256) {
        uint256 yesBal = IERC20(yesToken).balanceOf(user);
        if (yesBal == 0) return 0;
        uint256 fPerUnit = _owedPerUnit(user, yesBal);
        // m/1.03 via integer arithmetic (*100/103).
        uint256 mDiv103 = currentMark * 100 / 103;
        if (fPerUnit >= mDiv103) return type(uint256).max;
        uint256 numerator = mDiv103 - fPerUnit;
        uint256 deltaF = currentCarryRate * epochLength / 365 days;
        if (deltaF == 0) return type(uint256).max;
        return numerator / deltaF;
    }

    // ─── v1b: seizure trigger ────────────────────────────────────────────────────

    // Returns true when equity is thin enough to warrant seizure.
    // Trigger: m <= 1.03 * f_next, where f_next = f_now + one epoch of accrual (at
    // currentCarryRate) and
    // f_now = owed() per unit — the ledger debt INCLUDED (a trade resets the snapshot
    // but moves the accrued debit into fundingDebt; ignoring it let any trade reset
    // the clock). Evaluated in totals (m×Q vs 1.03×(owed + Q×Δf)) to avoid dividing
    // by the balance. Cost basis is intentionally absent — two holders with the same
    // funding/mark exposure must be equally seizable regardless of entry price.
    function isSeizable(address user) public view returns (bool) {
        uint256 yesBal = IERC20(yesToken).balanceOf(user);
        if (yesBal == 0) return false;
        uint256 m          = currentMark;
        uint256 value      = yesBal * m / 1e18;
        uint256 nextEpoch  = yesBal * (currentCarryRate * epochLength / 365 days) / 1e18;
        return value * 100 <= (owed(user) + nextEpoch) * 103;
    }

    // KEEPER_ROLE: flag a seizable position as claimable. The flag is a LOCK (no
    // mint, redeem, or CLOB trade), not an accounting freeze: funding keeps accruing
    // on the position until it is claimed (priced at claim time from owed()), cured,
    // or settled after a credit event.
    // Runs normally during a motion (invariant 5). Never after a confirmed credit event:
    // the Upbet is about to pay $1, and seizing it would hand the liquidator the
    // holder's payout.
    function flagClaimable(address user) external onlyRole(KEEPER_ROLE) {
        if (creditEventConfirmed) revert CreditEventAlreadyConfirmed();
        if (claimable[user]) revert AlreadyFlagged();
        _accrueFunding();
        if (!isSeizable(user)) revert PositionNotSeizable();
        claimable[user] = true;
        emit FlaggedClaimable(user, _owedPerUnit(user, IERC20(yesToken).balanceOf(user)), block.timestamp);
    }

    // ORACLE_ROLE (the OracleRouter, which forwards the attester's call). true opens a
    // motion when a DC question on the entity appears: it records the EDD index and
    // starts escrowing post-EDD carry. false closes it on a DC "No" (or a declined
    // question): the escrow is released. Blocks nothing. A DC "Yes" goes through
    // confirmCreditEvent instead.
    function setMotionPending(bool pending) external onlyRole(ORACLE_ROLE) {
        if (creditEventConfirmed) revert CreditEventAlreadyConfirmed();
        if (pending == motionPending) revert MotionStateUnchanged();
        _accrueFunding();
        if (pending) {
            _openMotion();
        } else {
            motionOutcome[motionId] = MotionOutcome.No;
            emit MotionResolved(motionId, false);
        }
        motionPending = pending;
        emit MotionPendingSet(pending);
    }

    // LIQUIDATOR_ROLE: called by LiquidationEngine, which has priced the claim from
    // owed(originalHolder) in this same block: the liquidator pays `paid` (P) and, in
    // the tail case, `fund` (the InsuranceFund) tops up owed − P. Fully settles the
    // liquidator's EXISTING position first (YES debit and NO credit, on pre-claim
    // balances), so the seized YES arrives on a fresh snapshot with no back-funding.
    // A flagged address can't be a liquidator: a flagged position is fully locked
    // (invariant 10).
    //
    // During an open motion, P covers the holder's pre-EDD debt first, then post-EDD
    // debt; the post-EDD part each payer covers is recorded as refundable to it if the
    // DC rules Yes (liquidator and InsuranceFund alike).
    function clearLiquidatedPosition(address originalHolder, address liquidator, uint256 paid, address fund)
        external
        onlyRole(LIQUIDATOR_ROLE)
    {
        // A confirmed credit event ends liquidation for good: a flagged holder exits via
        // settleYES (which auto-cures), never by having the paying Upbet seized.
        if (creditEventConfirmed) revert CreditEventAlreadyConfirmed();
        if (claimable[liquidator]) revert PositionFrozen();
        settleFunding(liquidator);

        (uint256 preOwed, uint256 postOwed) = _owedSplit(originalHolder);
        if (postOwed > 0) {
            uint256 byLiquidator = paid > preOwed ? _min(paid - preOwed, postOwed) : 0;
            uint256 byFund = postOwed - byLiquidator;
            if (byLiquidator > 0) {
                _refund[liquidator] += byLiquidator; // its record is the open motion's (settled above)
                emit MotionRefundRecorded(liquidator, motionId, byLiquidator);
            }
            if (byFund > 0) {
                settleFunding(fund); // folds any stale record, puts it on the open motion
                _refund[fund] += byFund;
                emit MotionRefundRecorded(fund, motionId, byFund);
            }
        }

        MotionOutcome o = motionOutcome[userMotion[originalHolder]];
        if (o == MotionOutcome.Open || o == MotionOutcome.No) _motionDebt[originalHolder] = 0; // paid via P
        claimable[originalHolder]       = false;
        _debt[originalHolder]           = 0;
        fundingSnapshot[originalHolder] = cumulativeFundingPerYES;
        // snapNO[originalHolder] and its escrowed credit intentionally left untouched:
        // liquidation touches only the YES side. The holder's NO-side credit keeps accruing against
        // their existing snapshot and pays out at their own next settlement
        // touchpoint (redeem, settleYES, a CLOB sale, or a future cure).
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // Callable by anyone (keeper bot calls every 8 h).
    function accrueFunding() external {
        _accrueFunding();
    }

    // Accrues at the old mark first, then updates. MARK_ROLE only (the mark updater),
    // bounded by maxMarkStep per update and minMarkInterval between updates — a wide
    // circuit breaker against a bad or stolen updater key, not a speed limit.
    function setMark(uint256 newMark) external onlyRole(MARK_ROLE) {
        if (newMark == 0 || newMark >= 1e18) revert InvalidMark();
        if (block.timestamp < lastMarkUpdate + minMarkInterval) revert MarkUpdateTooSoon();
        uint256 step = newMark > currentMark ? newMark - currentMark : currentMark - newMark;
        if (step > maxMarkStep) revert MarkStepTooLarge();
        _setMark(newMark, false);
    }

    // Admin override for the bounds (e.g. a sudden repricing on real news): same
    // validity check, no step/interval limit. DEFAULT_ADMIN_ROLE (the Safe after the
    // role ceremony).
    function adminSetMark(uint256 newMark) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMark == 0 || newMark >= 1e18) revert InvalidMark();
        _setMark(newMark, true);
    }

    function _setMark(uint256 newMark, bool adminOverride) internal {
        _accrueFunding();
        emit MarkUpdated(currentMark, newMark, adminOverride);
        currentMark      = newMark;
        currentCarryRate = carryRateFor(newMark);
        lastMarkUpdate   = block.timestamp;
    }

    function setMarkBounds(uint256 _maxMarkStep, uint256 _minMarkInterval) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_maxMarkStep == 0) revert InvalidMark();
        maxMarkStep     = _maxMarkStep;
        minMarkInterval = _minMarkInterval;
        emit MarkBoundsUpdated(_maxMarkStep, _minMarkInterval);
    }

    // Max outstanding complete sets. Lowering it below the current supply only blocks
    // new mints — it never touches existing positions.
    function setDepositCap(uint256 _depositCap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        depositCap = _depositCap;
        emit DepositCapUpdated(_depositCap);
    }

    // CLOB_ROLE: reduces a user's fundingDebt ledger entry by `amount`. Caller must
    // have already routed that much USDC into collateral (CLOBSettlement's YES-sale
    // path collects the seller's debt pro-rata per fill and transfers it here first).
    // Never erases more than is owed (invariant 9).
    function collectDebt(address user, uint256 amount) external onlyRole(CLOB_ROLE) {
        if (amount > fundingDebt(user)) revert DebtCollectionExceedsDebt();
        _takeDebt(user, amount);
    }

    // "Pay carry": any holder pays their entire live funding obligation (owed(), net of
    // any NO-side credit, per settleFunding's netting) in cash into collateral, and a
    // flag, if set, clears. Open to every holder at any time (batch 4) — it replaces the
    // v2 prepayFunding idea: a holder who keeps carry paid owes ~nothing, so even a
    // falling mark can't push them to the trigger. A flagged holder acts as their own
    // liquidator, keeping the ~3% sliver a claimant would earn.
    // No tokenValue cap and no InsuranceFund involvement: in the tail case (debt >
    // token value) curing is voluntarily overpaying; the rational holder lets claim()
    // handle it instead. Not blocked by pause (it only adds collateral) or by a motion;
    // post-EDD carry paid here is refunded if the DC rules Yes. After a confirmed event
    // settleYES auto-cures instead.
    function cure() external nonReentrant {
        if (creditEventConfirmed) revert CreditEventAlreadyConfirmed();
        settleFunding(msg.sender); // live owed, nets NO credit, resets snapshot
        uint256 debt = fundingDebt(msg.sender);
        if (claimable[msg.sender]) claimable[msg.sender] = false;
        if (debt > 0) {
            _takeDebt(msg.sender, debt); // effects first; the pull below reverts all of it if unpaid
            IERC20(usdc).safeTransferFrom(msg.sender, address(this), debt);
        }
        emit PositionCured(msg.sender, debt);
    }

    // ─── v1b1-2b-1: unified per-user funding settlement (no pool) ───────────────
    // Nets a single user's YES-side debit against their NO-side credit and pays or
    // records the difference directly against locked collateral — no accretion
    // pool, no seller/buyer pairing, no tradePrice coupling. Reusable across a CLOB
    // sale, redeem, or liquidation (each caller decides how/where a debit gets paid).
    //
    // fundingDebt(user) is the persistent ledger for uncollected debits: any prior
    // debt is folded into this call's yesOwed before netting against noCredit, so a
    // debit NEVER disappears just because the snapshot advances (e.g. on a buyer's
    // side of a CLOB trade, or a NO-sale seller's side, where nothing collects cash
    // in the same transaction). It persists in fundingDebt until an explicit
    // collection point clears it: redeem/settleYES deduct it from the payout and
    // zero it out, or CLOB_ROLE calls collectDebt after routing the equivalent
    // USDC into collateral (the YES-sale seller-debit path, pro-rata per fill).
    //
    // No freeze: a flagged holder is charged live accrual exactly like anyone else
    // (a freeze let the paired NO keep earning credit nobody paid for — see
    // docs/security/invariant-findings-2026-09-26.md, F1). Flagged positions can't
    // trade, mint or redeem, so for them this only runs via cure() or settleYES().
    //
    // Batch 4: ordinary debt lives in _debt; while a motion is open, post-EDD carry is
    // escrowed per address (_computeSettlement). fundingDebt(user) is the sum the
    // collection points clear (ordinary first, then post-EDD — _takeDebt).
    //
    // Returns a signed delta: positive = credit paid OUT to `user` now (from
    // collateral); negative = debit now recorded (not lost — see above). The magnitude
    // of a negative delta always equals fundingDebt(user) immediately after this call.
    //
    // Not itself nonReentrant: it is called internally by redeem/settleYES/cure,
    // which are already nonReentrant on their own call frame (OZ's guard is a single
    // per-contract flag, so nesting two nonReentrant functions in one call would
    // revert). External callers (CLOBSettlement, LiquidationEngine) rely on their
    // own contract's guard; USDC is a plain ERC20 with no transfer hooks to reenter through.
    function settleFunding(address user) public returns (int256 delta) {
        _accrueFunding();

        Settlement memory r = _computeSettlement(
            user, IERC20(yesToken).balanceOf(user), IERC20(noToken).balanceOf(user), cumulativeFundingPerYES
        );
        fundingSnapshot[user] = cumulativeFundingPerYES;
        snapNO[user]          = cumFundingPerNO;
        _debt[user]           = r.debt;
        _escrowCredit[user]   = r.escrowCredit;
        _motionDebt[user]     = r.motionDebt;
        uint256 prevRefund = r.folded ? 0 : _refund[user];
        if (r.refund > prevRefund) emit MotionRefundRecorded(user, motionId, r.refund - prevRefund);
        _refund[user]         = r.refund;
        userMotion[user]      = motionPending ? motionId : 0;

        if (r.cashOut > 0) {
            IERC20(usdc).safeTransfer(user, r.cashOut);
            delta = int256(r.cashOut);
        } else {
            delta = -int256(r.debt + r.motionDebt);
        }
        emit FundingSettled(user, delta);
    }

    struct Settlement {
        uint256 cashOut;      // paid to the user now
        uint256 debt;         // new ordinary debt
        uint256 escrowCredit; // new escrowed post-EDD credit
        uint256 motionDebt;   // new post-EDD debt
        uint256 refund;       // new refundable amount
        bool folded;          // a resolved motion's record was folded in
    }

    // The whole settlement as a pure function of state + balances + index, shared by
    // settleFunding (which writes it) and previewFunding (which only reads it).
    //  1. Fold a resolved motion's record: No → escrow becomes credit, post-EDD debt
    //     becomes ordinary debt, refunds lapse; Yes → refunds become credit, escrow and
    //     post-EDD debt are void.
    //  2. Split live accrual at the EDD (_splitDelta). The pre part nets exactly as
    //     before batch 4: credit paid in cash, debit recorded.
    //  3. While a motion is open, the post parts net within the address (neutral: both
    //     resolve the same way) into escrowed credit or post-EDD debt. Ordinary credit
    //     left after ordinary debt pays post-EDD debt — a cash payment, so refundable on
    //     a Yes. Escrowed credit never pays ordinary debt (it may still be cancelled).
    //     After a Yes the post parts are dropped (void).
    function _computeSettlement(address user, uint256 yesBal, uint256 noBal, uint256 idx)
        internal
        view
        returns (Settlement memory r)
    {
        uint256 credit;
        uint256 debit = _debt[user];

        MotionOutcome o = motionOutcome[userMotion[user]];
        if (o == MotionOutcome.No) {
            credit = _escrowCredit[user];
            debit += _motionDebt[user];
            r.folded = true;
        } else if (o == MotionOutcome.Yes) {
            credit = _refund[user];
            r.folded = true;
        } else {
            (r.escrowCredit, r.motionDebt, r.refund) = (_escrowCredit[user], _motionDebt[user], _refund[user]);
        }

        (uint256 yPre, uint256 yPost) = _splitDelta(fundingSnapshot[user], idx);
        debit += _yesDebit(yesBal, yPre);
        yPost = _yesDebit(yesBal, yPost); // now the post-EDD debit amount
        (uint256 nPre, uint256 nPost) = _splitDelta(snapNO[user], idx);
        credit += noBal * nPre / 1e18;
        nPost = noBal * nPost / 1e18;     // now the post-EDD credit amount

        if (motionPending) {
            uint256 inCredit = r.escrowCredit + nPost;
            uint256 inDebit  = r.motionDebt + yPost;
            if (inCredit >= inDebit) {
                (r.escrowCredit, r.motionDebt) = (inCredit - inDebit, 0);
            } else {
                (r.escrowCredit, r.motionDebt) = (0, inDebit - inCredit);
                if (credit > debit) {
                    uint256 pay = _min(credit - debit, r.motionDebt);
                    credit       -= pay;
                    r.motionDebt -= pay;
                    r.refund     += pay;
                }
            }
        }

        if (credit >= debit) r.cashOut = credit - debit;
        else r.debt = debit - credit;
    }

    // Non-mutating twin of settleFunding for off-chain reads (backend pre-filters,
    // frontend quotes), for a hypothetical `amount` held on `side` (isYes) against the
    // user's ACTUAL balance on the other side. Returns cashOut − debtAfter + fundingDebt
    // (the pre-settlement recorded debt), so the off-chain formulas stay exact:
    //   net debit after settling = max(0, fundingDebt − previewFunding)
    //   net carry                = previewFunding − fundingDebt
    // (cashOut > 0 implies no debt remains, so the two never mix.)
    function previewFunding(address user, uint256 amount, bool isYes) external view returns (int256 delta) {
        uint256 yesBal = isYes ? amount : IERC20(yesToken).balanceOf(user);
        uint256 noBal  = isYes ? IERC20(noToken).balanceOf(user) : amount;
        Settlement memory r = _computeSettlement(user, yesBal, noBal, _projectedCumYES());
        delta = int256(r.cashOut) - int256(r.debt + r.motionDebt) + int256(fundingDebt(user));
    }
}
