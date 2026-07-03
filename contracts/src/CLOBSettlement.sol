// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

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

contract CLOBSettlement is ReentrancyGuard {
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

    event OrderSettled(
        address indexed maker,
        address indexed taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut
    );

    error InvalidSignature();
    error OrderExpired();
    error NonceUsed();
    error MismatchedPair();
    error SlippageExceeded();
    error FundingShortfall();
    error PositionFrozen();

    constructor(address _creditMarket) {
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
    function _settleFundingAndSwap(Order calldata makerOrder, Order calldata takerOrder) private {
        // ── identify seller/buyer and sale type ──────────────────────────────
        // The seller is whichever party sends YES/NO tokens and receives USDC.
        bool makerIsSeller = makerOrder.tokenIn == yesToken || makerOrder.tokenIn == noToken;
        address seller = makerIsSeller ? makerOrder.maker : takerOrder.maker;
        address buyer  = makerIsSeller ? takerOrder.maker : makerOrder.maker;
        bool isYesSale = makerIsSeller
            ? makerOrder.tokenIn == yesToken
            : takerOrder.tokenIn == yesToken;
        uint256 amount     = makerIsSeller ? makerOrder.amountIn : takerOrder.amountIn; // tokens sold
        uint256 tradePrice = makerIsSeller ? takerOrder.amountIn : makerOrder.amountIn; // pure token value

        // A flagged position is fully locked until claimed, cured, or settled
        // post-credit-event: no CLOB trade may move tokens in/out of it either side.
        _requireNotFrozen(seller, buyer);

        // ── funding settlement (v1b1-2b-2: per-user, no pool, no tradePrice
        // coupling) — BEFORE the swap, on each party's full pre-trade balance.
        // A credit (positive delta) is already paid out directly by settleFunding;
        // a debit (negative delta) is only reported here, never pulled.
        int256 sellerDelta = ICreditMarket(creditMarket).settleFunding(seller);
        ICreditMarket(creditMarket).settleFunding(buyer);

        // ── seller proceeds ───────────────────────────────────────────────────
        // tradePrice is pure token value — funding never rides the swap leg except
        // for the one case where the seller's own settleFunding call left them with
        // an outstanding YES-side debit, which must be collected from this trade's
        // proceeds now (Option B): the debit stays in collateral, funded by the
        // buyer's payment, and the sale reverts (position fully unchanged) if the
        // trade doesn't clear high enough to cover it.
        uint256 sellerProceeds  = tradePrice;
        uint256 debtToCollateral = 0;
        if (isYesSale && sellerDelta < 0) {
            uint256 owed = uint256(-sellerDelta);
            if (tradePrice < owed) revert FundingShortfall();
            sellerProceeds   = tradePrice - owed;
            debtToCollateral = owed;
        }

        // ── atomic swap ──────────────────────────────────────────────────────
        // Token leg: seller's tokens move to the buyer.
        IERC20(isYesSale ? yesToken : noToken).safeTransferFrom(seller, buyer, amount);

        // USDC leg: buyer pays sellerProceeds to the seller; any collected debit
        // routes to CreditMarket (collateral) instead of the seller.
        IERC20(usdc).safeTransferFrom(buyer, seller, sellerProceeds);
        if (debtToCollateral > 0) {
            IERC20(usdc).safeTransferFrom(buyer, creditMarket, debtToCollateral);
            // The debt amount now sits in collateral — clear the seller's ledger entry.
            // (Buyer's debit, and a NO-sale seller's debit, are intentionally left
            // uncollected here: they persist in fundingDebt and are collected later
            // at redeem/settleYES/a future YES sale/liquidation.)
            ICreditMarket(creditMarket).markDebtCollected(seller);
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

    // Hoisted into its own frame (rather than inlined) to keep _settleFundingAndSwap's
    // stack shallow enough for solc 0.8.24, which already stack-too-deeps easily here.
    function _requireNotFrozen(address seller, address buyer) private view {
        if (
            ICreditMarket(creditMarket).claimable(seller) ||
            ICreditMarket(creditMarket).claimable(buyer)
        ) revert PositionFrozen();
    }
}
