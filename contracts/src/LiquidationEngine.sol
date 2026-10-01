// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ICreditMarket {
    function claimable(address user) external view returns (bool);
    function motionPending() external view returns (bool);
    function owed(address user) external view returns (uint256);
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
    error ZeroAddress();

    constructor(address _creditMarket, address _insuranceFund) {
        if (_creditMarket == address(0) || _insuranceFund == address(0)) revert ZeroAddress();
        creditMarket  = _creditMarket;
        insuranceFund = _insuranceFund;
    }

    // Claim a seizure-flagged YES position, priced at claim time from the holder's
    // live obligation owed(user) (ledger debt + accrual up to this block — there is
    // no freeze; accrual continues while a flagged position waits to be claimed).
    //
    // Normal case (owed ≤ tokenValue):
    //   Liquidator pays P = owed USDC → to CreditMarket.
    //   Liquidator receives Q YES tokens — the sliver (tokenValue − P) is the liquidator's
    //   profit for executing the seizure; residual is NOT returned to original holder.
    //   The sliver shrinks the longer the position waits: an incentive to claim fast.
    //
    // Tail case (owed > tokenValue — mark gap, or a claim that waited too long):
    //   Liquidator pays P = tokenValue USDC → to CreditMarket.
    //   InsuranceFund covers shortfall (owed − tokenValue) → to CreditMarket.
    //   NO is always made whole regardless of case.
    function claim(address user) external nonReentrant {
        // ── checks ───────────────────────────────────────────────────────────────
        if (!ICreditMarket(creditMarket).claimable(user)) revert NotClaimable();
        if (ICreditMarket(creditMarket).motionPending())  revert MotionPending();

        // ── price from live state (owed() projects accrual to this block) ─────────
        address yesAddr    = ICreditMarket(creditMarket).yesToken();
        address usdcAddr   = ICreditMarket(creditMarket).usdc();
        uint256 Q          = IYESToken(yesAddr).balanceOf(user);
        uint256 m          = ICreditMarket(creditMarket).currentMark();
        uint256 owedTotal  = ICreditMarket(creditMarket).owed(user);
        uint256 tokenValue = Q * m / 1e18;
        bool    tailCase   = owedTotal > tokenValue;
        uint256 P          = tailCase ? tokenValue : owedTotal;

        // ── effects (clear CreditMarket state — YES side only) ────────────────────
        // claim() touches ONLY the YES side: the pricing above already read owed()
        // and is collected via the liquidator's P payment below. We deliberately do
        // NOT call settleFunding(user) here — doing so would net the just-priced
        // debt against the holder's NO-side credit a second time (a double-charge
        // on top of P). The holder's
        // NO-side credit is untouched: their snapNO is left alone by
        // clearLiquidatedPosition and persists to be collected at their own next
        // touchpoint (redeem, settleYES, a CLOB sale, or a cure). No cash is ever
        // pushed to the original holder inside claim() (pull-over-push — a
        // USDC-blacklisted holder must not be able to brick liquidation).
        ICreditMarket(creditMarket).clearLiquidatedPosition(user, msg.sender);

        // ── interactions ──────────────────────────────────────────────────────────
        // Liquidator pays P USDC → CreditMarket (replenishes NO accretion pool).
        IERC20(usdcAddr).safeTransferFrom(msg.sender, creditMarket, P);

        // Tail case: InsuranceFund tops up the shortfall so NO holders are made whole.
        if (tailCase) {
            uint256 shortfall = owedTotal - tokenValue;
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
