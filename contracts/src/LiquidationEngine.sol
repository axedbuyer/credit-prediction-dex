// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ICreditMarket {
    function claimable(address user) external view returns (bool);
    function motionPending() external view returns (bool);
    function frozenFunding(address user) external view returns (uint256);
    function fundingDebt(address user) external view returns (uint256);
    function currentMark() external view returns (uint256);
    function yesToken() external view returns (address);
    function usdc() external view returns (address);
    function clearLiquidatedPosition(address originalHolder, address liquidator) external;
}

interface IInsuranceFund {
    function coverShortfall(uint256 amount, address recipient) external;
}

interface IYESToken is IERC20 {
    function forcedTransfer(address from, address to, uint256 amount) external;
}

// Permissionless liquidation of seizure-flagged YES positions.
//
// Roles required at deployment:
//   YESToken.CLOB_ROLE        → this contract  (for forcedTransfer)
//   CreditMarket.LIQUIDATOR_ROLE → this contract  (for clearLiquidatedPosition)
//   InsuranceFund.LIQUIDATOR_ROLE → this contract  (for coverShortfall in tail case)
contract LiquidationEngine is ReentrancyGuard {
    using SafeERC20 for IERC20;

    address public immutable creditMarket;
    address public immutable insuranceFund;

    event Liquidated(
        address indexed originalHolder,
        address indexed liquidator,
        uint256 yesAmount,
        uint256 pricePaid,
        bool    tailCase
    );

    error NotClaimable();
    error MotionPending();

    constructor(address _creditMarket, address _insuranceFund) {
        creditMarket  = _creditMarket;
        insuranceFund = _insuranceFund;
    }

    // Claim a seizure-flagged YES position.
    //
    // Normal case (fFrozenTotal ≤ tokenValue):
    //   Liquidator pays P = fFrozenTotal USDC → to CreditMarket (NO accretion pool).
    //   Liquidator receives Q YES tokens — the sliver (tokenValue − P) is the liquidator's
    //   profit for executing the seizure; residual is NOT returned to original holder.
    //
    // Tail case (fFrozenTotal > tokenValue — mark gap after flag):
    //   Liquidator pays P = tokenValue USDC → to CreditMarket.
    //   InsuranceFund covers shortfall (fFrozenTotal − tokenValue) → to CreditMarket.
    //   NO is always made whole regardless of case.
    function claim(address user) external nonReentrant {
        // ── checks ───────────────────────────────────────────────────────────────
        if (!ICreditMarket(creditMarket).claimable(user)) revert NotClaimable();
        if (ICreditMarket(creditMarket).motionPending())  revert MotionPending();

        // ── read frozen state ─────────────────────────────────────────────────────
        address yesAddr        = ICreditMarket(creditMarket).yesToken();
        address usdcAddr       = ICreditMarket(creditMarket).usdc();
        uint256 Q              = IYESToken(yesAddr).balanceOf(user);
        uint256 m              = ICreditMarket(creditMarket).currentMark();
        uint256 fFrozenPerUnit = ICreditMarket(creditMarket).frozenFunding(user);
        uint256 prevDebt       = ICreditMarket(creditMarket).fundingDebt(user);

        // Total USDC owed by user: accumulated debt (from prior syncs) +
        // per-unit delta since last sync (frozen at flag time) × Q tokens.
        uint256 fFrozenTotal = prevDebt + fFrozenPerUnit * Q / 1e18;
        uint256 tokenValue   = Q * m / 1e18;
        bool    tailCase     = fFrozenTotal > tokenValue;
        uint256 P            = tailCase ? tokenValue : fFrozenTotal;

        // ── effects (clear CreditMarket state, sync liquidator snapshot) ──────────
        ICreditMarket(creditMarket).clearLiquidatedPosition(user, msg.sender);

        // ── interactions ──────────────────────────────────────────────────────────
        // Liquidator pays P USDC → CreditMarket (replenishes NO accretion pool).
        IERC20(usdcAddr).safeTransferFrom(msg.sender, creditMarket, P);

        // Tail case: InsuranceFund tops up the shortfall so NO holders are made whole.
        if (tailCase) {
            uint256 shortfall = fFrozenTotal - tokenValue;
            IInsuranceFund(insuranceFund).coverShortfall(shortfall, creditMarket);
        }

        // Transfer Q YES tokens from original holder to liquidator.
        // Uses forcedTransfer (CLOB_ROLE path) — no holder approval needed.
        // YES tokens are NEVER burned — complete-set invariant (YES.totalSupply() ==
        // NO.totalSupply()) holds before and after every claim.
        IYESToken(yesAddr).forcedTransfer(user, msg.sender, Q);

        emit Liquidated(user, msg.sender, Q, P, tailCase);
    }
}
