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
    mapping(address => bool)    public claimable;       // true once keeper flags position
    mapping(address => uint256) public frozenFunding;   // per-unit index delta frozen at flag time
    uint256 public noAccretionPool;                     // total USDC credited to NO holders, unclaimed

    event TokensMinted(address indexed user, uint256 amount);
    event TokensRedeemed(address indexed user, uint256 tokenAmount);
    event YESSettled(address indexed user, uint256 amount);
    event CreditEventTriggered();
    event FundingAccrued(uint256 cumulativeFundingPerYES, uint256 cumFundingPerNO, uint256 timestamp);
    event FlaggedClaimable(address indexed user, uint256 frozenFundingPerUnit, uint256 timestamp);
    event FundingSettledOnSale(
        address indexed seller,
        address indexed buyer,
        bool    isYesSale,
        uint256 amount,
        uint256 sellerAdjustment,
        bool    isCredit
    );

    error CreditEventAlreadyConfirmed();
    error CreditEventNotConfirmed();
    error PositionNotSeizable();
    error AlreadyFlagged();
    error MotionInProgress();
    error FundingShortfall();

    constructor(
        address admin,
        address _usdc,
        address _yesToken,
        address _noToken,
        uint256 _initialMark,
        uint256 _epochLength
    ) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        usdc = _usdc;
        yesToken = _yesToken;
        noToken = _noToken;
        currentMark = _initialMark;
        epochLength = _epochLength;
        lastFundingTime = block.timestamp;
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

    function _syncUserFunding(address user) internal {
        if (claimable[user]) return; // position frozen pending liquidation claim
        uint256 delta = cumulativeFundingPerYES - fundingSnapshot[user];
        if (delta > 0) {
            uint256 balance = IERC20(yesToken).balanceOf(user);
            fundingDebt[user] += balance * delta / 1e18;
        }
        fundingSnapshot[user] = cumulativeFundingPerYES;
        snapNO[user] = cumFundingPerNO;
    }

    // ─── core ───────────────────────────────────────────────────────────────────

    // Deposit usdcAmount USDC; receive equal YES and NO tokens 1:1 (Polymarket-style).
    // currentMark is the CLOB price of YES, not the mint ratio.
    function mint(uint256 usdcAmount) external nonReentrant whenNotPaused {
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcAmount);
        _accrueFunding();
        // Read pre-mint balance before sync so cost basis uses the same snapshot.
        uint256 prevBalance = IERC20(yesToken).balanceOf(msg.sender);
        _syncUserFunding(msg.sender); // sync before balance increases
        // Weighted-average cost basis: must use pre-mint balance (read above).
        uint256 newBalance = prevBalance + usdcAmount;
        costBasis[msg.sender] = (costBasis[msg.sender] * prevBalance + currentMark * usdcAmount) / newBalance;
        IRestrictedToken(yesToken).mint(msg.sender, usdcAmount);
        IRestrictedToken(noToken).mint(msg.sender, usdcAmount);
        emit TokensMinted(msg.sender, usdcAmount);
    }

    // Burn tokenAmount YES + tokenAmount NO; receive tokenAmount USDC (pre-settlement only).
    // Accrued funding debt is deducted from the USDC payout (capped at tokenAmount).
    function redeem(uint256 tokenAmount) external nonReentrant whenNotPaused {
        if (creditEventConfirmed) revert CreditEventAlreadyConfirmed();
        _accrueFunding();
        _syncUserFunding(msg.sender); // sync before balance decreases
        uint256 debt = fundingDebt[msg.sender];
        uint256 deduction = debt > tokenAmount ? tokenAmount : debt;
        fundingDebt[msg.sender] = 0;
        IRestrictedToken(yesToken).burn(msg.sender, tokenAmount);
        IRestrictedToken(noToken).burn(msg.sender, tokenAmount);
        IERC20(usdc).safeTransfer(msg.sender, tokenAmount - deduction);
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
    function settleYES(uint256 amount) external nonReentrant {
        if (!creditEventConfirmed) revert CreditEventNotConfirmed();
        IRestrictedToken(yesToken).burn(msg.sender, amount);
        IERC20(usdc).safeTransfer(msg.sender, amount);
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

    // m − f_now (unsettled per-unit funding since last sync); floors at 0 for display safety.
    function equity(address user) public view returns (uint256) {
        if (IERC20(yesToken).balanceOf(user) == 0) return 0;
        uint256 fPerUnit = cumulativeFundingPerYES - fundingSnapshot[user];
        return currentMark > fPerUnit ? currentMark - fPerUnit : 0;
    }

    // equity − costBasis; negative when mark has fallen or funding has accumulated.
    function pnl(address user) public view returns (int256) {
        return int256(equity(user)) - int256(costBasis[user]);
    }

    // Mark needed so that P&L = 0: costBasis + f_now.
    function breakevenMark(address user) public view returns (uint256) {
        return costBasis[user] + (cumulativeFundingPerYES - fundingSnapshot[user]);
    }

    // Epochs of runway before the seizure trigger fires, holding mark constant.
    // Returns type(uint256).max when already at/past trigger (UI should show "0" / warning).
    function epochsToExpire(address user) public view returns (uint256) {
        if (IERC20(yesToken).balanceOf(user) == 0) return 0;
        uint256 fPerUnit = cumulativeFundingPerYES - fundingSnapshot[user];
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
    // Trigger: m <= 1.03 * f_next, where f_next = f_now + one epoch of accrual.
    // Cost basis is intentionally absent — two holders with the same funding/mark
    // exposure must be equally seizable regardless of their entry price.
    function isSeizable(address user) public view returns (bool) {
        if (IERC20(yesToken).balanceOf(user) == 0) return false;
        uint256 fNow   = cumulativeFundingPerYES - fundingSnapshot[user]; // per-unit, 1e18-scaled
        uint256 m      = currentMark;
        uint256 deltaF = m * epochLength / 365 days;
        uint256 fNext  = fNow + deltaF;
        return m <= (fNext * 103) / 100;
    }

    // KEEPER_ROLE: flag a seizable position as claimable and freeze its per-unit f_now.
    // After flagging, _syncUserFunding skips this user — no further accrual until claimed.
    function flagClaimable(address user) external onlyRole(KEEPER_ROLE) {
        if (motionPending) revert MotionInProgress();
        if (!isSeizable(user)) revert PositionNotSeizable();
        if (claimable[user]) revert AlreadyFlagged();
        _accrueFunding(); // update global index before snapshotting frozen value
        claimable[user]      = true;
        frozenFunding[user]  = cumulativeFundingPerYES - fundingSnapshot[user];
        emit FlaggedClaimable(user, frozenFunding[user], block.timestamp);
    }

    // ORACLE_ROLE: raise or lower the motion-pending flag to freeze liquidation activity
    // during a credit-event determination window.
    function setMotionPending(bool pending) external onlyRole(ORACLE_ROLE) {
        motionPending = pending;
    }

    // LIQUIDATOR_ROLE: called by LiquidationEngine after verifying payment and transfer.
    // Syncs the liquidator's existing YES position first (no back-funding on seized tokens),
    // then clears all frozen state for the original holder.
    function clearLiquidatedPosition(address originalHolder, address liquidator)
        external
        onlyRole(LIQUIDATOR_ROLE)
    {
        _accrueFunding();
        _syncUserFunding(liquidator); // settle liquidator's pre-existing YES debt

        claimable[originalHolder]       = false;
        frozenFunding[originalHolder]   = 0;
        fundingDebt[originalHolder]     = 0;
        fundingSnapshot[originalHolder] = cumulativeFundingPerYES;
        snapNO[originalHolder]          = cumFundingPerNO;
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

    // Accrues at the old mark first, then updates. KEEPER_ROLE only.
    function setMark(uint256 newMark) external onlyRole(KEEPER_ROLE) {
        _accrueFunding();
        currentMark = newMark;
    }

    // Called by CLOBSettlement before each trade to capture carry on pre-trade balances.
    function syncUserFunding(address user) external onlyRole(CLOB_ROLE) {
        _accrueFunding();
        _syncUserFunding(user);
    }

    // ─── v1b: CLOB funding settlement hook (Model 1) ────────────────────────────
    // On every CLOB sale, accrued funding settles to/from the SELLER and both
    // parties' snapshots reset to now. NO sale credits the seller (paid from the
    // accretion pool); YES sale debits the seller (owed routes to NO accretion).
    // amount/tradePrice/owed/credit are all TOTAL USDC amounts, never per-unit.

    function _creditNOAccretion(uint256 amount) internal {
        noAccretionPool += amount;
    }

    function _debitNOAccretion(uint256 amount) internal {
        noAccretionPool -= amount;
    }

    function settleFundingOnSale(
        address seller,
        address buyer,
        bool    isYesSale,
        uint256 amount,
        uint256 tradePrice
    ) external onlyRole(CLOB_ROLE) returns (uint256 sellerAdjustment, bool isCredit) {
        _accrueFunding();
        if (isYesSale) {
            uint256 owed = amount * (cumulativeFundingPerYES - fundingSnapshot[seller]) / 1e18;
            if (tradePrice < owed) revert FundingShortfall();
            _creditNOAccretion(owed);
            fundingSnapshot[seller] = cumulativeFundingPerYES;
            fundingSnapshot[buyer]  = cumulativeFundingPerYES;
            emit FundingSettledOnSale(seller, buyer, true, amount, owed, false);
            return (owed, false);
        } else {
            uint256 credit = amount * (cumFundingPerNO - snapNO[seller]) / 1e18;
            _debitNOAccretion(credit);
            snapNO[seller] = cumFundingPerNO;
            snapNO[buyer]  = cumFundingPerNO;
            emit FundingSettledOnSale(seller, buyer, false, amount, credit, true);
            return (credit, true);
        }
    }
}
