// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {YESToken} from "../src/YESToken.sol";
import {NOToken} from "../src/NOToken.sol";
import {CreditMarket} from "../src/CreditMarket.sol";
import {CLOBSettlement} from "../src/CLOBSettlement.sol";
import {OracleRouter} from "../src/OracleRouter.sol";
import {LiquidationEngine} from "../src/LiquidationEngine.sol";
import {InsuranceFund} from "../src/InsuranceFund.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract IntegrationTest is Test {
    MockUSDC usdc;
    YESToken yesToken;
    NOToken  noToken;
    CreditMarket market;
    CLOBSettlement clob;
    OracleRouter router;

    address admin  = address(this);
    address oracle = makeAddr("oracle");

    // Known private keys so vm.sign works for both actors.
    uint256 aliceKey = 0xA11CE;
    uint256 bobKey   = 0xB0B;
    address alice;
    address bob;

    uint256 constant MARK = 0.23e18; // 23 % initial mark

    function setUp() public {
        alice = vm.addr(aliceKey);
        bob   = vm.addr(bobKey);

        // ── deploy all contracts ───────────────────────────────────────────
        usdc     = new MockUSDC();
        yesToken = new YESToken(admin);
        noToken  = new NOToken(admin);
        market   = new CreditMarket(
            admin, address(usdc), address(yesToken), address(noToken), MARK, 1 days
        );
        clob   = new CLOBSettlement(address(market));
        router = new OracleRouter(admin, address(market));

        // ── grant roles ───────────────────────────────────────────────────
        // CreditMarket can mint and burn YES/NO
        yesToken.grantRole(yesToken.MINTER_ROLE(), address(market));
        yesToken.grantRole(yesToken.BURNER_ROLE(), address(market));
        noToken.grantRole(noToken.MINTER_ROLE(),   address(market));
        noToken.grantRole(noToken.BURNER_ROLE(),   address(market));

        // CLOBSettlement can transfer restricted YES/NO tokens and call syncUserFunding
        yesToken.grantRole(yesToken.CLOB_ROLE(), address(clob));
        noToken.grantRole(noToken.CLOB_ROLE(),   address(clob));
        market.grantRole(market.CLOB_ROLE(), address(clob));

        // OracleRouter can trigger credit event on CreditMarket; oracle EOA on router
        market.grantRole(market.ORACLE_ROLE(), address(router));
        router.grantRole(router.ORACLE_ROLE(), oracle);

        // ── fund actors ───────────────────────────────────────────────────
        usdc.mint(alice, 1_000e18);
        usdc.mint(bob,   1_000e18);

        // ── approvals ─────────────────────────────────────────────────────
        vm.startPrank(alice);
        usdc.approve(address(market), type(uint256).max); // for mint
        usdc.approve(address(clob),   type(uint256).max);
        yesToken.approve(address(clob), type(uint256).max);
        noToken.approve(address(clob),  type(uint256).max);
        vm.stopPrank();

        vm.startPrank(bob);
        usdc.approve(address(clob),   type(uint256).max);
        yesToken.approve(address(clob), type(uint256).max);
        noToken.approve(address(clob),  type(uint256).max);
        vm.stopPrank();
    }

    // ── helpers ───────────────────────────────────────────────────────────

    function _order(
        address maker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 expiry,
        uint256 nonce
    ) internal pure returns (CLOBSettlement.Order memory) {
        return CLOBSettlement.Order({
            maker:        maker,
            tokenIn:      tokenIn,
            tokenOut:     tokenOut,
            amountIn:     amountIn,
            minAmountOut: minAmountOut,
            expiry:       expiry,
            nonce:        nonce
        });
    }

    // vm.sign returns (v, r, s); OZ ECDSA expects r ‖ s ‖ v (65 bytes).
    // Compute signatures BEFORE any vm.expectRevert to avoid consumption.
    function _sign(uint256 key, CLOBSettlement.Order memory order)
        internal view returns (bytes memory)
    {
        bytes32 digest = clob.hashOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // ── tests ─────────────────────────────────────────────────────────────

    // Full happy-path: mint → become YES holder via CLOB → accrue carry → close.
    //
    // Steps:
    //   1. Alice mints 230 USDC → 230 YES + 230 NO  (1:1 mint since v1b-1)
    //   2. Alice sells all 230 NO to Bob (CLOB trade 1: Bob pays 230 USDC)
    //   3. vm.warp(30 days) — Alice holds 230 YES, funding accrues
    //   4. Bob sells 230 NO back to Alice (CLOB trade 2: Alice pays 230 USDC)
    //      ↳ CLOBSettlement calls syncUserFunding → fundingDebt[alice] is written
    //   5. Verify Alice's fundingDebt > 0
    //   6. Alice redeems 230 YES + 230 NO → receives 230 USDC minus funding debt
    //   7. Verify total USDC is conserved across all addresses
    //
    // Note on step 4: redeem() burns equal YES+NO pairs. After step 2 Alice holds
    // 0 NO, so a buyback trade is required before she can close via redeem().
    // This trade also triggers the funding sync, making fundingDebt readable.
    function test_FullLifecycle_NormalClose() public {
        // ── 1. alice mints 230 USDC → 230 YES + 230 NO (1:1) ─────────────
        vm.prank(alice);
        market.mint(230e18);

        assertEq(yesToken.balanceOf(alice), 230e18, "alice YES after mint");
        assertEq(noToken.balanceOf(alice),  230e18, "alice NO after mint");
        assertEq(usdc.balanceOf(address(market)), 230e18, "market holds collateral");

        // ── 2. CLOB trade 1: alice sells 230 NO → bob sends 230 USDC ───────
        // alice = maker (sells NO), bob = taker (buys NO with USDC)
        uint256 expiry1 = block.timestamp + 1 hours;
        CLOBSettlement.Order memory a1 = _order(
            alice, address(noToken), address(usdc), 230e18, 230e18, expiry1, 0
        );
        CLOBSettlement.Order memory b1 = _order(
            bob,   address(usdc),    address(noToken), 230e18, 230e18, expiry1, 0
        );
        clob.verifyAndSettle(a1, _sign(aliceKey, a1), b1, _sign(bobKey, b1));

        // post-trade-1 balances
        assertEq(noToken.balanceOf(alice), 0,         "alice sold all NO");
        assertEq(noToken.balanceOf(bob),   230e18,    "bob holds 230 NO");
        assertEq(usdc.balanceOf(alice),    1_000e18,  "alice received USDC from bob");
        assertEq(usdc.balanceOf(bob),      770e18,    "bob spent 230 USDC");
        // CLOB is peer-to-peer — market USDC is untouched
        assertEq(usdc.balanceOf(address(market)), 230e18, "market USDC unchanged");

        // ── 3. 30 days pass while alice holds 230 YES ─────────────────────
        vm.warp(block.timestamp + 30 days);

        // ── 4. CLOB trade 2: bob sells 230 NO back → alice sends 230 USDC ─
        // bob = maker (sells NO), alice = taker (buys NO)
        // CLOBSettlement → syncUserFunding: accrues 30 days and writes fundingDebt[alice]
        uint256 expiry2 = block.timestamp + 1 hours;
        CLOBSettlement.Order memory b2 = _order(
            bob,   address(noToken), address(usdc),    230e18, 230e18, expiry2, 1
        );
        CLOBSettlement.Order memory a2 = _order(
            alice, address(usdc),    address(noToken), 230e18, 230e18, expiry2, 1
        );
        clob.verifyAndSettle(b2, _sign(bobKey, b2), a2, _sign(aliceKey, a2));

        // alice: 230 YES + 230 NO + 770 USDC — fully balanced for redeem
        assertEq(yesToken.balanceOf(alice), 230e18,   "alice YES unchanged");
        assertEq(noToken.balanceOf(alice),  230e18,   "alice reacquired 230 NO");
        assertEq(usdc.balanceOf(alice),     770e18,   "alice USDC after buyback");

        // ── 5. verify funding debt was written by trade-2 sync ─────────────
        // cumulative = 0.23e18 * 30 days / 365 days (integer math matches contract)
        uint256 expectedCumulative = MARK * 30 days / 365 days;
        uint256 expectedDebt       = 230e18 * expectedCumulative / 1e18;

        assertEq(market.cumulativeFundingPerYES(), expectedCumulative,
            "cumulative funding accrued correctly");
        assertEq(market.fundingDebt(alice), expectedDebt,
            "alice funding debt matches 30-day carry on 230 YES");
        assertGt(market.fundingDebt(alice), 0, "funding debt is non-zero");

        // ── 6. alice redeems 230 YES + 230 NO ─────────────────────────────
        uint256 aliceUsdcBefore = usdc.balanceOf(alice); // 540e18
        vm.prank(alice);
        market.redeem(230e18);

        assertEq(yesToken.balanceOf(alice), 0, "YES fully burned on redeem");
        assertEq(noToken.balanceOf(alice),  0, "NO fully burned on redeem");
        assertEq(market.fundingDebt(alice), 0, "funding debt cleared on redeem");

        uint256 expectedPayout = 230e18 - expectedDebt; // funding deducted from payout
        assertEq(usdc.balanceOf(alice), aliceUsdcBefore + expectedPayout,
            "alice receives 230 USDC minus accrued carry");
        assertLt(usdc.balanceOf(alice), aliceUsdcBefore + 230e18,
            "payout is strictly less than 230 due to funding");

        // ── 7. total USDC conservation ────────────────────────────────────
        // Initial: 1 000 (alice) + 1 000 (bob) = 2 000.
        // No USDC is ever created or destroyed — only redistributed.
        uint256 total = usdc.balanceOf(alice)
                      + usdc.balanceOf(bob)
                      + usdc.balanceOf(address(market));
        assertEq(total, 2_000e18, "USDC invariant: total supply conserved");
    }

    // Credit event path: mint → become YES holder → credit event → settleYES.
    //
    // Steps:
    //   1. Alice mints 230 USDC → 230 YES + 230 NO  (1:1 mint since v1b-1)
    //   2. Alice sells all 230 NO to Bob (CLOB trade: Bob pays 230 USDC)
    //      → alice: 230 YES  bob: 230 NO
    //   3. vm.warp(60 days) — alice holds pure YES the whole time, so this accrues
    //      a funding debit against her that is never settled anywhere else
    //   4. OracleRouter.confirmCreditEvent() — market paused, flag set
    //   5. mint() and redeem() both revert
    //   6. Alice calls settleYES(230) → settleFunding nets her accrued YES debit
    //      first; she receives 230 minus that debit, not the full notional (v1b1-2b-3:
    //      settleYES routes funding through settleFunding + collateral, no pool)
    //   7. Bob (NO holder) tries settleYES → reverts (no YES to burn)
    //   8. Market retains exactly alice's deducted debit (the funding owed stays in
    //      collateral — nobody currently collects it on Bob's behalf, a known gap)
    function test_FullLifecycle_CreditEvent() public {
        // ── 1. alice mints 230 USDC → 230 YES + 230 NO (1:1) ─────────────
        vm.prank(alice);
        market.mint(230e18);

        // ── 2. CLOB trade: alice sells 230 NO → bob sends 230 USDC ─────────
        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory ao = _order(
            alice, address(noToken), address(usdc),    230e18, 230e18, expiry, 0
        );
        CLOBSettlement.Order memory bo = _order(
            bob,   address(usdc),    address(noToken), 230e18, 230e18, expiry, 0
        );
        clob.verifyAndSettle(ao, _sign(aliceKey, ao), bo, _sign(bobKey, bo));

        // alice: 230 YES, 0 NO, 1 000 USDC
        // bob:   0 YES, 230 NO, 770 USDC
        assertEq(yesToken.balanceOf(alice), 230e18, "alice holds YES");
        assertEq(noToken.balanceOf(bob),    230e18, "bob holds NO");
        assertEq(yesToken.balanceOf(bob),   0,      "bob has no YES");
        assertEq(usdc.balanceOf(address(market)), 230e18, "market USDC unchanged");

        // ── 3. 60 days pass ───────────────────────────────────────────────
        vm.warp(block.timestamp + 60 days);

        // ── 4. credit event confirmed via OracleRouter ─────────────────────
        vm.prank(oracle);
        router.confirmCreditEvent();

        assertTrue(market.creditEventConfirmed(), "credit event flag set");
        assertTrue(market.paused(),               "market paused after event");

        // ── 5. mint() and redeem() are blocked ────────────────────────────
        usdc.mint(alice, 1e18); // give alice a bit of USDC to attempt mint
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        market.mint(1e18);

        vm.prank(alice);
        vm.expectRevert(); // whenNotPaused fires
        market.redeem(1e18);

        // ── 6. alice settleYES(230) → notional minus accrued YES debit ─────
        // 60 days at 23% mark: cumulativeFundingPerYES = 0.23e18 * 60d / 365d.
        uint256 expectedCum  = uint256(0.23e18) * 60 days / 365 days;
        uint256 expectedOwed = 230e18 * expectedCum / 1e18;

        uint256 aliceUsdcBefore = usdc.balanceOf(alice); // 1 000 + 1 from test setup above
        vm.prank(alice);
        market.settleYES(230e18);

        assertEq(yesToken.balanceOf(alice), 0, "alice YES burned on settlement");
        assertEq(usdc.balanceOf(alice), aliceUsdcBefore + 230e18 - expectedOwed,
            "alice receives notional minus accrued funding debit (settled via collateral)");

        // ── 7. bob (NO holder) cannot redeem or settle ────────────────────
        vm.prank(bob);
        vm.expectRevert(); // ERC20InsufficientBalance — bob has 0 YES to burn
        market.settleYES(1);

        assertEq(noToken.balanceOf(bob), 230e18, "bob NO tokens still exist but worthless");

        // ── 8. market retains exactly alice's deducted debit ──────────────
        // market started with 230 USDC (alice's mint); paid out (230 - owed) to
        // alice's YES settlement, so `owed` stays in collateral (no pool payout
        // mechanism collects it on bob's behalf here — a known follow-up gap).
        assertEq(usdc.balanceOf(address(market)), expectedOwed,
            "market retains alice's funding debit in collateral; bob's NO worthless");

        // total USDC conservation: 1 000 (alice initial) + 1 000 (bob initial) + 1 (test mint) = 2 001
        uint256 total = usdc.balanceOf(alice)
                      + usdc.balanceOf(bob)
                      + usdc.balanceOf(address(market));
        assertEq(total, 2_001e18, "USDC invariant: total supply conserved through credit event");
    }
}

// ─── v1b lifecycle integration tests ─────────────────────────────────────────
//
// Fresh fixture at 5% mark (the "worked example" mark from CLAUDE.md).
// Tests cover: funding accrual, formulaic seizure trigger, liquidation claim,
// and normal close — plus all conservation invariants from the spec.
contract IntegrationV1bTest is Test {
    MockUSDC          usdc;
    YESToken          yesToken;
    NOToken           noToken;
    CreditMarket      market;
    CLOBSettlement    clob;
    LiquidationEngine liquidationEngine;
    InsuranceFund     insuranceFund;

    address admin  = address(this);
    address keeper = makeAddr("keeper_v1b");

    uint256 aliceKey = 0xA11CE;
    uint256 bobKey   = 0xB0B;
    uint256 carolKey = 0xCA501; // liquidator
    address alice;
    address bob;
    address carol;

    uint256 constant MARK_5PCT  = 0.05e18;
    uint256 constant MARK_8PCT  = 0.08e18;
    uint256 constant MARK_20PCT = 0.20e18;
    uint256 constant NOTIONAL   = 100e18;

    function setUp() public {
        alice = vm.addr(aliceKey);
        bob   = vm.addr(bobKey);
        carol = vm.addr(carolKey);

        // ── deploy ─────────────────────────────────────────────────────────
        usdc              = new MockUSDC();
        yesToken          = new YESToken(admin);
        noToken           = new NOToken(admin);
        market            = new CreditMarket(
            admin, address(usdc), address(yesToken), address(noToken), MARK_5PCT, 1 days
        );
        clob              = new CLOBSettlement(address(market));
        insuranceFund     = new InsuranceFund(admin, address(usdc));
        liquidationEngine = new LiquidationEngine(address(market), address(insuranceFund));

        // ── token roles ────────────────────────────────────────────────────
        yesToken.grantRole(yesToken.MINTER_ROLE(), address(market));
        yesToken.grantRole(yesToken.BURNER_ROLE(), address(market));
        noToken.grantRole(noToken.MINTER_ROLE(),   address(market));
        noToken.grantRole(noToken.BURNER_ROLE(),   address(market));

        // ── CLOB roles ─────────────────────────────────────────────────────
        yesToken.grantRole(yesToken.CLOB_ROLE(), address(clob));
        noToken.grantRole(noToken.CLOB_ROLE(),   address(clob));
        market.grantRole(market.CLOB_ROLE(), address(clob));

        // ── LiquidationEngine roles ────────────────────────────────────────
        yesToken.grantRole(yesToken.CLOB_ROLE(),      address(liquidationEngine)); // forcedTransfer
        market.grantRole(market.LIQUIDATOR_ROLE(),     address(liquidationEngine)); // clearLiquidatedPosition
        insuranceFund.grantRole(
            insuranceFund.LIQUIDATOR_ROLE(), address(liquidationEngine)            // coverShortfall
        );

        // ── keeper ─────────────────────────────────────────────────────────
        market.grantRole(market.KEEPER_ROLE(), keeper);

        // ── fund actors ────────────────────────────────────────────────────
        usdc.mint(alice, 1_000e18);
        usdc.mint(bob,   1_000e18);
        usdc.mint(carol, 10e18);                     // covers P ≈ 4.85 USDC at 5%/354d
        usdc.mint(address(insuranceFund), 1_000e18); // pre-funded for tail-case coverage

        // ── approvals ──────────────────────────────────────────────────────
        vm.startPrank(alice);
        usdc.approve(address(market), type(uint256).max);
        usdc.approve(address(clob),   type(uint256).max);
        yesToken.approve(address(clob), type(uint256).max);
        noToken.approve(address(clob),  type(uint256).max);
        vm.stopPrank();

        vm.startPrank(bob);
        usdc.approve(address(clob),   type(uint256).max);
        yesToken.approve(address(clob), type(uint256).max);
        noToken.approve(address(clob),  type(uint256).max);
        vm.stopPrank();

        vm.startPrank(carol);
        usdc.approve(address(liquidationEngine), type(uint256).max);
        vm.stopPrank();
    }

    function _order(
        address maker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 expiry,
        uint256 nonce
    ) internal pure returns (CLOBSettlement.Order memory) {
        return CLOBSettlement.Order({
            maker:        maker,
            tokenIn:      tokenIn,
            tokenOut:     tokenOut,
            amountIn:     amountIn,
            minAmountOut: minAmountOut,
            expiry:       expiry,
            nonce:        nonce
        });
    }

    function _sign(uint256 key, CLOBSettlement.Order memory order)
        internal view returns (bytes memory)
    {
        bytes32 digest = clob.hashOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // Liquidation lifecycle at the 5% worked example.
    //
    // Acceleration: warp 354 days in one vm.warp + one accrueFunding() call.
    // _accrueFunding() integrates elapsed time, so a single call is identical to
    // 354 daily calls. At m=5%, 354 days crosses the seizure threshold
    // (m/1.03 − Δf ≈ 4.840e−2 per unit; 354d accrual ≈ 4.849e−2).
    function test_v1b_FullLifecycle_LiquidationPath() public {
        // ── 1. Alice mints $100 at 5% mark → 100 YES + 100 NO ─────────────
        vm.prank(alice);
        market.mint(NOTIONAL);

        assertEq(yesToken.balanceOf(alice), NOTIONAL,  "alice YES after mint");
        assertEq(noToken.balanceOf(alice),  NOTIONAL,  "alice NO after mint");
        assertEq(market.costBasis(alice),   MARK_5PCT, "costBasis == 5% entry mark");

        // ── 2. Alice sells 100 NO to Bob (Bob pays 100 USDC, 1:1) ──────────
        // Alice becomes a pure YES holder; Bob holds the matching NO.
        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory a1 = _order(
            alice, address(noToken), address(usdc), NOTIONAL, NOTIONAL, expiry, 0
        );
        CLOBSettlement.Order memory b1 = _order(
            bob,   address(usdc), address(noToken), NOTIONAL, NOTIONAL, expiry, 0
        );
        clob.verifyAndSettle(a1, _sign(aliceKey, a1), b1, _sign(bobKey, b1));

        assertEq(noToken.balanceOf(alice),  0,        "alice sold all NO");
        assertEq(noToken.balanceOf(bob),    NOTIONAL, "bob holds 100 NO");
        assertEq(yesToken.balanceOf(alice), NOTIONAL, "alice holds 100 YES");

        // ── 3. Warp 354 days; accumulate all carry in one call ─────────────
        vm.warp(block.timestamp + 354 days);
        market.accrueFunding();

        assertTrue(market.isSeizable(alice), "alice seizable after 354 days bleed at 5%");
        assertFalse(market.isSeizable(bob),  "bob (NO holder, zero YES balance) never seizable");

        // ── 4. Keeper flags Alice's position ───────────────────────────────
        vm.prank(keeper);
        market.flagClaimable(alice);

        assertTrue(market.claimable(alice), "alice flagged claimable");

        // No intermediate sync → frozenFunding == full 354-day cumulative per unit.
        uint256 frozenPerUnit = market.frozenFunding(alice);
        assertEq(frozenPerUnit, market.cumulativeFundingPerYES(),
            "frozenFunding == 354-day cumulative (fundingSnapshot was 0 at mint, no mid-sync)");
        assertGt(frozenPerUnit, 0, "frozen funding non-zero");

        // ── 5. Carol claims the flagged position ───────────────────────────
        uint256 aliceYesBefore  = yesToken.balanceOf(alice); // 100e18
        uint256 bobNoBefore     = noToken.balanceOf(bob);    // 100e18
        uint256 aliceUsdcBefore = usdc.balanceOf(alice);
        uint256 carolUsdcBefore = usdc.balanceOf(carol);

        // P = prevDebt(0) + frozenPerUnit × Q / 1e18 (normal case: P < tokenValue)
        uint256 P          = frozenPerUnit * NOTIONAL / 1e18;
        uint256 tokenValue = NOTIONAL * market.currentMark() / 1e18; // 100 × 0.05 = 5 USDC
        assertLt(P, tokenValue, "pre-claim: funding owed < token value (normal case confirmed)");

        vm.prank(carol);
        liquidationEngine.claim(alice);

        // ── 6. Assertions ──────────────────────────────────────────────────

        // (a) YES transferred to Carol — never burned
        assertEq(yesToken.balanceOf(carol), aliceYesBefore,
            "carol holds alice's YES tokens after claim");

        // (b) Alice: YES balance zero; received no USDC (residual goes to liquidator as profit)
        assertEq(yesToken.balanceOf(alice), 0,               "alice YES zero post-claim");
        assertEq(usdc.balanceOf(alice),     aliceUsdcBefore, "alice received no USDC from claim");

        // (c) Bob's NO balance untouched (NO holders unaffected by liquidation)
        assertEq(noToken.balanceOf(bob), bobNoBefore, "bob NO balance unchanged");

        // (d) Complete-set invariant: YES and NO supply must remain equal
        assertEq(yesToken.totalSupply(), noToken.totalSupply(),
            "complete-set invariant: YES.totalSupply() == NO.totalSupply()");
        assertEq(yesToken.totalSupply(), NOTIONAL,
            "YES supply unchanged (forcedTransfer, not burn)");

        // (e) NO accretion: noFundingCredit(bob) == P
        //     P   = frozenPerUnit × 100e18 / 1e18 = frozenPerUnit × 100
        //     noFundingCredit(bob) = 100e18 × (cumFundingPerNO − snapNO[bob]) / 1e18
        //       where snapNO[bob] = 0 (set at initial CLOB trade when cumFundingPerNO = 0)
        //     Since cumFundingPerNO == frozenPerUnit (no time elapsed between flag and claim),
        //     both equal frozenPerUnit × 100. ✓
        assertEq(market.noFundingCredit(bob), P,
            "bob noFundingCredit == P (liquidator payment replenishes NO accretion pool)");

        // (f) Liquidator sliver ≈ 3% of token value (the seizure buffer is the profit incentive)
        uint256 sliver = tokenValue - P;
        assertGt(sliver, tokenValue * 29 / 1000, "sliver > 2.9% of token value");
        assertLt(sliver, tokenValue * 31 / 1000, "sliver < 3.1% of token value");

        // (g) Carol paid exactly P USDC
        assertEq(usdc.balanceOf(carol), carolUsdcBefore - P, "carol's USDC decreased by P");

        // (h) USDC conservation across all parties
        // carol(P) → market; everything else unchanged. Total = initial sum = 3 010.
        uint256 total = usdc.balanceOf(alice)
                      + usdc.balanceOf(bob)
                      + usdc.balanceOf(carol)
                      + usdc.balanceOf(address(market))
                      + usdc.balanceOf(address(insuranceFund));
        assertEq(total, 1_000e18 + 1_000e18 + 10e18 + 1_000e18,
            "USDC conservation: total supply unchanged across all parties");
    }

    // Normal close (mark appreciation, no liquidation).
    //
    // Mark path: 5% → 8% (at 30d) → 20% (at 60d), close at 90d.
    // setMark() accrues at the old mark first, so each leg's carry is exact.
    // Alice closes via redeem well before the seizure trigger fires.
    function test_v1b_FullLifecycle_NormalClose() public {
        // ── 1. Alice mints $100 at 5% mark → 100 YES + 100 NO ─────────────
        vm.prank(alice);
        market.mint(NOTIONAL);

        assertEq(market.costBasis(alice), MARK_5PCT, "costBasis == 5% entry mark");

        // ── 2. Alice sells 100 NO to Bob (Bob pays 100 USDC) ───────────────
        uint256 expiry1 = block.timestamp + 1 hours;
        CLOBSettlement.Order memory a1 = _order(
            alice, address(noToken), address(usdc), NOTIONAL, NOTIONAL, expiry1, 0
        );
        CLOBSettlement.Order memory b1 = _order(
            bob,   address(usdc), address(noToken), NOTIONAL, NOTIONAL, expiry1, 0
        );
        clob.verifyAndSettle(a1, _sign(aliceKey, a1), b1, _sign(bobKey, b1));

        assertEq(noToken.balanceOf(bob),    NOTIONAL, "bob holds 100 NO");
        assertEq(yesToken.balanceOf(alice), NOTIONAL, "alice holds 100 YES");

        // ── 3. Mark path: 5% → 8% → 20% over 90 days ─────────────────────
        vm.warp(block.timestamp + 30 days);
        vm.prank(keeper);
        market.setMark(MARK_8PCT);  // accrues 30d at 5%, then changes mark

        vm.warp(block.timestamp + 30 days);
        vm.prank(keeper);
        market.setMark(MARK_20PCT); // accrues 30d at 8%, then changes mark

        vm.warp(block.timestamp + 30 days);
        market.accrueFunding();     // accrues 30d at 20%

        // cumFundingPerYES after 90 days ≈ (1.5 + 2.4 + 6.0) / 365 × 1e18 ≈ 2.712e16
        // At mark 20%, seizure needs f_now ≈ 19.4e16 — far from triggered.
        assertFalse(market.isSeizable(alice),
            "no seizure: rising mark leaves abundant equity after 90 days");

        // ── 4. Capture display-layer values BEFORE the closing CLOB trade ──
        // syncUserFunding fires during the buyback, resetting fundingSnapshot[alice]
        // and driving fPerUnit to zero — must read before that happens.
        uint256 aliceEquity    = market.equity(alice);
        uint256 aliceCostBasis = market.costBasis(alice);
        int256  alicePnl       = market.pnl(alice);

        // Conservation snapshot: NO credit (bob) == YES funding owed (alice).
        // Both equal 100e18 × cumFundingPerYES / 1e18 since both snapshots are 0.
        uint256 bobNoCredit  = market.noFundingCredit(bob);
        uint256 aliceYesOwed = market.yesFundingOwed(alice);

        // P&L formula: pnl = equity − costBasis
        assertEq(alicePnl, int256(aliceEquity) - int256(aliceCostBasis),
            "pnl == equity - costBasis (display-layer formula)");

        // Positive P&L: mark rose 5% → 20%, funding ≈ 2.7% (well below the 15% MTM gain)
        assertGt(alicePnl, 0, "alice P&L positive after mark appreciation");

        // Equity is mark minus accumulated funding
        assertLt(aliceEquity, market.currentMark(), "equity < mark (carry deducted)");
        assertGt(aliceEquity, 0,                    "equity positive (not underwater)");

        // Conservation: YES funding owed == NO funding credited (same index, same balance)
        assertEq(bobNoCredit, aliceYesOwed,
            "conservation: NO credit == YES funding owed (cumFundingPerNO == cumFundingPerYES)");

        // ── 5. Close: Alice buys back 100 NO from Bob, then redeems ────────
        // Buyback triggers syncUserFunding for both parties, settling Alice's debt.
        uint256 expiry2 = block.timestamp + 1 hours;
        CLOBSettlement.Order memory b2 = _order(
            bob,   address(noToken), address(usdc), NOTIONAL, NOTIONAL, expiry2, 1
        );
        CLOBSettlement.Order memory a2 = _order(
            alice, address(usdc), address(noToken), NOTIONAL, NOTIONAL, expiry2, 1
        );
        clob.verifyAndSettle(b2, _sign(bobKey, b2), a2, _sign(aliceKey, a2));

        // Funding debt is now settled into fundingDebt[alice] by the sync.
        uint256 aliceUsdcBeforeRedeem = usdc.balanceOf(alice);
        uint256 fundingDebtAtClose    = market.fundingDebt(alice);

        // The debt set by sync == aliceYesOwed captured above (same formula, no elapsed time).
        assertEq(fundingDebtAtClose, aliceYesOwed,
            "funding debt at close == pre-sync YES funding owed (same cumulative, same balance)");

        vm.prank(alice);
        market.redeem(NOTIONAL);

        assertEq(yesToken.balanceOf(alice), 0, "YES burned on redeem");
        assertEq(noToken.balanceOf(alice),  0, "NO burned on redeem");
        assertEq(market.fundingDebt(alice), 0, "funding debt cleared on redeem");

        // Payout = notional − funding debt
        assertEq(
            usdc.balanceOf(alice),
            aliceUsdcBeforeRedeem + NOTIONAL - fundingDebtAtClose,
            "alice receives notional minus accrued carry"
        );
        assertLt(fundingDebtAtClose, NOTIONAL, "funding debt < full notional (position solvent)");

        // ── 6. USDC conservation ────────────────────────────────────────────
        // alice: 1000 − 100 (mint) + 100 (NO sale) − 100 (NO buyback) + (100 − debt) = 1000 − debt
        // bob:   1000 − 100 (NO purchase) + 100 (NO sale) = 1000
        // market: +100 (mint) − (100 − debt) (redeem payout) = debt
        // Total: 2 000 (alice and bob's initial USDC)
        uint256 total = usdc.balanceOf(alice)
                      + usdc.balanceOf(bob)
                      + usdc.balanceOf(address(market));
        assertEq(total, 2_000e18, "USDC conservation: total unchanged");
    }
}
