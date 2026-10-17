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
    function fundingDebt(address user) external view returns (uint256);

    // v1b1-2b-2: unified per-user funding settlement (no pool, no tradePrice
    // coupling). Nets the user's YES-side debit against their NO-side credit over
    // their FULL current balance, pays a net credit directly from collateral, and
    // returns a signed delta (positive = credit already paid; negative = debit
    // reported but NOT pulled — the caller decides whether/how to collect it).
    function settleFunding(address user) external returns (int256 delta);

    // CLOB_ROLE: reduces fundingDebt[user] by `amount` after the caller has routed
    // that much USDC into collateral (the YES-sale pro-rata debt path below).
    function collectDebt(address user, uint256 amount) external;
}

contract CLOBSettlement is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // Batch 3 (docs/partial-fills-plan.md): orders fill in pieces. Each fill moves
    // `tokens` YES/NO at the MAKER's (resting order's) limit price; every order's
    // progress is tracked on-chain in token units, so an order can fill against any
    // number of counterparties until it is used up, cancelled, or expired. Only
    // OPERATOR_ROLE (the matching engine's settler) may submit fills, so nobody else
    // picks fill sizes, and an off-chain cancel is binding in practice; cancelOrders /
    // setMinNonce are the on-chain guarantee that doesn't depend on the operator.

    struct Order {
        address maker;
        address tokenIn;      // USDC when buying tokens; YES/NO when selling
        address tokenOut;     // YES/NO when buying tokens; USDC when selling
        uint256 amountIn;     // seller: tokens offered; buyer: USDC it will pay at most
        uint256 minAmountOut; // seller: USDC floor; buyer: tokens wanted (with amountIn, the limit price)
        uint256 expiry;
        uint256 nonce;        // unique per maker (salt); must be >= minNonce[maker]
    }

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "Order(address maker,address tokenIn,address tokenOut"
        ",uint256 amountIn,uint256 minAmountOut,uint256 expiry,uint256 nonce)"
    );

    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    address public immutable creditMarket;
    address public immutable usdc;
    address public immutable yesToken;
    address public immutable noToken;
    bytes32 public immutable DOMAIN_SEPARATOR;

    // Tokens filled per order digest (hashOrder). A cancelled order is marked fully
    // filled. remaining = tokenQuantity − filled.
    mapping(bytes32 => uint256) public filled;
    // USDC a BUY order has paid so far (its gross amountIn is a hard cap across all
    // of its fills — the contract never pulls more than a buyer signed for).
    mapping(bytes32 => uint256) public spent;
    // "Cancel everything": an order is void if its nonce < minNonce[maker].
    mapping(address => uint256) public minNonce;

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

    event OrderFilled(
        bytes32 indexed makerOrderHash,
        bytes32 indexed takerOrderHash,
        address indexed seller,
        address buyer,
        address token,       // the YES or NO token traded
        uint256 tokens,      // tokens moved in this fill
        uint256 tradePrice,  // buyer's gross USDC for this fill
        uint256 fee,
        uint256 debtCollected
    );
    event OrderCancelled(bytes32 indexed orderHash, address indexed maker);
    event MinNonceUpdated(address indexed maker, uint256 minNonce);

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
    error OrderInvalidated();     // nonce below the maker's minNonce
    error InvalidOrder();         // zero token size
    error FillExceedsRemaining(); // also: fully filled or cancelled
    error FillTooSmall();         // zero tokens, or the fill prices at 0 USDC
    error MismatchedPair();
    error InvalidTokenPair();
    error SlippageExceeded();
    error FundingShortfall();
    error PositionFrozen();
    error NotOrderMaker();
    error NonceNotIncreasing();
    error ZeroAddress();
    error FeeConfigInvalid();

    constructor(address _creditMarket, address admin) {
        if (_creditMarket == address(0) || admin == address(0)) revert ZeroAddress();
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

    // An order's size in outcome tokens: a seller offers amountIn tokens, a buyer
    // wants minAmountOut tokens. Fills are counted in these units for both sides.
    function tokenQuantity(Order calldata order) public view returns (uint256) {
        return order.tokenIn == usdc ? order.minAmountOut : order.amountIn;
    }

    // Tokens still fillable: 0 once fully filled, cancelled (per order or via
    // minNonce), expired, or — for a buy — once its USDC budget is used up (rounding
    // can exhaust it a few units before the last tokens). Off-chain readers use this
    // to resync after a restart and to recognise a finished order.
    function remaining(Order calldata order) external view returns (uint256) {
        if (block.timestamp > order.expiry || order.nonce < minNonce[order.maker]) return 0;
        bytes32 h = hashOrder(order);
        if (order.tokenIn == usdc && spent[h] >= order.amountIn) return 0;
        uint256 qty = tokenQuantity(order);
        uint256 f = filled[h];
        return f >= qty ? 0 : qty - f;
    }

    // ── cancellation (maker only) ─────────────────────────────────────────────

    function cancelOrders(Order[] calldata orders) external {
        for (uint256 i = 0; i < orders.length; i++) {
            if (orders[i].maker != msg.sender) revert NotOrderMaker();
            bytes32 h = hashOrder(orders[i]);
            filled[h] = tokenQuantity(orders[i]);
            emit OrderCancelled(h, msg.sender);
        }
    }

    // Voids every order of msg.sender with nonce < newMinNonce. Off-chain signers use
    // millisecond-timestamp nonces, so passing "now" cancels everything signed so far.
    function setMinNonce(uint256 newMinNonce) external {
        if (newMinNonce <= minNonce[msg.sender]) revert NonceNotIncreasing();
        minNonce[msg.sender] = newMinNonce;
        emit MinNonceUpdated(msg.sender, newMinNonce);
    }

    // ── fills ─────────────────────────────────────────────────────────────────

    // Trade context lives in one memory struct (a single stack slot) — loose locals
    // blow solc 0.8.24's stack in this function.
    struct Fill {
        bytes32 makerHash;
        bytes32 takerHash;
        address seller;
        address buyer;
        bool    makerIsSeller;
        bool    isYesSale;
        uint256 tokens;
        uint256 tradePrice;      // buyer's gross USDC leg
        uint256 fee;
        uint256 debtShare;       // YES sale: seller's carry debt collected by this fill
        uint256 sellerProceeds;
        bytes32 buyHash;
    }

    /// Fill `tokens` YES/NO between a resting `makerOrder` and a crossing
    /// `takerOrder`, at the maker's limit price. OPERATOR_ROLE only.
    function fillOrders(
        Order calldata makerOrder,
        bytes calldata makerSig,
        Order calldata takerOrder,
        bytes calldata takerSig,
        uint256 tokens
    ) external nonReentrant onlyRole(OPERATOR_ROLE) {
        if (tokens == 0) revert FillTooSmall();
        Fill memory f;
        f.tokens = tokens;
        f.makerHash = _checkOrder(makerOrder, makerSig, tokens);
        f.takerHash = _checkOrder(takerOrder, takerSig, tokens);

        // ── pair: one leg USDC, the other THIS market's YES or NO, opposite sides ──
        if (makerOrder.tokenIn != takerOrder.tokenOut || makerOrder.tokenOut != takerOrder.tokenIn) {
            revert MismatchedPair();
        }
        f.makerIsSeller = makerOrder.tokenOut == usdc;
        address token = f.makerIsSeller ? makerOrder.tokenIn : makerOrder.tokenOut;
        if ((!f.makerIsSeller && makerOrder.tokenIn != usdc) || (token != yesToken && token != noToken)) {
            revert InvalidTokenPair();
        }
        f.isYesSale = token == yesToken;
        Order calldata sell = f.makerIsSeller ? makerOrder : takerOrder;
        Order calldata buy  = f.makerIsSeller ? takerOrder : makerOrder;
        f.seller = sell.maker;
        f.buyer  = buy.maker;
        f.buyHash = f.makerIsSeller ? f.takerHash : f.makerHash;

        _price(f, sell, buy);

        // ── record the fill (checks-effects before interactions) ─────────────
        filled[f.makerHash] += tokens;
        filled[f.takerHash] += tokens;
        spent[f.buyHash] += f.tradePrice;

        _settleFundingAndSwap(f);
    }

    // Signature, expiry, nonce floor, a non-zero token size, and room for `tokens` more.
    // (A seller's minAmountOut may be 0: "sell at any price".)
    function _checkOrder(Order calldata o, bytes calldata sig, uint256 tokens) private view returns (bytes32 h) {
        h = hashOrder(o);
        if (ECDSA.recover(h, sig) != o.maker) revert InvalidSignature();
        if (block.timestamp > o.expiry) revert OrderExpired();
        if (o.nonce < minNonce[o.maker]) revert OrderInvalidated();
        uint256 qty = tokenQuantity(o);
        if (qty == 0) revert InvalidOrder();
        if (filled[h] + tokens > qty) revert FillExceedsRemaining();
    }

    // Prices the fill. What leaves a wallet is capped exactly; rounding (< 1 USDC unit,
    // 1e-6 USDC, per fill) only ever lands on what a party receives — as in
    // Polymarket's CTF Exchange.
    //   buyer cap: min(ceil(tokens × amountIn / minAmountOut), amountIn − spent) — its
    //     limit price for this fill, and never more than its signed amountIn in total
    //     (gross: a NO buyer's amountIn already includes the fee).
    //   price: the MAKER's limit — a resting seller's floor (YES: on the gross; NO, which
    //     is fee-free: the gross that nets it after the buyer-paid fee), or a resting
    //     buyer's cap — rounded in the maker's favour, then clamped to the buyer cap.
    //   seller floor: a YES seller's minAmountOut floors the GROSS tradePrice (fee and
    //     carry debt come out after); a NO seller's floors the NET it receives
    //     (tradePrice − fee). Checked against floor(tokens × minAmountOut / amountIn).
    function _price(Fill memory f, Order calldata sell, Order calldata buy) private view {
        uint256 q = f.tokens;
        uint256 budget = buy.amountIn - spent[f.buyHash]; // spent ≤ amountIn always
        uint256 buyerCap = _ceilDiv(q * buy.amountIn, buy.minAmountOut);
        if (buyerCap > budget) buyerCap = budget;

        uint256 makerPrice;
        if (f.makerIsSeller) {
            uint256 floorUsdc = _ceilDiv(q * sell.minAmountOut, sell.amountIn);
            makerPrice = f.isYesSale ? floorUsdc : _minGrossForNet(floorUsdc, q);
        } else {
            makerPrice = buyerCap;
        }
        f.tradePrice = makerPrice < buyerCap ? makerPrice : buyerCap;
        if (f.tradePrice == 0) revert FillTooSmall();
        f.fee = tradeFee(q, f.tradePrice);

        uint256 sellerBasis = f.isYesSale ? f.tradePrice : f.tradePrice - f.fee;
        if (sellerBasis < q * sell.minAmountOut / sell.amountIn) revert SlippageExceeded();
    }

    function _settleFundingAndSwap(Fill memory f) private {
        // A flagged position is fully locked until claimed, cured, or settled
        // post-credit-event: no CLOB trade may move tokens in/out of it either side.
        _requireNotFrozen(f.seller, f.buyer);

        // ── funding settlement — BEFORE the swap, on each party's full pre-trade
        // balance. A credit is paid out directly by settleFunding; a debit is only
        // recorded in fundingDebt, never pulled here except as below.
        ICreditMarket(creditMarket).settleFunding(f.seller);
        ICreditMarket(creditMarket).settleFunding(f.buyer);

        // ── seller proceeds ───────────────────────────────────────────────────
        // YES sale (Option B, pro-rata per fill): the seller's carry debt is
        // collected in proportion to the share of their YES this fill sells —
        // debtShare = fundingDebt × tokens / YES held (rounded down; selling the
        // last YES collects all of it). The debt per remaining YES is unchanged, so
        // a partial sale never moves the seller's seizure trigger. A fill that can't
        // cover debtShare + fee reverts FundingShortfall with the position unchanged
        // (never liquidated by a sale attempt). Nothing is forgiven: the rest stays
        // in fundingDebt until a later fill, redeem, settleYES, cure or claim.
        f.sellerProceeds = f.tradePrice - f.fee;
        if (f.isYesSale) {
            uint256 debt = ICreditMarket(creditMarket).fundingDebt(f.seller);
            if (debt > 0) {
                uint256 held = IERC20(yesToken).balanceOf(f.seller);
                f.debtShare = f.tokens >= held ? debt : debt * f.tokens / held;
            }
            if (f.tradePrice < f.debtShare + f.fee) revert FundingShortfall();
            f.sellerProceeds = f.tradePrice - f.debtShare - f.fee;
        }

        // ── atomic swap ──────────────────────────────────────────────────────
        IERC20(f.isYesSale ? yesToken : noToken).safeTransferFrom(f.seller, f.buyer, f.tokens);
        IERC20(usdc).safeTransferFrom(f.buyer, f.seller, f.sellerProceeds);
        if (f.debtShare > 0) {
            // The debt share now sits in collateral — reduce the seller's ledger by it.
            // (A buyer's debit, and a NO-sale seller's debit, stay in fundingDebt and
            // are collected later at redeem/settleYES/a future YES sale/liquidation.)
            IERC20(usdc).safeTransferFrom(f.buyer, creditMarket, f.debtShare);
            ICreditMarket(creditMarket).collectDebt(f.seller, f.debtShare);
        }
        if (f.fee > 0) {
            _collectFee(f.buyer, f.isYesSale ? f.seller : f.buyer, f.isYesSale, f.fee);
        }

        emit OrderFilled(
            f.makerHash, f.takerHash, f.seller, f.buyer,
            f.isYesSale ? yesToken : noToken, f.tokens, f.tradePrice, f.fee, f.debtShare
        );
    }

    // Smallest gross G with G − tradeFee(q, G) ≥ net (the exact piecewise inversion
    // mirrored by order-book-server/src/fee.ts minGrossForNet and
    // frontend/lib/feeMath.ts — keep all three in lockstep).
    function _minGrossForNet(uint256 net, uint256 q) private view returns (uint256) {
        if (feeBps == 0 || net == 0) return net;
        // Low branch (G ≤ Q/2, fee = feeBps×G): G ≥ net / (1 − r)
        uint256 lowG = _ceilDiv(net * 10_000, 10_000 - feeBps);
        if (lowG * 2 <= q) return lowG;
        // High branch (G > Q/2, fee = feeBps×(Q−G)): G ≥ (net + r×Q) / (1 + r)
        return _ceilDiv(net * 10_000 + feeBps * q, 10_000 + feeBps);
    }

    function _ceilDiv(uint256 a, uint256 b) private pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
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

    // Hoisted into its own frame to keep _settleFundingAndSwap's stack shallow.
    function _requireNotFrozen(address seller, address buyer) private view {
        if (
            ICreditMarket(creditMarket).claimable(seller) ||
            ICreditMarket(creditMarket).claimable(buyer)
        ) revert PositionFrozen();
    }
}
