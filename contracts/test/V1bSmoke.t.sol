// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {YESToken} from "../src/YESToken.sol";
import {NOToken} from "../src/NOToken.sol";
import {CreditMarket} from "../src/CreditMarket.sol";
import {InsuranceFund} from "../src/InsuranceFund.sol";
import {LiquidationEngine} from "../src/LiquidationEngine.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

// End-to-end v1b smoke test.
//
// Actors:
//   alice — the YES position holder (gets liquidated)
//   bob   — counterparty, holds the matching NO tokens
//   carol — liquidator (third wallet, calls claim)
//   dave  — second YES holder used only in the cost-basis independence test
//
// Three top-level scenarios:
//   1. Normal case — steps 1-5 from the spec
//   2. Tail case   — frozenFunding > tokenValue at flag time; InsuranceFund covers shortfall
//   3. Cost-basis independence — negative-MTM holder and at-par holder trigger identically
contract V1bSmokeTest is Test {
    MockUSDC      usdc;
    YESToken      yes;
    NOToken       no;
    CreditMarket  market;
    InsuranceFund insuranceFund;
    LiquidationEngine engine;

    address admin  = address(this);
    address keeper = makeAddr("keeper");
    address oracle = makeAddr("oracle");
    address alice  = makeAddr("alice");
    address bob    = makeAddr("bob");
    address carol  = makeAddr("carol");
    address dave   = makeAddr("dave");

    uint256 constant MARK_5PCT  = 0.05e18;
    uint256 constant MARK_10PCT = 0.10e18;
    uint256 constant MINT_AMT   = 1_000e18;

    function setUp() public {
        usdc = new MockUSDC();
        yes  = new YESToken(admin);
        no   = new NOToken(admin);

        // 1-day epoch, 5% initial mark
        market = new CreditMarket(
            admin, address(usdc), address(yes), address(no),
            MARK_5PCT, 1 days
        );

        insuranceFund = new InsuranceFund(admin, address(usdc));
        engine = new LiquidationEngine(address(market), address(insuranceFund));

        // Token roles
        yes.grantRole(yes.MINTER_ROLE(), address(market));
        yes.grantRole(yes.BURNER_ROLE(), address(market));
        yes.grantRole(yes.CLOB_ROLE(),   address(engine));  // allows forcedTransfer
        no.grantRole(no.MINTER_ROLE(),   address(market));
        no.grantRole(no.BURNER_ROLE(),   address(market));

        // Contract roles
        market.grantRole(market.KEEPER_ROLE(),     keeper);
        market.grantRole(market.ORACLE_ROLE(),     oracle);
        market.grantRole(market.LIQUIDATOR_ROLE(), address(engine));
        insuranceFund.grantRole(insuranceFund.LIQUIDATOR_ROLE(), address(engine));

        // Seed InsuranceFund for tail-case coverage
        usdc.mint(address(insuranceFund), 100_000e18);

        // Fund actors
        usdc.mint(alice, 10_000e18);
        usdc.mint(bob,   10_000e18);
        usdc.mint(carol, 10_000e18);
        usdc.mint(dave,  10_000e18);

        vm.prank(alice); usdc.approve(address(market), type(uint256).max);
        vm.prank(bob);   usdc.approve(address(market), type(uint256).max);
        vm.prank(carol); usdc.approve(address(engine),  type(uint256).max);
        vm.prank(dave);  usdc.approve(address(market), type(uint256).max);
    }

    // ─── helper ───────────────────────────────────────────────────────────────

    // Returns the total USDC owed for a flagged position (prevDebt + per-unit × Q).
    function _fFrozenTotal(address holder) internal view returns (uint256) {
        uint256 Q        = yes.balanceOf(holder);
        uint256 perUnit  = market.frozenFunding(holder);
        uint256 prevDebt = market.fundingDebt(holder);
        return prevDebt + perUnit * Q / 1e18;
    }

    // ─── Smoke test 1: Normal case, steps 1-5 ────────────────────────────────
    //
    // 1. Alice mints at 5%; Bob mints the matching NO.
    // 2. Warp time: verify isSeizable false at 353 d, true at 354 d (worked example).
    // 3. flagClaimable(Alice): confirm frozenFunding == yesFundingOwed at flag time.
    // 4. Carol calls LiquidationEngine.claim(Alice).
    // 5. Assert: Carol holds Alice's YES; Alice.YES=0; Alice USDC unchanged;
    //    Bob.NO unchanged; noFundingCredit(Bob) == P; totalSupply invariant.
    function test_smoke_01_normalCase() public {
        // ── Step 1 ────────────────────────────────────────────────────────────
        vm.prank(alice); market.mint(MINT_AMT);  // 1000 YES + 1000 NO to alice
        vm.prank(bob);   market.mint(MINT_AMT);  // 1000 YES + 1000 NO to bob (holds NO)

        // ── Step 2: isSeizable false → true transition ────────────────────────
        // Worked example (CLAUDE.md): daily epoch at 5% → ~354 epochs runway.
        // Exact Solidity arithmetic:
        //   deltaF  = 0.05e18 * 1 day / 365 days = 136_986_301_369_863
        //   m/1.03  = 48_543_689_320_388_349
        //   After 353 days: fNow = 48_356_164_383_561_643 → fNext*1.03 < m  (NOT seizable)
        //   After 354 days: fNow = 48_493_150_684_931_506 → fNext*1.03 >= m (seizable)

        vm.warp(block.timestamp + 353 days);
        market.accrueFunding();
        assertFalse(market.isSeizable(alice), "isSeizable must be false at 353 days");

        // epochsToExpire: 1 full epoch of runway left
        uint256 ete353 = market.epochsToExpire(alice);
        assertGt(ete353, 0,                  "epochsToExpire > 0 at 353 days");
        assertLt(ete353, type(uint256).max,  "epochsToExpire < max at 353 days");

        vm.warp(block.timestamp + 1 days);   // now 354 days total
        market.accrueFunding();
        assertTrue(market.isSeizable(alice), "isSeizable must be true at 354 days");

        // At exactly 354 days the per-unit f_now is still just below m/1.03,
        // so the formula returns 0 (no full epochs remain) rather than max.
        assertEq(market.epochsToExpire(alice), 0, "epochsToExpire = 0 at trigger boundary");

        // ── Step 3: flag and verify frozenFunding == yesFundingOwed ──────────
        // Capture before flagging; flagClaimable calls _accrueFunding() with elapsed=0
        // (same block), so the global index doesn't move.
        uint256 yesOwedAtFlag = market.yesFundingOwed(alice);

        vm.prank(keeper);
        market.flagClaimable(alice);

        assertTrue(market.claimable(alice),  "alice must be claimable after flag");

        uint256 Q        = yes.balanceOf(alice);        // 1000e18 (unchanged)
        uint256 fPerUnit = market.frozenFunding(alice); // per-unit index delta
        uint256 prevDebt = market.fundingDebt(alice);   // 0 — no prior intermediate syncs
        uint256 fFrozen  = prevDebt + fPerUnit * Q / 1e18;

        assertEq(fFrozen, yesOwedAtFlag,
            "fFrozenTotal must equal yesFundingOwed at flag time");

        // Normal case: funding owed < token value (3% buffer not yet fully eroded)
        uint256 tokenValue = Q * market.currentMark() / 1e18;
        assertLt(fFrozen, tokenValue,
            "normal case: fFrozenTotal must be less than tokenValue");
        uint256 P = fFrozen; // normal case: P = fFrozenTotal

        // Bob holds 1000 NO, started at index=0 (same as alice's fundingSnapshot).
        // His noFundingCredit should equal exactly P because both indices and balances match.
        assertEq(market.noFundingCredit(bob), P,
            "noFundingCredit(bob) must equal P: NO accretion exactly covers liquidator payment");

        // ── Step 4: Carol (third wallet) claims Alice ─────────────────────────
        uint256 aliceUsdcBefore  = usdc.balanceOf(alice);
        uint256 bobNoBefore      = no.balanceOf(bob);
        uint256 carolYesBefore   = yes.balanceOf(carol);
        uint256 mktUsdcBefore    = usdc.balanceOf(address(market));

        vm.prank(carol);
        engine.claim(alice);

        // ── Step 5: invariant checks ──────────────────────────────────────────

        // Carol now holds Alice's YES tokens
        assertEq(yes.balanceOf(carol), carolYesBefore + Q, "carol must receive alice's YES");
        assertEq(yes.balanceOf(alice), 0,                   "alice YES balance must be 0");

        // Alice received no residual USDC — the sliver (tokenValue − P) is the liquidator's
        assertEq(usdc.balanceOf(alice), aliceUsdcBefore, "alice USDC must be unchanged (no residual)");

        // Bob's NO balance is entirely untouched
        assertEq(no.balanceOf(bob), bobNoBefore, "bob NO balance must be unchanged");

        // CreditMarket received exactly P (the NO accretion pool is replenished)
        assertEq(usdc.balanceOf(address(market)), mktUsdcBefore + P,
            "market must receive P USDC from liquidator");

        // noFundingCredit(bob) is unchanged (same block → _accrueFunding() no-op in clearLiquidatedPosition)
        assertEq(market.noFundingCredit(bob), P,
            "noFundingCredit(bob) must be unchanged after claim (no time elapsed)");

        // Complete-set invariant: YES.totalSupply() == NO.totalSupply() always
        assertEq(yes.totalSupply(), no.totalSupply(),
            "complete-set invariant: YES.totalSupply() must equal NO.totalSupply()");

        // Carol's snapshot resets — she owes no back-funding on the inherited YES tokens
        assertEq(market.fundingSnapshot(carol), market.cumulativeFundingPerYES(),
            "carol fundingSnapshot must reset to current index (no back-funding)");
        assertEq(market.yesFundingOwed(carol), 0,
            "carol must owe 0 back-funding immediately after claim");
    }

    // ─── Smoke test 2: Tail case ──────────────────────────────────────────────
    //
    // Steps 1-4 repeated but with a forced tail case: warp far enough that
    // fFrozenTotal > tokenValue AT FLAG TIME (no post-flag mark manipulation).
    // At 5% mark: after 365 days f_now ≈ m; after 370 days f_now > m → tail case.
    // InsuranceFund must cover the shortfall; Bob's NO must still be fully made whole.
    function test_smoke_02_tailCase_frozenFundingExceedsTokenValueAtFlag() public {
        vm.prank(alice); market.mint(MINT_AMT);
        vm.prank(bob);   market.mint(MINT_AMT);

        // 370 days at 5% mark:
        //   f_now = 0.05e18 * 370 / 365 ≈ 0.05068e18 > m (0.05e18) → tail case at flag.
        vm.warp(block.timestamp + 370 days);
        market.accrueFunding();

        assertTrue(market.isSeizable(alice), "must be seizable at 370 days");

        vm.prank(keeper);
        market.flagClaimable(alice);

        uint256 Q            = yes.balanceOf(alice);
        uint256 m            = market.currentMark();
        uint256 fFrozen      = _fFrozenTotal(alice);
        uint256 tokenValue   = Q * m / 1e18;

        // Confirm this is a genuine tail case at flag time (no mark manipulation needed)
        assertGt(fFrozen, tokenValue,
            "tail case: fFrozenTotal must exceed tokenValue at flag time");

        uint256 shortfall    = fFrozen - tokenValue;
        uint256 ifBefore     = usdc.balanceOf(address(insuranceFund));
        uint256 mktBefore    = usdc.balanceOf(address(market));
        uint256 bobNoBefore  = no.balanceOf(bob);

        vm.prank(carol);
        engine.claim(alice);

        // InsuranceFund debited by exactly the shortfall
        assertEq(usdc.balanceOf(address(insuranceFund)), ifBefore - shortfall,
            "InsuranceFund must be debited by exact shortfall");

        // CreditMarket received tokenValue (from carol) + shortfall (from IF) = fFrozen total
        assertEq(usdc.balanceOf(address(market)), mktBefore + fFrozen,
            "CreditMarket must receive full fFrozenTotal so NO is made whole");

        // Bob's NO balance is unchanged
        assertEq(no.balanceOf(bob), bobNoBefore, "bob NO must be unchanged in tail case");

        // Carol received Alice's YES tokens (never burned)
        assertEq(yes.balanceOf(alice), 0,           "alice YES must be 0 in tail case");
        assertGt(yes.balanceOf(carol), 0,            "carol must hold alice's YES in tail case");

        // Complete-set invariant holds in the tail case too
        assertEq(yes.totalSupply(), no.totalSupply(),
            "complete-set invariant must hold in tail case");
    }

    // ─── Smoke test 3: Cost-basis independence ────────────────────────────────
    //
    // Alice mints at 10% mark (costBasis = 10%) — immediately underwater when mark
    // drops to 5%.  Dave mints at 5% (costBasis = 5%).  Both have fundingSnapshot = 0.
    //
    // The seizure trigger depends only on fNow (since entry) and m — NOT on costBasis.
    // Two holders with identical funding/mark exposure but different entry prices must
    // trigger isSeizable identically, and both must be flaggable and claimable.
    function test_smoke_03_costBasisIndependence() public {
        // Set mark to 10%; Alice mints (costBasis = 10%)
        vm.prank(keeper);
        market.setMark(MARK_10PCT);

        vm.prank(alice);
        market.mint(MINT_AMT); // costBasis[alice] = 0.10e18

        // Drop mark to 5% in same block (elapsed = 0 → _accrueFunding no-op)
        vm.prank(keeper);
        market.setMark(MARK_5PCT);

        // Dave mints at 5% (costBasis = 5%); fundingSnapshot[dave] = cumFunding = 0
        vm.prank(dave);
        market.mint(MINT_AMT); // costBasis[dave] = 0.05e18

        assertEq(market.costBasis(alice), MARK_10PCT, "alice costBasis must be 10%");
        assertEq(market.costBasis(dave),  MARK_5PCT,  "dave costBasis must be 5%");
        assertEq(market.currentMark(),    MARK_5PCT,  "mark must be 5%");

        // Both have fundingSnapshot = 0; fNow evolves identically from here on
        assertEq(market.fundingSnapshot(alice), 0, "alice fundingSnapshot must be 0");
        assertEq(market.fundingSnapshot(dave),  0, "dave fundingSnapshot must be 0");

        // Alice is deeply underwater on MTM (paid 10¢, mark is 5¢) — verify negative P&L
        assertTrue(market.pnl(alice) < 0, "alice P&L must be negative (underwater on MTM)");

        // 353 days: neither should be seizable — negative MTM alone must not trigger
        vm.warp(block.timestamp + 353 days);
        market.accrueFunding();

        assertFalse(market.isSeizable(alice),
            "alice must NOT be seizable at 353 days despite negative MTM");
        assertFalse(market.isSeizable(dave),
            "dave must NOT be seizable at 353 days");

        // 354 days: both should trigger identically
        vm.warp(block.timestamp + 1 days); // 354 days total
        market.accrueFunding();

        assertTrue(market.isSeizable(alice),
            "alice must be seizable at 354 days (cost basis irrelevant)");
        assertTrue(market.isSeizable(dave),
            "dave must be seizable at 354 days");

        // isSeizable result must be identical — cost basis has zero effect
        assertEq(market.isSeizable(alice), market.isSeizable(dave),
            "isSeizable must be identical for both holders (same fNow, same m)");

        // Both positions can be flagged
        vm.prank(keeper); market.flagClaimable(alice);
        vm.prank(keeper); market.flagClaimable(dave);

        assertTrue(market.claimable(alice), "alice must be claimable");
        assertTrue(market.claimable(dave),  "dave must be claimable");

        // frozenFunding per unit is identical (same fundingSnapshot = 0, same cumFunding)
        assertEq(market.frozenFunding(alice), market.frozenFunding(dave),
            "frozenFunding per unit must be identical for both holders");

        // Complete-set invariant holds after flagging both
        assertEq(yes.totalSupply(), no.totalSupply(),
            "complete-set invariant must hold after flagging both");
    }
}
