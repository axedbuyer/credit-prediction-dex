// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ICreditMarket {
    function usdc() external view returns (address);
    function yesToken() external view returns (address);
    function noToken() external view returns (address);
    function claimable(address user) external view returns (bool);

    // v1b1-2b-2: unified per-user funding settlement (no pool, no tradePrice
    // coupling). Nets the user's YES-side debit against their NO-side credit over
    // their FULL current balance, pays a net credit directly from collateral, and
    // returns a signed delta (positive = credit already paid; negative = debit
    // reported but NOT pulled — the caller decides whether/how to collect it).
    function settleFunding(address user) external returns (int256 delta);

    // CLOB_ROLE: clears fundingDebt[user] after the caller has routed the
    // equivalent USDC into collateral (e.g. the YES-sale seller-debit path below).
    function markDebtCollected(address user) external;
}

contract CLOBSettlement is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Order {
        address maker;
        address tokenIn;      // USDC when buying tokens; YES/NO when selling
        address tokenOut;     // YES/NO when buying tokens; USDC when selling
        uint256 amountIn;
        uint256 minAmountOut; // slippage guard / encodes limit price
        uint256 expiry;
        uint256 nonce;
    }

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address tokenIn,address tokenOut"
        ",uint256 amountIn,uint256 minAmountOut,uint256 expiry,uint256 nonce)"
    );

    address public immutable creditMarket;
    address public immutable usdc;
    address public immutable yesToken;
    address public immutable noToken;
    bytes32 public immutable DOMAIN_SEPARATOR;

    mapping(address => mapping(uint256 => bool)) public usedNonces;

    // ── trading fee ──────────────────────────────────────────────────────────
    // Charged only on the carry-earning side of a trade: the YES seller and the
    // NO buyer. YES buys and NO sells (flows that take on the funding-paying
    // side) are fee-free by design. fee = feeBps × min(p, 1−p) × Q, where Q
    // tokens carry exactly Q USDC of notional (tokens mint 1:1 with USDC, so
    // `amount` IS the notional). The min(p, 1−p) base makes "buy NO at 1−p"
    // cost the same as the equivalent "mint + sell YES at p" — a flat fee on
    // USDC traded would send everyone around the fee through the mint route.
    uint256 public constant MAX_FEE_BPS = 500;

    uint256 public feeBps;            // fee rate in bps of min(p, 1−p) × Q
    uint256 public insuranceShareBps; // share of each fee routed to insuranceFund
    address public teamWallet;
    address public insuranceFund;

    event OrderSettled(
        address indexed maker,
        address indexed taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    event FeeConfigUpdated(
        uint256 feeBps,
        address teamWallet,
        address insuranceFund,
        uint256 insuranceShareBps
    );
    event FeeCharged(
        address indexed payer,
        bool isYesSale,
        uint256 fee,
        uint256 toInsurance,
        uint256 toTeam
    );

    error InvalidSignature();
    error OrderExpired();
    error NonceUsed();
    error MismatchedPair();
    error SlippageExceeded();
    error FundingShortfall();
    error PositionFrozen();
    error FeeConfigInvalid();

    constructor(address _creditMarket, address admin) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        creditMarket = _creditMarket;
        usdc         = ICreditMarket(_creditMarket).usdc();
        yesToken     = ICreditMarket(_creditMarket).yesToken();
        noToken      = ICreditMarket(_creditMarket).noToken();
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("CLOBSettlement")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // Fee starts at 0 (constructor leaves it unset); admin activates and can
    // retune rate, recipients, and split without a redeploy.
    function setFeeConfig(
        uint256 _feeBps,
        address _teamWallet,
        address _insuranceFund,
        uint256 _insuranceShareBps
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (_feeBps > MAX_FEE_BPS || _insuranceShareBps > 10_000) revert FeeConfigInvalid();
        if (_feeBps > 0 && (_teamWallet == address(0) || _insuranceFund == address(0))) {
            revert FeeConfigInvalid();
        }
        feeBps            = _feeBps;
        teamWallet        = _teamWallet;
        insuranceFund     = _insuranceFund;
        insuranceShareBps = _insuranceShareBps;
        emit FeeConfigUpdated(_feeBps, _teamWallet, _insuranceFund, _insuranceShareBps);
    }

    // fee = feeBps × min(tradePrice, amount − tradePrice) / 10_000.
    // `tradePrice` is the buyer's gross USDC leg, so for NO buys p is measured
    // fee-inclusive — a second-order (feeBps²) deviation from the pure-price
    // formula, accepted to keep the on-chain rule a single deterministic
    // expression that off-chain callers can invert exactly.
    // tradePrice ≥ amount (p ≥ $1) is economically nonsense but signable;
    // there is no (1−p) side to price the fee on, so it clamps to 0.
    function tradeFee(uint256 amount, uint256 tradePrice) public view returns (uint256) {
        if (feeBps == 0 || tradePrice >= amount) return 0;
        uint256 minSide =
            tradePrice < amount - tradePrice ? tradePrice : amount - tradePrice;
        return minSide * feeBps / 10_000;
    }

    // Returns the EIP-712 digest that each party must sign.
    function hashOrder(Order calldata order) public view returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(
            DOMAIN_SEPARATOR,
            keccak256(
                abi.encode(
                    ORDER_TYPEHASH,
                    order.maker,
                    order.tokenIn,
                    order.tokenOut,
                    order.amountIn,
                    order.minAmountOut,
                    order.expiry,
                    order.nonce
                )
            )
        );
    }

    function verifyAndSettle(
        Order calldata makerOrder,
        bytes calldata makerSig,
        Order calldata takerOrder,
        bytes calldata takerSig
    ) external nonReentrant {
        // ── signature verification ───────────────────────────────────────────
        if (ECDSA.recover(hashOrder(makerOrder), makerSig) != makerOrder.maker) {
            revert InvalidSignature();
        }
        if (ECDSA.recover(hashOrder(takerOrder), takerSig) != takerOrder.maker) {
            revert InvalidSignature();
        }

        // ── order validity ───────────────────────────────────────────────────
        if (block.timestamp > makerOrder.expiry) revert OrderExpired();
        if (block.timestamp > takerOrder.expiry) revert OrderExpired();

        // ── nonce freshness ──────────────────────────────────────────────────
        if (usedNonces[makerOrder.maker][makerOrder.nonce]) revert NonceUsed();
        if (usedNonces[takerOrder.maker][takerOrder.nonce]) revert NonceUsed();

        // ── pair compatibility ───────────────────────────────────────────────
        if (
            makerOrder.tokenIn  != takerOrder.tokenOut ||
            makerOrder.tokenOut != takerOrder.tokenIn
        ) revert MismatchedPair();

        // ── slippage guards ──────────────────────────────────────────────────
        if (takerOrder.amountIn < makerOrder.minAmountOut) revert SlippageExceeded();
        if (makerOrder.amountIn < takerOrder.minAmountOut) revert SlippageExceeded();

        // ── mark nonces spent (checks-effects before interactions) ───────────
        usedNonces[makerOrder.maker][makerOrder.nonce] = true;
        usedNonces[takerOrder.maker][takerOrder.nonce] = true;

        _settleFundingAndSwap(makerOrder, takerOrder);
    }

    // Split out of verifyAndSettle to give the funding-settlement + swap logic its
    // own stack frame (the combined function hits "stack too deep" under solc 0.8.24).
    // Trade context lives in one memory struct (a single stack slot) — with the
    // fee fields added, loose locals here blow solc 0.8.24's stack again even
    // after the frame split.
    struct TradeCtx {
        address seller;
        address buyer;
        bool    isYesSale;
        uint256 amount;          // tokens sold
        uint256 tradePrice;      // buyer's gross USDC leg
        uint256 sellerMinOut;    // seller's signed limit (needed net-of-fee on NO sales)
        uint256 fee;
        uint256 sellerProceeds;
        uint256 debtToCollateral;
    }

    function _settleFundingAndSwap(Order calldata makerOrder, Order calldata takerOrder) private {
        // ── identify seller/buyer and sale type ──────────────────────────────
        // The seller is whichever party sends YES/NO tokens and receives USDC.
        bool makerIsSeller = makerOrder.tokenIn == yesToken || makerOrder.tokenIn == noToken;

        TradeCtx memory t;
        t.seller       = makerIsSeller ? makerOrder.maker : takerOrder.maker;
        t.buyer        = makerIsSeller ? takerOrder.maker : makerOrder.maker;
        t.isYesSale    = (makerIsSeller ? makerOrder.tokenIn : takerOrder.tokenIn) == yesToken;
        t.amount       = makerIsSeller ? makerOrder.amountIn : takerOrder.amountIn;
        t.tradePrice   = makerIsSeller ? takerOrder.amountIn : makerOrder.amountIn;
        t.sellerMinOut = makerIsSeller ? makerOrder.minAmountOut : takerOrder.minAmountOut;

        // A flagged position is fully locked until claimed, cured, or settled
        // post-credit-event: no CLOB trade may move tokens in/out of it either side.
        _requireNotFrozen(t.seller, t.buyer);

        // ── funding settlement (v1b1-2b-2: per-user, no pool, no tradePrice
        // coupling) — BEFORE the swap, on each party's full pre-trade balance.
        // A credit (positive delta) is already paid out directly by settleFunding;
        // a debit (negative delta) is only reported here, never pulled.
        int256 sellerDelta = ICreditMarket(creditMarket).settleFunding(t.seller);
        ICreditMarket(creditMarket).settleFunding(t.buyer);

        // ── trading fee ──────────────────────────────────────────────────────
        // Fee-paying side is whoever moves toward the carry-earning side: the
        // YES seller (fee joins the funding debit as a deduction from proceeds)
        // or the NO buyer (fee rides inside their signed amountIn — the contract
        // can never pull USDC beyond what a party signed for).
        t.fee = tradeFee(t.amount, t.tradePrice);

        // ── seller proceeds ───────────────────────────────────────────────────
        // tradePrice is pure token value — funding never rides the swap leg except
        // for the one case where the seller's own settleFunding call left them with
        // an outstanding YES-side debit, which must be collected from this trade's
        // proceeds now (Option B): the debit stays in collateral, funded by the
        // buyer's payment, and the sale reverts (position fully unchanged) if the
        // trade doesn't clear high enough to cover it. The fee extends that
        // safeguard: a YES sale that can't cover debit + fee reverts the same way.
        t.sellerProceeds = t.tradePrice - t.fee;
        if (t.isYesSale) {
            uint256 owed = sellerDelta < 0 ? uint256(-sellerDelta) : 0;
            if (t.tradePrice < owed + t.fee) revert FundingShortfall();
            t.sellerProceeds   = t.tradePrice - owed - t.fee;
            t.debtToCollateral = owed;
        } else if (t.fee > 0) {
            // NO sale: the buyer pays the fee, so the fee-free seller's limit
            // must be honored NET of it — the gross check in verifyAndSettle is
            // necessary but not sufficient here.
            if (t.sellerProceeds < t.sellerMinOut) revert SlippageExceeded();
        }

        // ── atomic swap ──────────────────────────────────────────────────────
        // Token leg: seller's tokens move to the buyer.
        IERC20(t.isYesSale ? yesToken : noToken).safeTransferFrom(t.seller, t.buyer, t.amount);

        // USDC leg: buyer pays sellerProceeds to the seller; any collected debit
        // routes to CreditMarket (collateral) instead of the seller.
        IERC20(usdc).safeTransferFrom(t.buyer, t.seller, t.sellerProceeds);
        if (t.debtToCollateral > 0) {
            IERC20(usdc).safeTransferFrom(t.buyer, creditMarket, t.debtToCollateral);
            // The debt amount now sits in collateral — clear the seller's ledger entry.
            // (Buyer's debit, and a NO-sale seller's debit, are intentionally left
            // uncollected here: they persist in fundingDebt and are collected later
            // at redeem/settleYES/a future YES sale/liquidation.)
            ICreditMarket(creditMarket).markDebtCollected(t.seller);
        }
        if (t.fee > 0) {
            _collectFee(t.buyer, t.isYesSale ? t.seller : t.buyer, t.isYesSale, t.fee);
        }

        emit OrderSettled(
            makerOrder.maker,
            takerOrder.maker,
            makerOrder.tokenIn,
            makerOrder.tokenOut,
            makerOrder.amountIn,
            takerOrder.amountIn
        );
    }

    // The fee is always pulled from the buyer's USDC as part of the trade's USDC
    // leg — on a YES sale it's the slice of the buyer's payment carved out of the
    // seller's proceeds (the seller is the payer); on a NO sale it's the slice of
    // the buyer's signed amountIn on top of what the seller receives (the buyer
    // is the payer). Fees never touch CreditMarket collateral.
    function _collectFee(address buyer, address payer, bool isYesSale, uint256 fee) private {
        uint256 toInsurance = fee * insuranceShareBps / 10_000;
        uint256 toTeam      = fee - toInsurance;
        if (toInsurance > 0) IERC20(usdc).safeTransferFrom(buyer, insuranceFund, toInsurance);
        if (toTeam > 0)      IERC20(usdc).safeTransferFrom(buyer, teamWallet, toTeam);
        emit FeeCharged(payer, isYesSale, fee, toInsurance, toTeam);
    }

    // Hoisted into its own frame (rather than inlined) to keep _settleFundingAndSwap's
    // stack shallow enough for solc 0.8.24, which already stack-too-deeps easily here.
    function _requireNotFrozen(address seller, address buyer) private view {
        if (
            ICreditMarket(creditMarket).claimable(seller) ||
            ICreditMarket(creditMarket).claimable(buyer)
        ) revert PositionFrozen();
    }
}
