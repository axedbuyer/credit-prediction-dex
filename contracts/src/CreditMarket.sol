// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

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

    address public usdc;
    address public yesToken;
    address public noToken;
    uint256 public currentMark;
    bool public creditEventConfirmed;
    bool public motionPending; // true while a credit-event determination is in progress

    uint256 public cumulativeFundingPerYES; // 1e18-scaled; rises monotonically
    uint256 public cumFundingPerNO;         // always equals cumulativeFundingPerYES (complete-set invariant)
    uint256 public lastFundingTime;
    uint256 public epochLength;             // seconds per epoch (used for epochsToExpire)
    mapping(address => uint256) public fundingSnapshot; // YES snapshot per holder
    mapping(address => uint256) public snapNO;          // NO snapshot per holder
    mapping(address => uint256) public fundingDebt;
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

    error CreditEventAlreadyConfirmed();
    error CreditEventNotConfirmed();
    error PositionNotSeizable();
    error AlreadyFlagged();
    error MotionInProgress();
    error PositionFrozen();
    error PositionNotFlagged();
    error ZeroAddress();
    error DepositCapExceeded();
    error InvalidMark();
    error MarkStepTooLarge();
    error MarkUpdateTooSoon();

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
        epochLength = _epochLength;
        lastFundingTime = block.timestamp;
        lastMarkUpdate  = block.timestamp;
    }

    // ─── funding ────────────────────────────────────────────────────────────────

    function _accrueFunding() internal {
        uint256 elapsed = block.timestamp - lastFundingTime;
        if (elapsed == 0) return;
        cumulativeFundingPerYES += currentMark * elapsed / 365 days;
        cumFundingPerNO = cumulativeFundingPerYES; // exact equality; YES.totalSupply()==NO.totalSupply() always
        lastFundingTime = block.timestamp;
        emit FundingAccrued(cumulativeFundingPerYES, cumFundingPerNO, block.timestamp);
    }

    // Index value as of now, without writing it (views project accrual forward).
    function _projectedCumYES() internal view returns (uint256) {
        return cumulativeFundingPerYES + currentMark * (block.timestamp - lastFundingTime) / 365 days;
    }

    // THE single measure of a holder's YES-side funding obligation, used by the
    // seizure trigger, the liquidation claim price, cure, and the display layer:
    // the recorded ledger debt (already net of NO credit at the last settlement)
    // plus live accrual on the current YES balance since the snapshot. There is no
    // freeze — a flag only LOCKS the position; accrual continues until it is
    // claimed, cured, or settled.
    function owed(address user) public view returns (uint256) {
        uint256 yesBal = IERC20(yesToken).balanceOf(user);
        return fundingDebt[user] + yesBal * (_projectedCumYES() - fundingSnapshot[user]) / 1e18;
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
        int256 delta = settleFunding(msg.sender);
        IRestrictedToken(yesToken).burn(msg.sender, tokenAmount);
        IRestrictedToken(noToken).burn(msg.sender, tokenAmount);
        uint256 usdcOut = tokenAmount;
        if (delta < 0) {
            // uint256(-delta) == fundingDebt[msg.sender] right after settleFunding;
            // deducting it from the payout keeps the USDC in collateral, which IS
            // the collection — so the ledger is cleared here too.
            usdcOut -= uint256(-delta);
            fundingDebt[msg.sender] = 0;
        }
        IERC20(usdc).safeTransfer(msg.sender, usdcOut);
        emit TokensRedeemed(msg.sender, tokenAmount);
    }

    // Called by OracleRouter after ISDA credit event determination.
    function confirmCreditEvent() external onlyRole(ORACLE_ROLE) {
        if (creditEventConfirmed) revert CreditEventAlreadyConfirmed();
        creditEventConfirmed = true;
        if (!paused()) _pause();
        emit CreditEventTriggered();
    }

    // Burn YES tokens at 1:1 USDC after a confirmed credit event. NO holders get nothing.
    // Funding settles the same way as redeem: settleFunding pays out any NO-side
    // credit directly; a net YES-side debit is deducted from notional and stays in
    // collateral.
    function settleYES(uint256 amount) external nonReentrant {
        if (!creditEventConfirmed) revert CreditEventNotConfirmed();
        bool wasFlagged = claimable[msg.sender];
        int256 delta = settleFunding(msg.sender);
        IRestrictedToken(yesToken).burn(msg.sender, amount);
        uint256 usdcOut = amount;
        if (delta < 0) {
            // uint256(-delta) == fundingDebt[msg.sender] right after settleFunding;
            // deducting it from the payout keeps the USDC in collateral, which IS
            // the collection — so the ledger is cleared here too.
            usdcOut -= uint256(-delta);
            fundingDebt[msg.sender] = 0;
        }
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
        return IERC20(yesToken).balanceOf(user) * (cumulativeFundingPerYES - fundingSnapshot[user]) / 1e18;
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

    // Epochs of runway before the seizure trigger fires, holding mark constant.
    // Returns type(uint256).max when already at/past trigger (UI should show "0" / warning).
    function epochsToExpire(address user) public view returns (uint256) {
        uint256 yesBal = IERC20(yesToken).balanceOf(user);
        if (yesBal == 0) return 0;
        uint256 fPerUnit = _owedPerUnit(user, yesBal);
        // m/1.03 via integer arithmetic (*100/103).
        uint256 mDiv103 = currentMark * 100 / 103;
        if (fPerUnit >= mDiv103) return type(uint256).max;
        uint256 numerator = mDiv103 - fPerUnit;
        uint256 deltaF = currentMark * epochLength / 365 days;
        if (deltaF == 0) return type(uint256).max;
        return numerator / deltaF;
    }

    // ─── v1b: seizure trigger ────────────────────────────────────────────────────

    // Returns true when equity is thin enough to warrant seizure.
    // Trigger: m <= 1.03 * f_next, where f_next = f_now + one epoch of accrual and
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
        uint256 nextEpoch  = yesBal * (m * epochLength / 365 days) / 1e18;
        return value * 100 <= (owed(user) + nextEpoch) * 103;
    }

    // KEEPER_ROLE: flag a seizable position as claimable. The flag is a LOCK (no
    // mint, redeem, or CLOB trade), not an accounting freeze: funding keeps accruing
    // on the position until it is claimed (priced at claim time from owed()), cured,
    // or settled after a credit event.
    function flagClaimable(address user) external onlyRole(KEEPER_ROLE) {
        if (motionPending) revert MotionInProgress();
        if (claimable[user]) revert AlreadyFlagged();
        _accrueFunding();
        if (!isSeizable(user)) revert PositionNotSeizable();
        claimable[user] = true;
        emit FlaggedClaimable(user, _owedPerUnit(user, IERC20(yesToken).balanceOf(user)), block.timestamp);
    }

    // ORACLE_ROLE: raise or lower the motion-pending flag to freeze liquidation activity
    // during a credit-event determination window.
    function setMotionPending(bool pending) external onlyRole(ORACLE_ROLE) {
        motionPending = pending;
    }

    // LIQUIDATOR_ROLE: called by LiquidationEngine, which has priced the claim from
    // owed(originalHolder) in this same block and collects it from the liquidator.
    // Fully settles the liquidator's EXISTING position first (YES debit and NO
    // credit, on pre-claim balances), so the seized YES arrives on a fresh snapshot
    // with no back-funding. A flagged address can't be a liquidator: a flagged
    // position is fully locked (invariant 10).
    function clearLiquidatedPosition(address originalHolder, address liquidator)
        external
        onlyRole(LIQUIDATOR_ROLE)
    {
        if (claimable[liquidator]) revert PositionFrozen();
        settleFunding(liquidator);

        claimable[originalHolder]       = false;
        fundingDebt[originalHolder]     = 0;
        fundingSnapshot[originalHolder] = cumulativeFundingPerYES;
        // snapNO[originalHolder] intentionally left untouched: liquidation touches
        // only the YES side. The holder's NO-side credit keeps accruing against
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

    // Accrues at the old mark first, then updates. KEEPER_ROLE only, bounded by
    // maxMarkStep per update and minMarkInterval between updates.
    function setMark(uint256 newMark) external onlyRole(KEEPER_ROLE) {
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
        currentMark    = newMark;
        lastMarkUpdate = block.timestamp;
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

    // CLOB_ROLE: clears a user's outstanding fundingDebt ledger entry. Caller must
    // have already routed the equivalent USDC into collateral (e.g. CLOBSettlement's
    // YES-sale seller-debit path, which transfers the debt amount to this contract).
    function markDebtCollected(address user) external onlyRole(CLOB_ROLE) {
        fundingDebt[user] = 0;
    }

    // Flagged holder pays their entire live funding obligation (owed(), net of any
    // NO-side credit, per settleFunding's netting) in cash into collateral and the
    // flag clears. The holder keeps their YES — economically they act as their own
    // liquidator, keeping the ~3% sliver a claimant would otherwise earn.
    // No tokenValue cap and no InsuranceFund involvement: in the tail case (debt >
    // token value) curing is voluntarily overpaying; the rational holder lets claim()
    // handle it instead. Intentionally NOT blocked by motionPending — motion freezes
    // only seizures; curing only ever helps the holder.
    function cure() external nonReentrant whenNotPaused {
        if (!claimable[msg.sender]) revert PositionNotFlagged();
        int256 delta = settleFunding(msg.sender); // live owed, nets NO credit, resets snapshot
        if (delta < 0) {
            IERC20(usdc).safeTransferFrom(msg.sender, address(this), uint256(-delta));
            fundingDebt[msg.sender] = 0;
        }
        claimable[msg.sender] = false;
        emit PositionCured(msg.sender, delta < 0 ? uint256(-delta) : 0);
    }

    // ─── v1b1-2b-1: unified per-user funding settlement (no pool) ───────────────
    // Nets a single user's YES-side debit against their NO-side credit and pays or
    // records the difference directly against locked collateral — no accretion
    // pool, no seller/buyer pairing, no tradePrice coupling. Reusable across a CLOB
    // sale, redeem, or liquidation (each caller decides how/where a debit gets paid).
    //
    // fundingDebt[user] is the persistent ledger for uncollected debits: any prior
    // debt is folded into this call's yesOwed before netting against noCredit, so a
    // debit NEVER disappears just because the snapshot advances (e.g. on a buyer's
    // side of a CLOB trade, or a NO-sale seller's side, where nothing collects cash
    // in the same transaction). It persists in fundingDebt until an explicit
    // collection point clears it: redeem/settleYES deduct it from the payout and
    // zero it out, or CLOB_ROLE calls markDebtCollected after routing the
    // equivalent USDC into collateral (e.g. the YES-sale seller-debit path).
    //
    // No freeze: a flagged holder is charged live accrual exactly like anyone else
    // (a freeze let the paired NO keep earning credit nobody paid for — see
    // docs/security/invariant-findings-2026-09-26.md, F1). Flagged positions can't
    // trade, mint or redeem, so for them this only runs via cure() or settleYES().
    //
    // Returns a signed delta: positive = credit paid OUT to `user` now (from
    // collateral); negative = debit now recorded in fundingDebt[user] (not lost —
    // see above). The magnitude of a negative delta always equals fundingDebt[user]
    // immediately after this call.
    //
    // Not itself nonReentrant: it is called internally by redeem/settleYES/cure,
    // which are already nonReentrant on their own call frame (OZ's guard is a single
    // per-contract flag, so nesting two nonReentrant functions in one call would
    // revert). External callers (CLOBSettlement, LiquidationEngine) rely on their
    // own contract's guard; USDC is a plain ERC20 with no transfer hooks to reenter through.
    function settleFunding(address user) public returns (int256 delta) {
        _accrueFunding();

        uint256 yesBal = IERC20(yesToken).balanceOf(user);
        uint256 noBal  = IERC20(noToken).balanceOf(user);

        uint256 yesOwed = yesBal * (cumulativeFundingPerYES - fundingSnapshot[user]) / 1e18;
        fundingSnapshot[user] = cumulativeFundingPerYES;
        uint256 noCredit = noBal * (cumFundingPerNO - snapNO[user]) / 1e18;
        snapNO[user] = cumFundingPerNO;

        uint256 debit = fundingDebt[user] + yesOwed;

        if (noCredit >= debit) {
            fundingDebt[user] = 0;
            uint256 net = noCredit - debit;
            if (net > 0) IERC20(usdc).safeTransfer(user, net);
            delta = int256(net);
        } else {
            uint256 net = debit - noCredit;
            fundingDebt[user] = net;
            delta = -int256(net);
        }

        emit FundingSettled(user, delta);
    }

    // Non-mutating twin of settleFunding for off-chain reads (backend pre-filters,
    // frontend quotes). Projects the index forward by elapsed time without writing
    // it, and previews the net delta for a hypothetical `amount` traded on `side`
    // (isYes) against the user's ACTUAL balance on the other, offsetting side.
    function previewFunding(address user, uint256 amount, bool isYes) external view returns (int256 delta) {
        uint256 elapsed         = block.timestamp - lastFundingTime;
        uint256 projectedCumYES = cumulativeFundingPerYES + currentMark * elapsed / 365 days;
        uint256 projectedCumNO  = projectedCumYES; // mirrored, always equal

        uint256 yesBal = isYes ? amount : IERC20(yesToken).balanceOf(user);
        uint256 noBal  = isYes ? IERC20(noToken).balanceOf(user) : amount;

        uint256 yesOwed  = yesBal * (projectedCumYES - fundingSnapshot[user]) / 1e18;
        uint256 noCredit = noBal  * (projectedCumNO  - snapNO[user]) / 1e18;

        delta = noCredit > yesOwed
            ? int256(noCredit - yesOwed)
            : -int256(yesOwed - noCredit);
    }
}
