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

    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");
    bytes32 public constant CLOB_ROLE   = keccak256("CLOB_ROLE");

    address public usdc;
    address public yesToken;
    address public noToken;
    uint256 public currentMark;
    bool public creditEventConfirmed;

    uint256 public cumulativeFundingPerYES; // 1e18-scaled; rises monotonically
    uint256 public lastFundingTime;
    mapping(address => uint256) public fundingSnapshot;
    mapping(address => uint256) public fundingDebt;

    event TokensMinted(address indexed user, uint256 usdcAmount, uint256 yesAmount, uint256 noAmount);
    event TokensRedeemed(address indexed user, uint256 tokenAmount);
    event YESSettled(address indexed user, uint256 amount);
    event CreditEventTriggered();
    event FundingAccrued(uint256 cumulativeFundingPerYES, uint256 timestamp);

    error CreditEventAlreadyConfirmed();
    error CreditEventNotConfirmed();

    constructor(
        address admin,
        address _usdc,
        address _yesToken,
        address _noToken,
        uint256 _initialMark
    ) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        usdc = _usdc;
        yesToken = _yesToken;
        noToken = _noToken;
        currentMark = _initialMark;
        lastFundingTime = block.timestamp;
    }

    // ─── funding ────────────────────────────────────────────────────────────────

    function _accrueFunding() internal {
        uint256 elapsed = block.timestamp - lastFundingTime;
        if (elapsed == 0) return;
        cumulativeFundingPerYES += currentMark * elapsed / 365 days;
        lastFundingTime = block.timestamp;
        emit FundingAccrued(cumulativeFundingPerYES, block.timestamp);
    }

    function _syncUserFunding(address user) internal {
        uint256 delta = cumulativeFundingPerYES - fundingSnapshot[user];
        if (delta > 0) {
            uint256 balance = IERC20(yesToken).balanceOf(user);
            fundingDebt[user] += balance * delta / 1e18;
        }
        fundingSnapshot[user] = cumulativeFundingPerYES;
    }

    // ─── core ───────────────────────────────────────────────────────────────────

    // Deposit usdcAmount USDC; receive YES and NO tokens split at currentMark.
    function mint(uint256 usdcAmount) external nonReentrant whenNotPaused {
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), usdcAmount);
        _accrueFunding();
        _syncUserFunding(msg.sender); // sync before balance increases
        uint256 yesAmount = usdcAmount * currentMark / 1e18;
        uint256 noAmount = usdcAmount - yesAmount; // subtraction avoids rounding dust
        IRestrictedToken(yesToken).mint(msg.sender, yesAmount);
        IRestrictedToken(noToken).mint(msg.sender, noAmount);
        emit TokensMinted(msg.sender, usdcAmount, yesAmount, noAmount);
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
}
