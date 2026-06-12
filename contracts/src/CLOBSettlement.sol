// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface ICreditMarket {
    function syncUserFunding(address user) external;
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

    constructor(address _creditMarket) {
        creditMarket = _creditMarket;
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

        // ── funding sync (before balances change) ────────────────────────────
        ICreditMarket(creditMarket).syncUserFunding(makerOrder.maker);
        ICreditMarket(creditMarket).syncUserFunding(takerOrder.maker);

        // ── mark nonces spent (checks-effects before interactions) ───────────
        usedNonces[makerOrder.maker][makerOrder.nonce] = true;
        usedNonces[takerOrder.maker][takerOrder.nonce] = true;

        // ── atomic swap ──────────────────────────────────────────────────────
        uint256 amountOut = takerOrder.amountIn;
        IERC20(makerOrder.tokenIn).safeTransferFrom(
            makerOrder.maker, takerOrder.maker, makerOrder.amountIn
        );
        IERC20(takerOrder.tokenIn).safeTransferFrom(
            takerOrder.maker, makerOrder.maker, takerOrder.amountIn
        );

        emit OrderSettled(
            makerOrder.maker,
            takerOrder.maker,
            makerOrder.tokenIn,
            makerOrder.tokenOut,
            makerOrder.amountIn,
            amountOut
        );
    }
}
