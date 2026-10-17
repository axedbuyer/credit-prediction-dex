// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {YESToken} from "../src/YESToken.sol";
import {NOToken} from "../src/NOToken.sol";
import {CreditMarket} from "../src/CreditMarket.sol";
import {CLOBSettlement} from "../src/CLOBSettlement.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract CLOBSettlementTest is Test {
    MockUSDC usdc;
    YESToken yesToken;
    NOToken noToken;
    CreditMarket market;
    CLOBSettlement clob;

    address admin = address(this);

    // Accounts with known private keys so vm.sign works.
    uint256 makerKey = 0xA11CE;
    uint256 takerKey = 0xB0B;
    address maker;
    address taker;

    function setUp() public {
        maker = vm.addr(makerKey);
        taker = vm.addr(takerKey);

        usdc     = new MockUSDC();
        yesToken = new YESToken(admin, "YES", "YES");
        noToken  = new NOToken(admin, "NO", "NO");
        market   = new CreditMarket(
            admin, address(usdc), address(yesToken), address(noToken), 0.23e18, 1 days
        );
        clob = new CLOBSettlement(address(market), admin);
        clob.grantRole(clob.OPERATOR_ROLE(), admin);

        // Wire token roles for CreditMarket
        yesToken.grantRole(yesToken.MINTER_ROLE(), address(market));
        yesToken.grantRole(yesToken.BURNER_ROLE(), address(market));
        noToken.grantRole(noToken.MINTER_ROLE(), address(market));
        noToken.grantRole(noToken.BURNER_ROLE(), address(market));

        // Grant CLOB_ROLE on tokens so CLOBSettlement can transferFrom YES/NO
        yesToken.grantRole(yesToken.CLOB_ROLE(), address(clob));
        noToken.grantRole(noToken.CLOB_ROLE(),  address(clob));

        // Grant CLOB_ROLE on market so CLOBSettlement can call syncUserFunding
        market.grantRole(market.CLOB_ROLE(), address(clob));

        // Give maker USDC and taker YES + NO tokens (direct mint for test setup)
        usdc.mint(maker, 10_000e18);
        yesToken.grantRole(yesToken.MINTER_ROLE(), admin);
        noToken.grantRole(noToken.MINTER_ROLE(), admin);
        yesToken.mint(taker, 1_000e18);
        noToken.mint(taker, 1_000e18);

        // Approvals: both parties approve the CLOB contract for all tokens
        vm.startPrank(maker);
        usdc.approve(address(clob), type(uint256).max);
        yesToken.approve(address(clob), type(uint256).max);
        noToken.approve(address(clob), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(taker);
        usdc.approve(address(clob), type(uint256).max);
        yesToken.approve(address(clob), type(uint256).max);
        noToken.approve(address(clob), type(uint256).max);
        vm.stopPrank();
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    function _order(
        address _maker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 expiry,
        uint256 nonce
    ) internal pure returns (CLOBSettlement.Order memory) {
        return CLOBSettlement.Order({
            maker: _maker,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: minAmountOut,
            expiry: expiry,
            nonce: nonce
        });
    }

    // vm.sign returns (v, r, s); OZ ECDSA expects r || s || v (65 bytes).
    function _sign(uint256 key, CLOBSettlement.Order memory order)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = clob.hashOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // ── tests ─────────────────────────────────────────────────────────────────

    function test_ValidYESBuy_Settles() public {
        uint256 usdcIn  = 100e18;
        uint256 yesOut  = 80e18;
        uint256 expiry  = block.timestamp + 1 hours;

        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), usdcIn, yesOut, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), yesOut, usdcIn, expiry, 0
        );

        uint256 makerUsdcBefore = usdc.balanceOf(maker);
        uint256 takerYesBefore  = yesToken.balanceOf(taker);

        clob.fillOrders(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_), _qty(mo));

        assertEq(usdc.balanceOf(maker),     makerUsdcBefore - usdcIn, "maker paid USDC");
        assertEq(yesToken.balanceOf(maker), yesOut,                   "maker received YES");
        assertEq(yesToken.balanceOf(taker), takerYesBefore - yesOut,  "taker gave YES");
        assertEq(usdc.balanceOf(taker),     usdcIn,                   "taker received USDC");
        assertEq(clob.filled(clob.hashOrder(mo)), yesOut, "maker order fully filled");
        assertEq(clob.filled(clob.hashOrder(to_)), yesOut, "taker order fully filled");
    }

    function test_ValidNOBuy_Settles() public {
        uint256 usdcIn = 100e18;
        uint256 noOut  = 150e18;
        uint256 expiry = block.timestamp + 1 hours;

        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(noToken), usdcIn, noOut, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(noToken), address(usdc), noOut, usdcIn, expiry, 0
        );

        uint256 makerUsdcBefore = usdc.balanceOf(maker);
        uint256 takerNoBefore   = noToken.balanceOf(taker);

        clob.fillOrders(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_), _qty(mo));

        assertEq(usdc.balanceOf(maker),    makerUsdcBefore - usdcIn, "maker paid USDC");
        assertEq(noToken.balanceOf(maker), noOut,                    "maker received NO");
        assertEq(noToken.balanceOf(taker), takerNoBefore - noOut,    "taker gave NO");
        assertEq(usdc.balanceOf(taker),    usdcIn,                   "taker received USDC");
    }

    function test_ExpiredOrder_Reverts() public {
        uint256 pastExpiry = block.timestamp - 1;
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 100e18, 80e18, pastExpiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 80e18, 100e18, block.timestamp + 1 hours, 0
        );
        // Compute sigs before vm.expectRevert — _sign calls clob.hashOrder (external call)
        // which would otherwise consume the revert expectation before verifyAndSettle runs.
        bytes memory ms = _sign(makerKey, mo);
        bytes memory ts = _sign(takerKey, to_);

        vm.expectRevert(CLOBSettlement.OrderExpired.selector);
        clob.fillOrders(mo, ms, to_, ts, _qty(mo));
    }

    function test_WrongSignature_Reverts() public {
        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 100e18, 80e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 80e18, 100e18, expiry, 0
        );
        bytes memory wrongSig = _sign(takerKey, mo); // taker signs maker's order
        bytes memory ts       = _sign(takerKey, to_);

        vm.expectRevert(CLOBSettlement.InvalidSignature.selector);
        clob.fillOrders(mo, wrongSig, to_, ts, _qty(mo));
    }

    function test_ReplayFilledPair_Reverts() public {
        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 100e18, 80e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 80e18, 100e18, expiry, 0
        );
        bytes memory ms = _sign(makerKey, mo);
        bytes memory ts = _sign(takerKey, to_);

        clob.fillOrders(mo, ms, to_, ts, _qty(mo));

        // Replaying a fully filled pair must fail.
        vm.expectRevert(CLOBSettlement.FillExceedsRemaining.selector);
        clob.fillOrders(mo, ms, to_, ts, _qty(mo));
    }

    function test_MismatchedPair_Reverts() public {
        uint256 expiry = block.timestamp + 1 hours;
        // Both orders buy YES — tokenIn/tokenOut don't complement each other.
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 100e18, 80e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(usdc), address(yesToken), 100e18, 80e18, expiry, 0
        );
        bytes memory ms = _sign(makerKey, mo);
        bytes memory ts = _sign(takerKey, to_);

        vm.expectRevert(CLOBSettlement.MismatchedPair.selector);
        clob.fillOrders(mo, ms, to_, ts, _qty(mo));
    }

    function test_FundingSyncedOnSettle() public {
        // Taker holds 1000 YES *and* 1000 NO (the matched pair from setUp) for a
        // year, then sells 80 YES to maker. settleFunding nets taker's full YES
        // debit against his full NO credit (same balance, same mirrored index) —
        // they cancel exactly, so the sale clears at pure tradePrice with no
        // deduction, and the settle still resets every snapshot to now.

        vm.warp(block.timestamp + 365 days);

        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 100e18, 80e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 80e18, 100e18, expiry, 0
        );

        uint256 takerUsdcBefore = usdc.balanceOf(taker);

        clob.fillOrders(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_), _qty(mo));

        // After 1 year at a 23% mark: cumulativeFundingPerYES = one year of carry at
        // carryRateFor(0.23e18) ≈ 0.2013e18 (exact over a whole year).
        uint256 expectedCumulative = market.currentCarryRate() * 365 days / 365 days;
        assertEq(market.cumulativeFundingPerYES(), expectedCumulative, "cumulative accrued");
        assertEq(market.cumFundingPerNO(), expectedCumulative, "mirrored NO index accrued");

        // settleFunding resets BOTH the YES and NO snapshot for both parties.
        assertEq(market.fundingSnapshot(taker), expectedCumulative, "seller YES snapshot reset");
        assertEq(market.snapNO(taker),          expectedCumulative, "seller NO snapshot reset");
        assertEq(market.fundingSnapshot(maker), expectedCumulative, "buyer YES snapshot reset");
        assertEq(market.snapNO(maker),          expectedCumulative, "buyer NO snapshot reset");

        // Held pair nets to zero -> taker receives the full tradePrice, no deduction.
        assertEq(usdc.balanceOf(taker), takerUsdcBefore + 100e18, "seller nets full tradePrice (matched pair nets to zero)");
    }

    // ─── v1b1-2b-2: settleFunding-direct wiring tests ──────────────────────────

    // Strips taker down to a pure YES or pure NO holder by moving away the other
    // side's balance (transfers are CLOB_ROLE-gated; grant it to taker just for
    // this direct move, isolating the trade under test from the offsetting leg).
    function _stripTakerToPureYes() internal {
        address sink = makeAddr("no-sink");
        noToken.grantRole(noToken.CLOB_ROLE(), taker);
        vm.prank(taker);
        noToken.transfer(sink, 1_000e18);
    }

    function _stripTakerToPureNo() internal {
        address sink = makeAddr("yes-sink");
        yesToken.grantRole(yesToken.CLOB_ROLE(), taker);
        vm.prank(taker);
        yesToken.transfer(sink, 1_000e18);
    }

    // Pure NO holder: the credit settleFunding pays out directly is on top of the
    // trade's own tradePrice — per-token, $0.95 (price) + $0.03 (funding) = $0.98.
    function test_NOSaleBack_SellerGets_TradePricePlusFunding() public {
        _stripTakerToPureNo(); // taker: 0 YES, 1000 NO

        // settleFunding pays the NO credit directly out of CreditMarket's own
        // collateral balance; taker's tokens were minted directly in setUp
        // (bypassing market.mint()), so fund the market's balance here to match.
        usdc.mint(address(market), 1_000e18);

        market.grantRole(market.KEEPER_ROLE(), admin);
        market.setMark(0.03e18); // elapsed == 0 here, so this is a no-op accrual

        vm.warp(block.timestamp + 365 days);

        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(noToken), 950e18, 1_000e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(noToken), address(usdc), 1_000e18, 950e18, expiry, 0
        );

        uint256 takerUsdcBefore = usdc.balanceOf(taker);

        clob.fillOrders(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_), _qty(mo));

        // credit = one year of carry at a 3% mark = 1000e18 * carryRateFor(0.03e18) / 1e18
        // ≈ 29.55e18; tradePrice = 950e18.
        uint256 credit = 1_000e18 * market.currentCarryRate() / 1e18;
        assertEq(usdc.balanceOf(taker), takerUsdcBefore + 950e18 + credit,
            "seller nets tradePrice ($0.95/token) plus funding credit (~$0.0295/token)");
    }

    // Pure YES holder: settleFunding reports a debit which is collected out of
    // this trade's own proceeds — per-token, $0.05 (price) - $0.03 (funding) = $0.02.
    function test_YESSaleBack_SellerGets_TradePriceMinusFunding() public {
        _stripTakerToPureYes(); // taker: 1000 YES, 0 NO

        market.grantRole(market.KEEPER_ROLE(), admin);
        market.setMark(0.03e18);

        vm.warp(block.timestamp + 365 days);

        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 50e18, 1_000e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 1_000e18, 50e18, expiry, 0
        );

        uint256 takerUsdcBefore = usdc.balanceOf(taker);

        clob.fillOrders(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_), _qty(mo));

        // owed = one year of carry at a 3% mark ≈ 29.55e18; tradePrice = 50e18.
        uint256 owed = 1_000e18 * market.currentCarryRate() / 1e18;
        assertEq(usdc.balanceOf(taker), takerUsdcBefore + 50e18 - owed,
            "seller nets tradePrice ($0.05/token) minus funding owed (~$0.0295/token)");
    }

    function test_YESSale_BelowOwed_Reverts_PositionUnchanged() public {
        _stripTakerToPureYes(); // taker: 1000 YES, 0 NO

        market.grantRole(market.KEEPER_ROLE(), admin);
        market.setMark(0.03e18);

        vm.warp(block.timestamp + 365 days);

        uint256 expiry = block.timestamp + 1 hours;
        // owed ≈ 29.55e18 (one year of carry at 3%); priced at 20e18 < owed.
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 20e18, 1_000e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 1_000e18, 20e18, expiry, 0
        );
        bytes memory ms = _sign(makerKey, mo);
        bytes memory ts = _sign(takerKey, to_);

        uint256 takerYesBefore = yesToken.balanceOf(taker);
        uint256 snapBefore     = market.fundingSnapshot(taker);

        vm.expectRevert(CLOBSettlement.FundingShortfall.selector);
        clob.fillOrders(mo, ms, to_, ts, _qty(mo));

        assertEq(yesToken.balanceOf(taker), takerYesBefore, "YES balance unchanged after failed sell");
        assertEq(market.fundingSnapshot(taker), snapBefore, "funding snapshot unchanged after failed sell");
        assertFalse(market.claimable(taker), "a failed sell must never flag the position claimable");
        assertEq(clob.filled(clob.hashOrder(to_)), 0, "taker order not filled on revert");
        assertEq(clob.filled(clob.hashOrder(mo)), 0, "maker order not filled on revert");
    }

    // Taker holds the matched YES+NO pair from setUp (never traded), so his YES
    // debit and NO credit net to exactly zero regardless of elapsed time — proving
    // the swap leg carries pure token value with no funding embedded when there is
    // no NET funding obligation, even though YES alone would normally owe carry.
    function test_TradePrice_IsPureTokenValue() public {
        vm.warp(block.timestamp + 30 days);

        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 100e18, 80e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 80e18, 100e18, expiry, 0
        );

        uint256 takerUsdcBefore = usdc.balanceOf(taker);

        clob.fillOrders(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_), _qty(mo));

        assertEq(usdc.balanceOf(taker), takerUsdcBefore + 100e18,
            "matched pair nets to zero -> tradePrice passes through with no funding deduction");
    }

    // A brand-new buyer (zero pre-trade balance on both sides) still gets both
    // funding snapshots reset to now by settleFunding — the reset is unconditional,
    // not just for the side of the token actually being traded.
    function test_BuyerSnapshotsReset() public {
        vm.warp(block.timestamp + 30 days);

        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 100e18, 80e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 80e18, 100e18, expiry, 0
        );

        clob.fillOrders(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_), _qty(mo));

        uint256 cumYes = market.cumulativeFundingPerYES();
        uint256 cumNo  = market.cumFundingPerNO();
        assertEq(market.fundingSnapshot(maker), cumYes, "buyer YES snapshot reset");
        assertEq(market.snapNO(maker),          cumNo,  "buyer NO snapshot reset");
    }

    // ─── v1b1-2c: flagged positions are fully locked out of CLOB trades ────────

    // A flagged holder acting as the SELLER in a CLOB trade must be blocked.
    function test_Lockout_FlaggedSeller_Reverts() public {
        _stripTakerToPureYes(); // taker: 1000 YES, 0 NO

        vm.warp(block.timestamp + 410 days); // past the ~404-day runway at a 23% mark
        market.accrueFunding();
        market.grantRole(market.KEEPER_ROLE(), admin);
        assertTrue(market.isSeizable(taker), "must be seizable before flag");
        market.flagClaimable(taker);
        assertTrue(market.claimable(taker), "taker flagged");

        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 50e18, 100e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 100e18, 50e18, expiry, 0
        );
        bytes memory ms = _sign(makerKey, mo);
        bytes memory ts = _sign(takerKey, to_);

        vm.expectRevert(CLOBSettlement.PositionFrozen.selector);
        clob.fillOrders(mo, ms, to_, ts, _qty(mo));
    }

    // A flagged holder acting as the BUYER in a CLOB trade must be blocked, even
    // when the trade itself has nothing to do with the position that got them
    // flagged (maker here buys more YES while already flagged from an earlier,
    // unrelated YES position).
    function test_Lockout_FlaggedBuyer_Reverts() public {
        // Give maker a separate flaggable YES position (independent of the trade below).
        yesToken.mint(maker, 1_000e18); // admin holds MINTER_ROLE from setUp

        vm.warp(block.timestamp + 410 days); // past the ~404-day runway at a 23% mark
        market.accrueFunding();
        market.grantRole(market.KEEPER_ROLE(), admin);
        assertTrue(market.isSeizable(maker), "maker must be seizable before flag");
        market.flagClaimable(maker);
        assertTrue(market.claimable(maker), "maker flagged");

        // maker (frozen) now attempts to BUY YES from taker.
        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 50e18, 40e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 40e18, 50e18, expiry, 0
        );
        bytes memory ms = _sign(makerKey, mo);
        bytes memory ts = _sign(takerKey, to_);

        vm.expectRevert(CLOBSettlement.PositionFrozen.selector);
        clob.fillOrders(mo, ms, to_, ts, _qty(mo));
    }

    // ─── trading fee: YES sells and NO buys pay; YES buys and NO sells don't ──

    address teamWallet    = makeAddr("team-wallet");
    address insuranceSink = makeAddr("insurance-sink");

    // 50 bps of min(p, 1−p) × Q, split 50/50 team wallet / insurance fund.
    function _enableFee() internal {
        clob.setFeeConfig(50, teamWallet, insuranceSink, 5_000);
    }

    function test_SetFeeConfig_OnlyAdmin() public {
        vm.prank(maker);
        vm.expectRevert(); // AccessControlUnauthorizedAccount
        clob.setFeeConfig(50, teamWallet, insuranceSink, 5_000);
    }

    function test_SetFeeConfig_Validation() public {
        vm.expectRevert(CLOBSettlement.FeeConfigInvalid.selector);
        clob.setFeeConfig(501, teamWallet, insuranceSink, 5_000); // > MAX_FEE_BPS

        vm.expectRevert(CLOBSettlement.FeeConfigInvalid.selector);
        clob.setFeeConfig(50, teamWallet, insuranceSink, 10_001); // share > 100%

        vm.expectRevert(CLOBSettlement.FeeConfigInvalid.selector);
        clob.setFeeConfig(50, address(0), insuranceSink, 5_000); // no team recipient

        vm.expectRevert(CLOBSettlement.FeeConfigInvalid.selector);
        clob.setFeeConfig(50, teamWallet, address(0), 5_000); // no insurance recipient
    }

    // YES trade at p = 0.05: fee = 50e18 × 50 / 10_000 = 0.25e18, paid by the
    // SELLER out of proceeds; the buyer's total spend is exactly tradePrice.
    function test_Fee_YESSale_SellerPays_BuyerDoesNot() public {
        _enableFee();

        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 50e18, 1_000e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 1_000e18, 50e18, expiry, 0
        );

        uint256 makerUsdcBefore = usdc.balanceOf(maker);
        uint256 takerUsdcBefore = usdc.balanceOf(taker);
        uint256 marketUsdcBefore = usdc.balanceOf(address(market));

        clob.fillOrders(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_), _qty(mo));

        // min(50, 1000−50) = 50e18 → fee = 0.25e18, split 0.125 / 0.125.
        assertEq(usdc.balanceOf(maker), makerUsdcBefore - 50e18, "YES buyer pays pure tradePrice, fee-free");
        assertEq(usdc.balanceOf(taker), takerUsdcBefore + 50e18 - 0.25e18, "YES seller nets tradePrice minus fee");
        assertEq(usdc.balanceOf(insuranceSink), 0.125e18, "insurance half");
        assertEq(usdc.balanceOf(teamWallet),    0.125e18, "team half");
        assertEq(usdc.balanceOf(address(market)), marketUsdcBefore, "fees never touch collateral");
    }

    // NO trade: the BUYER's signed amountIn is gross (fee-inclusive); the
    // fee-free seller receives amountIn − fee, and route equivalence holds:
    // the fee at gross 950e18 equals the YES-sale fee at 50e18 (both 0.25e18,
    // both priced off the same 50e18 min-side).
    function test_Fee_NOBuy_BuyerPays_SellerDoesNot() public {
        _enableFee();

        uint256 expiry = block.timestamp + 1 hours;
        // Buyer signs gross 950e18; fee = min(950, 50) × 0.005 = 0.25e18;
        // seller's limit (949e18) is checked against the NET 949.75e18.
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(noToken), 950e18, 1_000e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(noToken), address(usdc), 1_000e18, 949e18, expiry, 0
        );

        uint256 makerUsdcBefore = usdc.balanceOf(maker);
        uint256 takerUsdcBefore = usdc.balanceOf(taker);

        clob.fillOrders(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_), _qty(mo));

        assertEq(usdc.balanceOf(maker), makerUsdcBefore - 950e18, "NO buyer pays their signed gross total");
        assertEq(usdc.balanceOf(taker), takerUsdcBefore + 950e18 - 0.25e18, "NO seller receives gross minus buyer's fee");
        assertEq(usdc.balanceOf(insuranceSink), 0.125e18, "insurance half");
        assertEq(usdc.balanceOf(teamWallet),    0.125e18, "team half");
    }

    // NO sale where net proceeds would fall below the fee-free seller's signed
    // limit: gross passes the legacy check but net does not → SlippageExceeded.
    function test_Fee_NOBuy_NetBelowSellerLimit_Reverts() public {
        _enableFee();

        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(noToken), 950e18, 1_000e18, expiry, 0
        );
        // Seller demands the full 950e18 — net 949.75e18 can't satisfy it.
        CLOBSettlement.Order memory to_ = _order(
            taker, address(noToken), address(usdc), 1_000e18, 950e18, expiry, 0
        );
        bytes memory ms = _sign(makerKey, mo);
        bytes memory ts = _sign(takerKey, to_);

        vm.expectRevert(CLOBSettlement.SlippageExceeded.selector);
        clob.fillOrders(mo, ms, to_, ts, _qty(mo));
    }

    // Option B safeguard extends to the fee: a YES sale clearing above the
    // funding debit but below debit + fee still reverts, position unchanged.
    function test_Fee_YESSale_DebitPlusFeeShortfall_Reverts() public {
        _enableFee();
        _stripTakerToPureYes(); // taker: 1000 YES, 0 NO

        market.grantRole(market.KEEPER_ROLE(), admin);
        market.setMark(0.03e18);
        vm.warp(block.timestamp + 365 days);

        uint256 expiry = block.timestamp + 1 hours;
        // owed ≈ 29.55e18 (one year of carry at 3%); priced 0.1e18 above it, the fee
        // (≈0.148e18) pushes debit + fee past the price → revert.
        uint256 owed = 1_000e18 * market.currentCarryRate() / 1e18;
        uint256 tradePrice = owed + 0.1e18;
        assertLt(tradePrice, owed + clob.tradeFee(1_000e18, tradePrice), "price sits between debit and debit + fee");
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), tradePrice, 1_000e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 1_000e18, tradePrice, expiry, 0
        );
        bytes memory ms = _sign(makerKey, mo);
        bytes memory ts = _sign(takerKey, to_);

        uint256 takerYesBefore = yesToken.balanceOf(taker);

        vm.expectRevert(CLOBSettlement.FundingShortfall.selector);
        clob.fillOrders(mo, ms, to_, ts, _qty(mo));

        assertEq(yesToken.balanceOf(taker), takerYesBefore, "position unchanged after failed sell");
        assertFalse(market.claimable(taker), "failed sell never flags the position");
    }

    // Debit AND fee both deducted when the YES sale clears high enough.
    function test_Fee_YESSale_StacksWithFundingDebit() public {
        _enableFee();
        _stripTakerToPureYes();

        market.grantRole(market.KEEPER_ROLE(), admin);
        market.setMark(0.03e18);
        vm.warp(block.timestamp + 365 days);

        uint256 expiry = block.timestamp + 1 hours;
        // owed ≈ 29.55e18 (one year of carry at 3%); tradePrice 50e18 → fee = 0.25e18.
        uint256 owed = 1_000e18 * market.currentCarryRate() / 1e18;
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 50e18, 1_000e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 1_000e18, 50e18, expiry, 0
        );

        uint256 takerUsdcBefore = usdc.balanceOf(taker);

        clob.fillOrders(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_), _qty(mo));

        assertEq(usdc.balanceOf(taker), takerUsdcBefore + 50e18 - owed - 0.25e18,
            "seller nets tradePrice minus debit minus fee");
        assertEq(market.fundingDebt(taker), 0, "debt collected via collectDebt");
    }

    // feeBps = 0 (constructor default): all legacy paths charge nothing — the
    // rest of this suite runs without _enableFee() and doubles as coverage.
    function test_Fee_ZeroConfig_NoCharge() public {
        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 50e18, 1_000e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 1_000e18, 50e18, expiry, 0
        );

        uint256 takerUsdcBefore = usdc.balanceOf(taker);
        clob.fillOrders(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_), _qty(mo));
        assertEq(usdc.balanceOf(taker), takerUsdcBefore + 50e18, "no fee when unconfigured");
    }

    function test_TradeFee_Formula() public {
        _enableFee();
        // p < 0.5: min side is tradePrice.
        assertEq(clob.tradeFee(1_000e18, 50e18), 0.25e18);
        // p > 0.5: min side is amount − tradePrice; equals the complementary trade's fee.
        assertEq(clob.tradeFee(1_000e18, 950e18), 0.25e18);
        // p = 0.5: both sides equal.
        assertEq(clob.tradeFee(1_000e18, 500e18), 2.5e18);
        // p ≥ 1: clamps to zero.
        assertEq(clob.tradeFee(1_000e18, 1_000e18), 0);
        assertEq(clob.tradeFee(1_000e18, 1_500e18), 0);
    }

    function testFuzz_Fee_NeverExceedsHalfPercentOfMinSide(
        uint128 amountRaw, uint128 priceRaw
    ) public {
        _enableFee();
        uint256 amount     = uint256(amountRaw) + 1;
        uint256 tradePrice = uint256(priceRaw) % amount; // p in [0, 1)
        uint256 fee = clob.tradeFee(amount, tradePrice);
        uint256 minSide = tradePrice < amount - tradePrice ? tradePrice : amount - tradePrice;
        assertEq(fee, minSide * 50 / 10_000, "fee formula");
        assertLe(fee, tradePrice, "fee always coverable by the USDC leg");
    }

    // ─── conservation: settlement moves USDC, never creates or destroys it ─────

    // Every account a settlement can touch on the USDC leg. Captured as one memory
    // struct for the same reason CLOBSettlement uses TradeCtx — five loose locals
    // twice over blows the stack here.
    struct UsdcBal {
        uint256 buyer;
        uint256 seller;
        uint256 market;
        uint256 insurance;
        uint256 team;
    }

    function _snapUsdc() internal view returns (UsdcBal memory b) {
        b.buyer     = usdc.balanceOf(maker);
        b.seller    = usdc.balanceOf(taker);
        b.market    = usdc.balanceOf(address(market));
        b.insurance = usdc.balanceOf(insuranceSink);
        b.team      = usdc.balanceOf(teamWallet);
    }

    function _totalUsdc(UsdcBal memory b) internal pure returns (uint256) {
        return b.buyer + b.seller + b.market + b.insurance + b.team;
    }

    // Asserted at the only observable point in the trade lifecycle: a snapshot
    // before verifyAndSettle and the deltas after. Signature checks, funding
    // settlement, the token leg, the USDC leg and fee collection all run inside one
    // atomic nonReentrant call over a callback-free ERC-20, so there is no
    // intra-settlement state to probe — and conservation is a property of the whole
    // transaction, not of any step within it.
    //
    // Generalizes the fixed-input buyer-side checks in
    // test_Fee_YESSale_SellerPays_BuyerDoesNot / test_Fee_NOBuy_BuyerPays_SellerDoesNot
    // across price, size, funding load and both sides, and closes the gap in
    // test_Fee_YESSale_StacksWithFundingDebit — the one path where all three USDC
    // legs (seller proceeds, debtToCollateral, the two-way fee split) are live at
    // once, but only the seller's leg is asserted there.
    function testFuzz_SettlementConservesUsdc(
        uint128 amountRaw, uint128 priceRaw, uint64 markRaw, bool yesSale
    ) public {
        _enableFee();

        // Isolate the taker on one side so the funding leg has a definite sign: a
        // pure YES holder owes a debit, a pure NO holder is owed a credit. Both run
        // while cumulative funding is still zero, so snapshots stay at 0.
        if (yesSale) _stripTakerToPureYes();
        else         _stripTakerToPureNo();

        // Funding credits are paid out of CreditMarket's own collateral, and the
        // taker's tokens were minted directly in setUp (bypassing market.mint()), so
        // back them here — same reason as test_NOSaleBack_SellerGets_*.
        usdc.mint(address(market), 1_000e18);

        // A mark of ≤1% keeps one year of carry on the taker's full 1,000e18 balance
        // at or below 10e18, comfortably under the price floor chosen below.
        uint256 mark = bound(uint256(markRaw), 1, 0.01e18); // 0 is an invalid mark (setMark reverts InvalidMark)
        market.grantRole(market.KEEPER_ROLE(), admin);
        market.setMark(mark);                 // elapsed == 0: sets the rate, accrues nothing
        vm.warp(block.timestamp + 365 days);  // → cumFundingPerYES == cumFundingPerNO == carryRateFor(mark)

        uint256 amount = bound(uint256(amountRaw), 100e18, 1_000e18);
        // settleFunding nets the seller's FULL balance, not the amount sold, so the
        // funding leg is sized off 1,000e18 regardless of trade size.
        uint256 owed = 1_000e18 * market.currentCarryRate() / 1e18;

        // Floor the price above owed plus a 1% margin. The fee is at most 0.5% of the
        // min side, i.e. ≤0.25% of amount, so every draw clears owed + fee without
        // vm.assume rejection — FundingShortfall has its own dedicated test.
        uint256 tradePrice = bound(uint256(priceRaw), owed + amount / 100 + 1, amount - 1);
        uint256 fee = clob.tradeFee(amount, tradePrice);

        // The buyer's signed amountIn is gross on both sides; on a NO sale the
        // fee-free seller's limit has to be net of the fee or the net check trips.
        address token = yesSale ? address(yesToken) : address(noToken);
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), token, tradePrice, amount, block.timestamp + 1 hours, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, token, address(usdc), amount,
            yesSale ? tradePrice : tradePrice - fee, block.timestamp + 1 hours, 0
        );

        UsdcBal memory b0 = _snapUsdc();
        clob.fillOrders(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_), _qty(mo));
        UsdcBal memory b1 = _snapUsdc();

        // (1) Closure: seller proceeds, collateral, insurance and team are the only
        // sinks, and every USDC unit leaving one account lands in exactly one other.
        assertEq(_totalUsdc(b1), _totalUsdc(b0), "settlement neither creates nor destroys USDC");
        assertEq(usdc.balanceOf(address(clob)), 0, "CLOBSettlement never custodies USDC");

        // (2) No over-pull: the buyer signed for tradePrice and can never be charged
        // beyond it — the fee rides inside that amount on a NO buy and is carved out
        // of the seller's proceeds on a YES sale. Exact rather than bounded because
        // the buyer holds no YES/NO here, so their own settleFunding leg moves nothing.
        assertEq(b0.buyer - b1.buyer, tradePrice, "buyer pays exactly the amountIn they signed");

        // (3) The fee split is exhaustive — no dust is stranded between the two sinks.
        assertEq(
            (b1.insurance - b0.insurance) + (b1.team - b0.team),
            fee,
            "fee splits exhaustively between insurance and team"
        );

        // (4) Collateral moves by the funding leg alone: fees never touch it, and the
        // complete-set invariant makes the NO credit equal the YES debit at the same mark.
        // A YES sale collects the seller's debt PRO-RATA to the share of their YES it
        // sells (rounded down; selling everything collects it all); the rest stays in
        // fundingDebt — never erased (invariant 9).
        if (yesSale) {
            uint256 share = amount >= 1_000e18 ? owed : owed * amount / 1_000e18;
            assertEq(b1.market - b0.market, share, "collected pro-rata YES debit is the only collateral inflow");
            assertEq(market.fundingDebt(taker), owed - share, "uncollected debt stays on the ledger");
        } else {
            assertEq(b0.market - b1.market, owed, "paid NO credit is the only collateral outflow");
        }
    }

    // ─── a9476ea: constructor ZeroAddress guard ────────────────────────────────

    function test_Constructor_ZeroAddress_Reverts() public {
        vm.expectRevert(CLOBSettlement.ZeroAddress.selector);
        new CLOBSettlement(address(0), admin);

        vm.expectRevert(CLOBSettlement.ZeroAddress.selector);
        new CLOBSettlement(address(market), address(0));
    }

    // ─── batch 3: partial fills, maker price, cancels, operator-only ──────────

    uint256 buyer2Key = 0xCA401;

    // A second buyer with USDC + approval, for multi-counterparty fills.
    function _buyer2() internal returns (address b2) {
        b2 = vm.addr(buyer2Key);
        usdc.mint(b2, 10_000e18);
        vm.prank(b2);
        usdc.approve(address(clob), type(uint256).max);
    }

    // Resting YES ask by `taker`: 4 YES for >= 0.96 USDC (24¢).
    function _ask4At24(uint256 nonce) internal view returns (CLOBSettlement.Order memory) {
        return _order(taker, address(yesToken), address(usdc), 4e18, 0.96e18, block.timestamp + 1 hours, nonce);
    }

    function test_PartialFill_SmallBidFillsPartOfAsk_RestStaysFillable() public {
        CLOBSettlement.Order memory ask = _ask4At24(1);
        bytes memory askSig = _sign(takerKey, ask);
        // 1 YES at up to 25¢: executes at the MAKER's 24¢.
        CLOBSettlement.Order memory bid = _order(maker, address(usdc), address(yesToken), 0.25e18, 1e18, block.timestamp + 1 hours, 1);

        uint256 makerUsdc0 = usdc.balanceOf(maker);
        clob.fillOrders(ask, askSig, bid, _sign(makerKey, bid), 1e18);

        assertEq(yesToken.balanceOf(maker), 1e18, "buyer got 1 YES");
        assertEq(makerUsdc0 - usdc.balanceOf(maker), 0.24e18, "buyer paid the maker's 24c, not its own 25c limit");
        assertEq(clob.remaining(ask), 3e18, "3 YES of the ask still resting");
        assertEq(clob.remaining(bid), 0, "bid fully filled");

        // A second buyer takes the remaining 3.
        address b2 = _buyer2();
        CLOBSettlement.Order memory bid2 = _order(b2, address(usdc), address(yesToken), 0.72e18, 3e18, block.timestamp + 1 hours, 1);
        clob.fillOrders(ask, askSig, bid2, _sign(buyer2Key, bid2), 3e18);
        assertEq(yesToken.balanceOf(b2), 3e18, "second buyer got the rest");
        assertEq(clob.remaining(ask), 0, "ask fully filled");

        // Nothing left: any further fill reverts.
        address b3 = makeAddr("b3");
        CLOBSettlement.Order memory bid3 = _order(b3, address(usdc), address(yesToken), 0.24e18, 1e18, block.timestamp + 1 hours, 1);
        bytes memory bid3Sig = _sign(takerKey, bid3); // signer irrelevant: remaining is checked on the maker first
        vm.expectRevert(CLOBSettlement.FillExceedsRemaining.selector);
        clob.fillOrders(ask, askSig, bid3, bid3Sig, 1e18);
    }

    function test_PartialFill_MakerIsBuyer_ExecutesAtBidPrice() public {
        // Resting bid: 2 YES at 30¢; incoming sell asks only 20¢ -> trades at 30¢.
        CLOBSettlement.Order memory bid = _order(maker, address(usdc), address(yesToken), 0.6e18, 2e18, block.timestamp + 1 hours, 1);
        CLOBSettlement.Order memory sell = _order(taker, address(yesToken), address(usdc), 1e18, 0.2e18, block.timestamp + 1 hours, 1);
        uint256 takerUsdc0 = usdc.balanceOf(taker);
        clob.fillOrders(bid, _sign(makerKey, bid), sell, _sign(takerKey, sell), 1e18);
        assertEq(usdc.balanceOf(taker) - takerUsdc0, 0.3e18, "seller receives the resting bid's 30c");
        assertEq(clob.remaining(bid), 1e18, "1 YES of the bid still resting");
    }

    function test_Fill_TakerLimitNotMet_Reverts() public {
        CLOBSettlement.Order memory ask = _ask4At24(1);
        CLOBSettlement.Order memory bid = _order(maker, address(usdc), address(yesToken), 0.2e18, 1e18, block.timestamp + 1 hours, 1);
        bytes memory askSig = _sign(takerKey, ask);
        bytes memory bidSig = _sign(makerKey, bid);
        vm.expectRevert(CLOBSettlement.SlippageExceeded.selector);
        clob.fillOrders(ask, askSig, bid, bidSig, 1e18);
    }

    function test_Fill_OperatorOnly() public {
        CLOBSettlement.Order memory ask = _ask4At24(1);
        CLOBSettlement.Order memory bid = _order(maker, address(usdc), address(yesToken), 0.24e18, 1e18, block.timestamp + 1 hours, 1);
        bytes memory askSig = _sign(takerKey, ask);
        bytes memory bidSig = _sign(makerKey, bid);
        vm.prank(maker);
        vm.expectRevert(); // AccessControlUnauthorizedAccount(maker, OPERATOR_ROLE)
        clob.fillOrders(ask, askSig, bid, bidSig, 1e18);
    }

    function test_Fill_ZeroTokens_Reverts() public {
        CLOBSettlement.Order memory ask = _ask4At24(1);
        CLOBSettlement.Order memory bid = _order(maker, address(usdc), address(yesToken), 0.24e18, 1e18, block.timestamp + 1 hours, 1);
        bytes memory askSig = _sign(takerKey, ask);
        bytes memory bidSig = _sign(makerKey, bid);
        vm.expectRevert(CLOBSettlement.FillTooSmall.selector);
        clob.fillOrders(ask, askSig, bid, bidSig, 0);
    }

    function test_Fill_PricesToZeroUsdc_Reverts() public {
        // A resting "sell at any price" (floor 0) is the maker, so the fill prices at
        // 0 USDC — rejected rather than giving tokens away.
        CLOBSettlement.Order memory sell = _order(taker, address(yesToken), address(usdc), 1e18, 0, block.timestamp + 1 hours, 1);
        CLOBSettlement.Order memory bid = _order(maker, address(usdc), address(yesToken), 0.3e18, 1e18, block.timestamp + 1 hours, 1);
        bytes memory sellSig = _sign(takerKey, sell);
        bytes memory bidSig = _sign(makerKey, bid);
        vm.expectRevert(CLOBSettlement.FillTooSmall.selector);
        clob.fillOrders(sell, sellSig, bid, bidSig, 1e18);
    }

    function test_Fill_ForeignToken_RevertsInvalidTokenPair() public {
        MockUSDC other = new MockUSDC();
        CLOBSettlement.Order memory ask = _order(taker, address(other), address(usdc), 1e18, 0.2e18, block.timestamp + 1 hours, 1);
        CLOBSettlement.Order memory bid = _order(maker, address(usdc), address(other), 0.2e18, 1e18, block.timestamp + 1 hours, 1);
        bytes memory askSig = _sign(takerKey, ask);
        bytes memory bidSig = _sign(makerKey, bid);
        vm.expectRevert(CLOBSettlement.InvalidTokenPair.selector);
        clob.fillOrders(ask, askSig, bid, bidSig, 1e18);
    }

    function test_CancelOrders_MakerOnly_ThenUnfillable() public {
        CLOBSettlement.Order memory ask = _ask4At24(1);
        CLOBSettlement.Order[] memory list = new CLOBSettlement.Order[](1);
        list[0] = ask;

        vm.prank(maker);
        vm.expectRevert(CLOBSettlement.NotOrderMaker.selector);
        clob.cancelOrders(list);

        vm.prank(taker);
        clob.cancelOrders(list);
        assertEq(clob.remaining(ask), 0, "cancelled order has nothing left");

        CLOBSettlement.Order memory bid = _order(maker, address(usdc), address(yesToken), 0.24e18, 1e18, block.timestamp + 1 hours, 1);
        bytes memory askSig = _sign(takerKey, ask);
        bytes memory bidSig = _sign(makerKey, bid);
        vm.expectRevert(CLOBSettlement.FillExceedsRemaining.selector);
        clob.fillOrders(ask, askSig, bid, bidSig, 1e18);
    }

    function test_CancelAfterPartialFill_StopsTheRest() public {
        CLOBSettlement.Order memory ask = _ask4At24(1);
        bytes memory askSig = _sign(takerKey, ask);
        CLOBSettlement.Order memory bid = _order(maker, address(usdc), address(yesToken), 0.24e18, 1e18, block.timestamp + 1 hours, 1);
        clob.fillOrders(ask, askSig, bid, _sign(makerKey, bid), 1e18);

        CLOBSettlement.Order[] memory list = new CLOBSettlement.Order[](1);
        list[0] = ask;
        vm.prank(taker);
        clob.cancelOrders(list);
        assertEq(clob.remaining(ask), 0, "the unfilled 3 are cancelled; the filled 1 stays filled");
        assertEq(yesToken.balanceOf(maker), 1e18, "the earlier fill is untouched");
    }

    function test_SetMinNonce_CancelsOlderOrders() public {
        CLOBSettlement.Order memory oldAsk = _ask4At24(100);
        CLOBSettlement.Order memory newAsk = _ask4At24(200);
        vm.prank(taker);
        clob.setMinNonce(150);
        assertEq(clob.remaining(oldAsk), 0, "nonce below the floor is void");
        assertEq(clob.remaining(newAsk), 4e18, "nonce at/above the floor is live");

        CLOBSettlement.Order memory bid = _order(maker, address(usdc), address(yesToken), 0.24e18, 1e18, block.timestamp + 1 hours, 1);
        bytes memory oldSig = _sign(takerKey, oldAsk);
        bytes memory bidSig = _sign(makerKey, bid);
        vm.expectRevert(CLOBSettlement.OrderInvalidated.selector);
        clob.fillOrders(oldAsk, oldSig, bid, bidSig, 1e18);

        vm.prank(taker);
        vm.expectRevert(CLOBSettlement.NonceNotIncreasing.selector);
        clob.setMinNonce(150);
    }

    // Pro-rata debt (owner decision A): selling a quarter of a YES position collects a
    // quarter of the carry debt; the debt per remaining YES — and so the seizure
    // trigger — is unchanged; selling the rest collects the rest.
    function test_YESSale_ProRataDebt_PerFill() public {
        _stripTakerToPureYes(); // taker: 1000 YES, 0 NO
        market.grantRole(market.KEEPER_ROLE(), admin);
        market.setMark(0.03e18);
        vm.warp(block.timestamp + 365 days);
        market.accrueFunding();
        uint256 owed0 = market.owed(taker);
        uint256 perToken0 = owed0 * 1e18 / 1_000e18;

        CLOBSettlement.Order memory ask = _order(taker, address(yesToken), address(usdc), 1_000e18, 50e18, block.timestamp + 1 hours, 1);
        bytes memory askSig = _sign(takerKey, ask);
        CLOBSettlement.Order memory bid = _order(maker, address(usdc), address(yesToken), 50e18, 1_000e18, block.timestamp + 1 hours, 1);
        bytes memory bidSig = _sign(makerKey, bid);

        uint256 coll0 = usdc.balanceOf(address(market));
        uint256 takerUsdc0 = usdc.balanceOf(taker);
        clob.fillOrders(ask, askSig, bid, bidSig, 250e18);

        uint256 share = owed0 * 250e18 / 1_000e18;
        assertEq(usdc.balanceOf(address(market)) - coll0, share, "a quarter of the debt went to collateral");
        assertEq(market.fundingDebt(taker), owed0 - share, "three quarters stay on the ledger");
        assertEq(usdc.balanceOf(taker) - takerUsdc0, 12.5e18 - share, "seller nets price minus its debt share");
        assertApproxEqAbs(market.owed(taker) * 1e18 / 750e18, perToken0, 1, "debt per remaining YES unchanged");

        clob.fillOrders(ask, askSig, bid, bidSig, 750e18);
        assertEq(market.fundingDebt(taker), 0, "selling the last YES collects the rest");
        assertEq(usdc.balanceOf(address(market)) - coll0, owed0, "the whole debt reached collateral across both fills");
    }

    function test_YESSale_ProRata_FundingShortfallPerFill_PositionUnchanged() public {
        _stripTakerToPureYes();
        market.grantRole(market.KEEPER_ROLE(), admin);
        market.setMark(0.03e18);
        vm.warp(block.timestamp + 365 days);
        market.accrueFunding();
        // debt ≈ 2.955¢ per YES; a 2¢ ask can't cover its pro-rata share at any size.
        CLOBSettlement.Order memory ask = _order(taker, address(yesToken), address(usdc), 1_000e18, 20e18, block.timestamp + 1 hours, 1);
        CLOBSettlement.Order memory bid = _order(maker, address(usdc), address(yesToken), 20e18, 1_000e18, block.timestamp + 1 hours, 1);
        bytes memory askSig = _sign(takerKey, ask);
        bytes memory bidSig = _sign(makerKey, bid);
        uint256 yes0 = yesToken.balanceOf(taker);
        vm.expectRevert(CLOBSettlement.FundingShortfall.selector);
        clob.fillOrders(ask, askSig, bid, bidSig, 10e18);
        assertEq(yesToken.balanceOf(taker), yes0, "position unchanged");
        assertEq(clob.remaining(ask), 1_000e18, "nothing recorded as filled");
    }

    // NO sale with the resting SELLER as maker: the fee-free seller's floor applies to
    // its NET; the buyer pays the gross (net + fee) and never more than its own limit.
    function test_NOSale_MakerSeller_NetFloorHonoured_WithFee() public {
        _enableFee();
        // Seller rests 100 NO for >= 70 net (70¢); buyer will pay up to 72¢ gross.
        CLOBSettlement.Order memory ask = _order(taker, address(noToken), address(usdc), 100e18, 70e18, block.timestamp + 1 hours, 1);
        CLOBSettlement.Order memory bid = _order(maker, address(usdc), address(noToken), 72e18, 100e18, block.timestamp + 1 hours, 1);
        uint256 takerUsdc0 = usdc.balanceOf(taker);
        uint256 makerUsdc0 = usdc.balanceOf(maker);
        clob.fillOrders(ask, _sign(takerKey, ask), bid, _sign(makerKey, bid), 40e18);
        uint256 net = usdc.balanceOf(taker) - takerUsdc0;
        uint256 gross = makerUsdc0 - usdc.balanceOf(maker);
        assertGe(net, 28e18, "seller nets at least its 70c floor on 40 NO");
        assertLe(gross * 100e18, 72e18 * 40e18, "buyer pays no more than its 72c gross limit");
        assertEq(gross - net, clob.tradeFee(40e18, gross), "difference is exactly the fee");
    }

    // Equal limits at a price that isn't a whole unit per partial fill (3 YES for 1
    // USDC unit): the fill still goes through, and the buyer's signed amountIn is a
    // hard cap across fills.
    function test_PartialFill_EqualLimits_SubUnitRounding_Fills() public {
        CLOBSettlement.Order memory ask = _order(taker, address(yesToken), address(usdc), 3, 1, block.timestamp + 1 hours, 1);
        CLOBSettlement.Order memory bid = _order(maker, address(usdc), address(yesToken), 1, 3, block.timestamp + 1 hours, 1);
        bytes memory askSig = _sign(takerKey, ask);
        bytes memory bidSig = _sign(makerKey, bid);
        uint256 b0 = usdc.balanceOf(maker);
        clob.fillOrders(ask, askSig, bid, bidSig, 2); // exact price 0.667 units -> maker's ceil = 1
        assertEq(b0 - usdc.balanceOf(maker), 1, "buyer paid its whole 1-unit budget");
        assertEq(clob.remaining(bid), 0, "budget exhausted: the bid is done");
        // The last token would cost 0 USDC from an empty budget: nothing more is pulled.
        vm.expectRevert(CLOBSettlement.FillTooSmall.selector);
        clob.fillOrders(ask, askSig, bid, bidSig, 1);
        assertEq(b0 - usdc.balanceOf(maker), 1, "never more than the signed amountIn");
    }

    // Any split of one order into fills never crosses either party's limit, and the
    // buyer's total stays within its signed amountIn.
    struct SplitCase {
        CLOBSettlement.Order sell;
        CLOBSettlement.Order buy;
        CLOBSettlement.Order mo;
        CLOBSettlement.Order to;
        bytes ms;
        bytes ts;
        uint256 qty;
        bool yes;
        uint256 buyerPaid;
    }

    function testFuzz_SplitFills_NeverCrossLimits(uint96 qRaw, uint64 aRaw, uint64 bRaw, bool makerIsSeller, bool yes) public {
        _enableFee();
        SplitCase memory c;
        c.yes = yes;
        c.qty = bound(uint256(qRaw), 1e12, 500e18); // real sizes; a fill worth 0 USDC is FillTooSmall (own test)
        uint256 askP = bound(uint256(aRaw), 0.01e18, 0.9e18);          // seller floor per token
        uint256 bidP = bound(uint256(bRaw), askP + 0.02e18, 0.99e18);  // buyer limit per token (crossing, room for fee)
        address token = yes ? address(yesToken) : address(noToken);
        c.sell = _order(taker, token, address(usdc), c.qty, c.qty * askP / 1e18, block.timestamp + 1 hours, 1);
        c.buy  = _order(maker, address(usdc), token, c.qty * bidP / 1e18 + 1, c.qty, block.timestamp + 1 hours, 1);
        c.mo = makerIsSeller ? c.sell : c.buy;
        c.to = makerIsSeller ? c.buy : c.sell;
        c.ms = _sign(makerIsSeller ? takerKey : makerKey, c.mo);
        c.ts = _sign(makerIsSeller ? makerKey : takerKey, c.to);

        uint256 first = c.qty / 3 == 0 ? 1 : c.qty / 3;
        _splitFill(c, first);
        _splitFill(c, c.qty - first);
        assertLe(c.buyerPaid, c.buy.amountIn, "buyer total never exceeds its signed amountIn");
        assertEq(usdc.balanceOf(address(clob)), 0, "CLOB never holds USDC");
    }

    function _splitFill(SplitCase memory c, uint256 q) internal {
        uint256 b0 = usdc.balanceOf(maker);
        uint256 s0 = usdc.balanceOf(taker);
        // Every generated case crosses with >= 2c of room (more than any fee), so each
        // piece must fill — a revert here is a bug, not a skipped case.
        clob.fillOrders(c.mo, c.ms, c.to, c.ts, q);
        uint256 paid = b0 - usdc.balanceOf(maker);
        uint256 got = usdc.balanceOf(taker) - s0;
        // The buyer pays at most its limit for this piece (rounded up < 1 unit); the
        // seller gets at least its floor (rounded down < 1 unit).
        assertLt(paid * c.qty, q * c.buy.amountIn + c.qty, "buyer never pays a whole unit above its limit");
        // YES floor is on the gross; the fee-free NO seller's floor is on its net.
        assertGt((c.yes ? paid : got) * c.qty + c.qty, q * c.sell.minAmountOut, "seller never gets a whole unit below its floor");
        c.buyerPaid += paid;
    }

    // Whole-order fill size in outcome tokens (CLOBSettlement.tokenQuantity),
    // computed locally so it never consumes a pending vm.expectRevert.
    function _qty(CLOBSettlement.Order memory o) internal view returns (uint256) {
        return o.tokenIn == address(usdc) ? o.minAmountOut : o.amountIn;
    }

}
