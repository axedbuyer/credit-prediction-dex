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
        yesToken = new YESToken(admin);
        noToken  = new NOToken(admin);
        market   = new CreditMarket(
            admin, address(usdc), address(yesToken), address(noToken), 0.23e18, 1 days
        );
        clob = new CLOBSettlement(address(market), admin);

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

        clob.verifyAndSettle(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_));

        assertEq(usdc.balanceOf(maker),     makerUsdcBefore - usdcIn, "maker paid USDC");
        assertEq(yesToken.balanceOf(maker), yesOut,                   "maker received YES");
        assertEq(yesToken.balanceOf(taker), takerYesBefore - yesOut,  "taker gave YES");
        assertEq(usdc.balanceOf(taker),     usdcIn,                   "taker received USDC");
        assertTrue(clob.usedNonces(maker, 0), "maker nonce spent");
        assertTrue(clob.usedNonces(taker, 0), "taker nonce spent");
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

        clob.verifyAndSettle(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_));

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
        clob.verifyAndSettle(mo, ms, to_, ts);
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
        clob.verifyAndSettle(mo, wrongSig, to_, ts);
    }

    function test_DuplicateNonce_Reverts() public {
        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 100e18, 80e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 80e18, 100e18, expiry, 0
        );
        bytes memory ms = _sign(makerKey, mo);
        bytes memory ts = _sign(takerKey, to_);

        clob.verifyAndSettle(mo, ms, to_, ts);

        // Second attempt with same nonces must fail.
        vm.expectRevert(CLOBSettlement.NonceUsed.selector);
        clob.verifyAndSettle(mo, ms, to_, ts);
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
        clob.verifyAndSettle(mo, ms, to_, ts);
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

        clob.verifyAndSettle(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_));

        // After 1 year at 23% mark: cumulativeFundingPerYES = 0.23e18 (exact).
        uint256 expectedCumulative = uint256(0.23e18) * 365 days / 365 days;
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

        clob.verifyAndSettle(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_));

        // credit = 1000e18 * 0.03e18 / 1e18 = 30e18; tradePrice = 950e18.
        assertEq(usdc.balanceOf(taker), takerUsdcBefore + 950e18 + 30e18,
            "seller nets tradePrice ($0.95/token) plus funding credit ($0.03/token) = $0.98/token");
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

        clob.verifyAndSettle(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_));

        // owed = 1000e18 * 0.03e18 / 1e18 = 30e18; tradePrice = 50e18.
        assertEq(usdc.balanceOf(taker), takerUsdcBefore + 50e18 - 30e18,
            "seller nets tradePrice ($0.05/token) minus funding owed ($0.03/token) = $0.02/token");
    }

    function test_YESSale_BelowOwed_Reverts_PositionUnchanged() public {
        _stripTakerToPureYes(); // taker: 1000 YES, 0 NO

        market.grantRole(market.KEEPER_ROLE(), admin);
        market.setMark(0.03e18);

        vm.warp(block.timestamp + 365 days);

        uint256 expiry = block.timestamp + 1 hours;
        // owed = 30e18; priced at 20e18 < owed.
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
        clob.verifyAndSettle(mo, ms, to_, ts);

        assertEq(yesToken.balanceOf(taker), takerYesBefore, "YES balance unchanged after failed sell");
        assertEq(market.fundingSnapshot(taker), snapBefore, "funding snapshot unchanged after failed sell");
        assertFalse(market.claimable(taker), "a failed sell must never flag the position claimable");
        assertFalse(clob.usedNonces(taker, 0), "taker nonce not consumed on revert");
        assertFalse(clob.usedNonces(maker, 0), "maker nonce not consumed on revert");
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

        clob.verifyAndSettle(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_));

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

        clob.verifyAndSettle(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_));

        uint256 cumYes = market.cumulativeFundingPerYES();
        uint256 cumNo  = market.cumFundingPerNO();
        assertEq(market.fundingSnapshot(maker), cumYes, "buyer YES snapshot reset");
        assertEq(market.snapNO(maker),          cumNo,  "buyer NO snapshot reset");
    }

    // ─── v1b1-2c: flagged positions are fully locked out of CLOB trades ────────

    // A flagged holder acting as the SELLER in a CLOB trade must be blocked.
    function test_Lockout_FlaggedSeller_Reverts() public {
        _stripTakerToPureYes(); // taker: 1000 YES, 0 NO

        vm.warp(block.timestamp + 356 days);
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
        clob.verifyAndSettle(mo, ms, to_, ts);
    }

    // A flagged holder acting as the BUYER in a CLOB trade must be blocked, even
    // when the trade itself has nothing to do with the position that got them
    // flagged (maker here buys more YES while already flagged from an earlier,
    // unrelated YES position).
    function test_Lockout_FlaggedBuyer_Reverts() public {
        // Give maker a separate flaggable YES position (independent of the trade below).
        yesToken.mint(maker, 1_000e18); // admin holds MINTER_ROLE from setUp

        vm.warp(block.timestamp + 356 days);
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
        clob.verifyAndSettle(mo, ms, to_, ts);
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

        clob.verifyAndSettle(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_));

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

        clob.verifyAndSettle(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_));

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
        clob.verifyAndSettle(mo, ms, to_, ts);
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
        // owed = 30e18; fee at tradePrice 30.1e18 = 0.1505e18; 30.1 < 30.2505 → revert.
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 30.1e18, 1_000e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 1_000e18, 30.1e18, expiry, 0
        );
        bytes memory ms = _sign(makerKey, mo);
        bytes memory ts = _sign(takerKey, to_);

        uint256 takerYesBefore = yesToken.balanceOf(taker);

        vm.expectRevert(CLOBSettlement.FundingShortfall.selector);
        clob.verifyAndSettle(mo, ms, to_, ts);

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
        // owed = 30e18; tradePrice 50e18 → fee = 0.25e18; seller nets 19.75e18.
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 50e18, 1_000e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 1_000e18, 50e18, expiry, 0
        );

        uint256 takerUsdcBefore = usdc.balanceOf(taker);

        clob.verifyAndSettle(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_));

        assertEq(usdc.balanceOf(taker), takerUsdcBefore + 50e18 - 30e18 - 0.25e18,
            "seller nets tradePrice minus debit minus fee");
        assertEq(market.fundingDebt(taker), 0, "debt collected via markDebtCollected");
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
        clob.verifyAndSettle(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_));
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
}
