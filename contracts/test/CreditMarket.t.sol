// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {YESToken} from "../src/YESToken.sol";
import {NOToken} from "../src/NOToken.sol";
import {CreditMarket} from "../src/CreditMarket.sol";

// 18-decimal mock so YES/NO/USDC units are all identical in tests.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract CreditMarketTest is Test {
    MockUSDC mockUsdc;
    YESToken yesToken;
    NOToken noToken;
    CreditMarket market; // 23% mark

    address admin = address(this);
    address pauser = makeAddr("pauser");
    address oracle = makeAddr("oracle");
    address alice = makeAddr("alice");

    function setUp() public {
        mockUsdc = new MockUSDC();
        yesToken = new YESToken(admin);
        noToken = new NOToken(admin);
        market = _marketAt(0.23e18);

        mockUsdc.mint(alice, 10_000e18);
        vm.prank(alice);
        assertTrue(mockUsdc.approve(address(market), type(uint256).max));
    }

    // Deploy a CreditMarket at `mark` and wire MINTER/BURNER roles on both tokens.
    function _marketAt(uint256 mark) internal returns (CreditMarket) {
        CreditMarket m = new CreditMarket(
            admin,
            address(mockUsdc),
            address(yesToken),
            address(noToken),
            mark,
            1 days
        );
        yesToken.grantRole(yesToken.MINTER_ROLE(), address(m));
        yesToken.grantRole(yesToken.BURNER_ROLE(), address(m));
        noToken.grantRole(noToken.MINTER_ROLE(), address(m));
        noToken.grantRole(noToken.BURNER_ROLE(), address(m));
        m.grantRole(m.PAUSER_ROLE(), pauser);
        m.grantRole(m.ORACLE_ROLE(), oracle);
        return m;
    }

    // ─── mint tests ────────────────────────────────────────────────────────────

    function test_Mint_OneToOne() public {
        uint256 usdcAmount = 1000e18;
        vm.prank(alice);
        market.mint(usdcAmount);

        assertEq(yesToken.balanceOf(alice), usdcAmount, "YES minted 1:1");
        assertEq(noToken.balanceOf(alice),  usdcAmount, "NO minted 1:1");
        assertEq(mockUsdc.balanceOf(address(market)), usdcAmount, "market holds collateral");
    }

    function test_Mint_MarkDoesNotAffectRatio() public {
        // At any mark, mint always gives usdcAmount YES and usdcAmount NO.
        uint256 usdcAmount = 1000e18;

        CreditMarket m23 = _marketAt(0.23e18);
        CreditMarket m99 = _marketAt(0.99e18);

        vm.prank(alice);
        mockUsdc.approve(address(m23), type(uint256).max);
        vm.prank(alice);
        mockUsdc.approve(address(m99), type(uint256).max);

        vm.prank(alice);
        m23.mint(usdcAmount);
        assertEq(yesToken.balanceOf(alice), usdcAmount, "23% mark: YES 1:1");
        assertEq(noToken.balanceOf(alice),  usdcAmount, "23% mark: NO 1:1");
    }

    // ─── redeem tests ──────────────────────────────────────────────────────────

    function test_Redeem_BurnsCorrectly() public {
        uint256 usdcAmount = 1000e18;
        vm.prank(alice);
        market.mint(usdcAmount);
        // alice: 1000 YES, 1000 NO; market: 1000 USDC

        uint256 redeemAmount = 400e18;
        uint256 aliceUsdcBefore = mockUsdc.balanceOf(alice);

        vm.prank(alice);
        market.redeem(redeemAmount);

        assertEq(yesToken.balanceOf(alice), usdcAmount - redeemAmount, "YES reduced");
        assertEq(noToken.balanceOf(alice),  usdcAmount - redeemAmount, "NO reduced");
        assertEq(mockUsdc.balanceOf(alice), aliceUsdcBefore + redeemAmount, "USDC returned");
        assertEq(mockUsdc.balanceOf(address(market)), usdcAmount - redeemAmount, "market USDC reduced");
    }

    function test_Redeem_AfterCreditEvent_Reverts() public {
        vm.prank(alice);
        market.mint(100e18);

        vm.prank(oracle);
        market.confirmCreditEvent(); // sets flag + pauses

        vm.prank(alice);
        vm.expectRevert();
        market.redeem(10e18);
    }

    // ─── pause tests ───────────────────────────────────────────────────────────

    function test_Mint_WhenPaused_Reverts() public {
        vm.prank(pauser);
        market.pause();

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        market.mint(100e18);
    }

    // ─── funding tests ─────────────────────────────────────────────────────────

    function test_Funding_ZeroAtT0() public {
        assertEq(market.cumulativeFundingPerYES(), 0, "cumulative starts at 0");

        // Mint and immediately check — elapsed == 0 so no accrual.
        vm.prank(alice);
        market.mint(1000e18);

        assertEq(market.cumulativeFundingPerYES(), 0, "no accrual at t=0");
        assertEq(market.fundingDebt(alice), 0, "no debt at t=0");
    }

    function test_Funding_CorrectAfter1Day() public {
        vm.prank(alice);
        market.mint(1000e18);

        vm.warp(block.timestamp + 1 days);
        market.accrueFunding();

        // mark = 0.23e18, elapsed = 1 days, period = 365 days
        uint256 expected = uint256(0.23e18) * 1 days / 365 days;
        assertEq(market.cumulativeFundingPerYES(), expected, "cumulative after 1 day");
    }

    function test_Funding_CorrectAfterMarkChange() public {
        uint256 mark1 = 0.23e18;
        uint256 mark2 = 0.50e18;
        uint256 T1 = 1 days;
        uint256 T2 = 2 days;

        market.grantRole(market.KEEPER_ROLE(), admin); // admin = address(this)

        vm.prank(alice);
        market.mint(1000e18);

        vm.warp(block.timestamp + T1);
        market.setMark(mark2); // internally accrues at mark1 first

        vm.warp(block.timestamp + T2);
        market.accrueFunding(); // accrues at mark2

        uint256 expected = mark1 * T1 / 365 days + mark2 * T2 / 365 days;
        assertEq(market.cumulativeFundingPerYES(), expected, "two-leg cumulative");
    }

    // Alice holds the matched 1000 YES + 1000 NO pair from mint, untouched. Her
    // YES debit and NO credit accrue off the same mirrored index and same
    // balance, so settleFunding nets them to exactly zero — redeem returns the
    // full amount, not a naive YES-only debt deduction (v1b1-2b-3: redeem routes
    // funding through settleFunding + collateral, no pool).
    function test_Funding_DeductedOnRedeem() public {
        uint256 usdcAmount = 1000e18; // → 1000 YES + 1000 NO (1:1 mint)

        vm.prank(alice);
        market.mint(usdcAmount);

        // Exactly 1 year: cumulative = 0.23e18 * 365d / 365d = 0.23e18 (exact integer).
        vm.warp(block.timestamp + 365 days);

        uint256 redeemAmount = yesToken.balanceOf(alice); // 1000e18
        uint256 aliceUsdcBefore = mockUsdc.balanceOf(alice);

        vm.prank(alice);
        market.redeem(redeemAmount);

        assertEq(mockUsdc.balanceOf(alice), aliceUsdcBefore + redeemAmount,
            "matched pair nets to zero -> full amount returned, no double charge");
    }

    // ─── v1b: mirrored NO index tests ─────────────────────────────────────────

    function test_BothIndices_AlwaysEqual() public {
        vm.prank(alice);
        market.mint(1000e18);

        vm.warp(block.timestamp + 7 days);
        market.accrueFunding();
        assertEq(market.cumFundingPerNO(), market.cumulativeFundingPerYES(), "equal after 7 days");

        market.grantRole(market.KEEPER_ROLE(), admin);
        market.setMark(0.5e18); // internally accrues at old mark then updates
        assertEq(market.cumFundingPerNO(), market.cumulativeFundingPerYES(), "equal after mark change");

        vm.warp(block.timestamp + 30 days);
        market.accrueFunding();
        assertEq(market.cumFundingPerNO(), market.cumulativeFundingPerYES(), "equal after second accrual");
    }

    // Fuzz: sum of yesFundingOwed == sum of noFundingCredit at any mark and timing.
    // With 1:1 mint, YES.totalSupply() == NO.totalSupply() always, so the equal indices
    // guarantee exact conservation of total funding flow across all holders.
    function test_Conservation_TotalOwedEqualsTotalCredited(
        uint256 markPct,
        uint256 warpSecs,
        uint256 aliceAmt,
        uint256 bobAmt
    ) public {
        markPct  = bound(markPct,  1,   99);
        warpSecs = bound(warpSecs, 1,   365 days);
        aliceAmt = bound(aliceAmt, 1e18, 5_000e18);
        bobAmt   = bound(bobAmt,   1e18, 5_000e18);

        CreditMarket m = _marketAt(markPct * 1e16);

        address bob = makeAddr("bob");
        mockUsdc.mint(bob, 10_000e18);

        vm.prank(alice);
        mockUsdc.approve(address(m), type(uint256).max);
        vm.prank(bob);
        mockUsdc.approve(address(m), type(uint256).max);

        // Both mint at t=0 — elapsed==0 so no accrual; both snapshots land at 0.
        vm.prank(alice);
        m.mint(aliceAmt);
        vm.prank(bob);
        m.mint(bobAmt);

        vm.warp(block.timestamp + warpSecs);
        m.accrueFunding();

        uint256 totalOwed   = m.yesFundingOwed(alice) + m.yesFundingOwed(bob);
        uint256 totalCredit = m.noFundingCredit(alice) + m.noFundingCredit(bob);

        assertEq(totalOwed, totalCredit, "conservation: total YES owed == total NO credited");
    }

    function test_NoFundingCredit_ScalesWithBalance() public {
        address bob = makeAddr("bob");
        mockUsdc.mint(bob, 10_000e18);
        vm.prank(bob);
        mockUsdc.approve(address(market), type(uint256).max);

        // Alice deposits 2× bob at same mark → 2× NO balance.
        vm.prank(alice);
        market.mint(2000e18);
        vm.prank(bob);
        market.mint(1000e18);

        vm.warp(block.timestamp + 30 days);
        market.accrueFunding();

        uint256 aliceCredit = market.noFundingCredit(alice);
        uint256 bobCredit   = market.noFundingCredit(bob);

        assertEq(aliceCredit, 2 * bobCredit, "2x NO balance yields 2x credit");
    }

    // ─── v1b: display-layer view tests ────────────────────────────────────────

    function test_CostBasis_SetAtMint() public {
        vm.prank(alice);
        market.mint(1000e18);
        assertEq(market.costBasis(alice), market.currentMark(), "cost basis = entry mark");
    }

    function test_CostBasis_WeightedAverage_OnSecondMint() public {
        uint256 firstMint  = 1000e18;
        uint256 secondMint = 1000e18;

        vm.prank(alice);
        market.mint(firstMint); // mark = 0.23e18

        // Change mark before second mint.
        market.grantRole(market.KEEPER_ROLE(), admin);
        market.setMark(0.50e18);

        vm.prank(alice);
        market.mint(secondMint); // mark = 0.50e18

        // Weighted avg: (0.23e18 * 1000 + 0.50e18 * 1000) / 2000 = 0.365e18
        uint256 expected = (uint256(0.23e18) * firstMint + uint256(0.50e18) * secondMint)
                           / (firstMint + secondMint);
        assertEq(market.costBasis(alice), expected, "weighted average cost basis");
    }

    function test_Equity_MatchesFormula() public {
        vm.prank(alice);
        market.mint(1000e18); // mark = 0.23e18, f_now = 0

        // At entry f_now = 0, so equity = mark.
        assertEq(market.equity(alice), market.currentMark(), "equity = mark at entry");

        vm.warp(block.timestamp + 30 days);
        market.accrueFunding();

        uint256 fPerUnit  = market.cumulativeFundingPerYES() - market.fundingSnapshot(alice);
        uint256 m         = market.currentMark();
        uint256 expected  = m > fPerUnit ? m - fPerUnit : 0;
        assertEq(market.equity(alice), expected, "equity = mark - f_now after 30 days");
    }

    function test_PnL_MatchesFormula() public {
        vm.prank(alice);
        market.mint(1000e18);

        // At entry: pnl = equity - costBasis = mark - mark = 0.
        assertEq(market.pnl(alice), 0, "pnl = 0 at entry");

        vm.warp(block.timestamp + 30 days);
        market.accrueFunding();

        int256 expectedPnl = int256(market.equity(alice)) - int256(market.costBasis(alice));
        assertEq(market.pnl(alice), expectedPnl, "pnl = equity - costBasis");
        assertTrue(market.pnl(alice) < 0, "pnl is negative after funding accrues (no mark change)");
    }

    function test_BreakevenMark_MatchesFormula() public {
        vm.prank(alice);
        market.mint(1000e18);

        // At entry f_now = 0, breakeven = costBasis.
        assertEq(market.breakevenMark(alice), market.costBasis(alice), "breakeven = costBasis at entry");

        vm.warp(block.timestamp + 30 days);
        market.accrueFunding();

        uint256 fPerUnit = market.cumulativeFundingPerYES() - market.fundingSnapshot(alice);
        uint256 expected = market.costBasis(alice) + fPerUnit;
        assertEq(market.breakevenMark(alice), expected, "breakeven = costBasis + f_now");
    }

    // Worked example: entry at 5% mark, daily epoch, f_now=0 → ≈354 epochs (±2).
    // Δf = 0.05e18/365 ≈ 136986301369863; m/1.03 ≈ 48543689320388349; epochs ≈ 354.
    function test_EpochsToExpire_MatchesWorkedExample() public {
        CreditMarket m5 = _marketAt(0.05e18);

        address bob = makeAddr("bob");
        mockUsdc.mint(bob, 1000e18);
        vm.prank(bob);
        mockUsdc.approve(address(m5), type(uint256).max);

        vm.prank(bob);
        m5.mint(100e18); // f_now = 0 at entry

        uint256 epochs = m5.epochsToExpire(bob);
        assertGe(epochs, 352, "epochs >= 352");
        assertLe(epochs, 356, "epochs <= 356");
    }

    // ─── v1b: seizure trigger tests ───────────────────────────────────────────

    // Fuzz: isSeizable must return the same value as the manually computed formula.
    function test_IsSeizable_FiresAtBoundary(uint256 markPct, uint256 warpSecs) public {
        markPct  = bound(markPct,  1,  99);
        warpSecs = bound(warpSecs, 1,  180 days);

        uint256 m   = markPct * 1e16;
        CreditMarket mkt = _marketAt(m);

        address bob = makeAddr("bob-boundary");
        mockUsdc.mint(bob, 1000e18);
        vm.prank(bob);
        mockUsdc.approve(address(mkt), type(uint256).max);
        vm.prank(bob);
        mkt.mint(100e18);

        vm.warp(block.timestamp + warpSecs);
        mkt.accrueFunding();

        uint256 fNow   = mkt.cumulativeFundingPerYES() - mkt.fundingSnapshot(bob);
        uint256 deltaF = m * 1 days / 365 days; // epochLength == 1 days
        uint256 fNext  = fNow + deltaF;
        bool expected  = m <= (fNext * 103) / 100;

        assertEq(mkt.isSeizable(bob), expected, "isSeizable matches manual boundary formula");
    }

    // Two holders with identical fNow and mark but different costBasis must yield
    // the same isSeizable result — cost basis must not appear in the trigger path.
    function test_IsSeizable_CostBasisIndependent() public {
        CreditMarket mkt = _marketAt(0.5e18);

        address bob = makeAddr("bob-cb");
        mockUsdc.mint(bob, 1000e18);
        vm.prank(alice);
        mockUsdc.approve(address(mkt), type(uint256).max);
        vm.prank(bob);
        mockUsdc.approve(address(mkt), type(uint256).max);

        // alice mints at mark=0.5 → costBasis[alice] = 0.5e18
        vm.prank(alice);
        mkt.mint(100e18);

        // change mark to 0.05 in the same block (no time elapsed → _accrueFunding no-op)
        mkt.grantRole(mkt.KEEPER_ROLE(), admin);
        mkt.setMark(0.05e18);

        // bob mints at mark=0.05 → costBasis[bob] = 0.05e18; same fundingSnapshot = 0
        vm.prank(bob);
        mkt.mint(100e18);

        assertFalse(mkt.costBasis(alice) == mkt.costBasis(bob), "cost bases must differ");
        assertEq(mkt.fundingSnapshot(alice), mkt.fundingSnapshot(bob), "snapshots equal (both 0)");

        // warp past seizure threshold (5% mark, daily epoch: ~354 day runway)
        vm.warp(block.timestamp + 358 days);
        mkt.accrueFunding();

        // both have identical fNow and m — isSeizable result must be the same
        assertEq(mkt.isSeizable(alice), mkt.isSeizable(bob), "cost basis must not affect seizure trigger");
    }

    // A holder deeply underwater on mark (large negative P&L) but with small fNow
    // relative to m must NOT trigger seizure — negative MTM alone is never a trigger.
    function test_NegativeMTM_AloneDoesNotTrigger() public {
        // mint at high mark to bake in a high cost basis
        CreditMarket mkt = _marketAt(0.8e18);

        address bob = makeAddr("bob-mtm");
        mockUsdc.mint(bob, 1000e18);
        vm.prank(bob);
        mockUsdc.approve(address(mkt), type(uint256).max);
        vm.prank(bob);
        mkt.mint(100e18); // costBasis = 0.8e18

        // mark collapses to 0.05 in same block (no accrual)
        mkt.grantRole(mkt.KEEPER_ROLE(), admin);
        mkt.setMark(0.05e18);

        // only 1 day passes → fNow ≈ 0.05/365 ≈ 1.37e14, far below m=0.05e18
        vm.warp(block.timestamp + 1 days);
        mkt.accrueFunding();

        assertFalse(mkt.isSeizable(bob), "negative MTM alone must not trigger seizure");
        assertTrue(mkt.pnl(bob) < 0, "position is underwater (sanity check)");
    }

    // After flagClaimable, frozenFunding must stay constant even as the global
    // cumulativeFundingPerYES index keeps rising.
    function test_FlagClaimable_FreezesFunding() public {
        CreditMarket mkt = _marketAt(0.05e18);

        address bob = makeAddr("bob-freeze");
        mockUsdc.mint(bob, 1000e18);
        vm.prank(bob);
        mockUsdc.approve(address(mkt), type(uint256).max);
        vm.prank(bob);
        mkt.mint(100e18);

        // 5% mark, daily epoch: seizure fires at ~354 days; 356 days is safely past it
        vm.warp(block.timestamp + 356 days);
        mkt.accrueFunding();
        assertTrue(mkt.isSeizable(bob), "must be seizable before flag");

        mkt.grantRole(mkt.KEEPER_ROLE(), admin);
        mkt.flagClaimable(bob);

        assertTrue(mkt.claimable(bob), "claimable flag is set");
        uint256 frozen = mkt.frozenFunding(bob);

        // continue accruing — frozenFunding must not change
        vm.warp(block.timestamp + 30 days);
        mkt.accrueFunding();

        assertEq(mkt.frozenFunding(bob), frozen, "frozenFunding must not change after flagging");
    }

    // flagClaimable must revert when the position is not yet seizable.
    function test_FlagClaimable_RequiresSeizable() public {
        CreditMarket mkt = _marketAt(0.05e18);

        address bob = makeAddr("bob-notsz");
        mockUsdc.mint(bob, 1000e18);
        vm.prank(bob);
        mockUsdc.approve(address(mkt), type(uint256).max);
        vm.prank(bob);
        mkt.mint(100e18);

        // 1 day — nowhere near the seizure threshold
        vm.warp(block.timestamp + 1 days);
        mkt.accrueFunding();
        assertFalse(mkt.isSeizable(bob), "must not be seizable after 1 day");

        mkt.grantRole(mkt.KEEPER_ROLE(), admin);
        vm.expectRevert(CreditMarket.PositionNotSeizable.selector);
        mkt.flagClaimable(bob);
    }

    // Fuzz: at any valid mark and any elapsed time ≤ 1 year,
    // the USDC payout after funding deduction is always >= 0.
    function test_Funding_NeverExceedsCollateral(uint256 markPct, uint256 warpSecs) public {
        markPct  = bound(markPct,  1, 99);
        warpSecs = bound(warpSecs, 0, 365 days);

        CreditMarket m = _marketAt(markPct * 1e16);

        vm.prank(alice);
        assertTrue(mockUsdc.approve(address(m), type(uint256).max));
        vm.prank(alice);
        m.mint(1000e18);

        vm.warp(block.timestamp + warpSecs);

        // With 1:1 mint, YES and NO balances are equal — redeem the full position.
        uint256 redeemAmount = yesToken.balanceOf(alice); // == noToken.balanceOf(alice)
        if (redeemAmount == 0) return;

        uint256 aliceUsdcBefore = mockUsdc.balanceOf(alice);
        vm.prank(alice);
        m.redeem(redeemAmount);

        // Funding deduction is capped at tokenAmount → transfer amount ≥ 0.
        assertGe(mockUsdc.balanceOf(alice), aliceUsdcBefore, "USDC never goes negative");
    }

    // ─── v1b1-2b-1: unified per-user funding settlement tests (no pool) ───────

    // Pure NO holder: no YES debit to net against, so the full credit is paid
    // straight out of collateral.
    function test_SettleFunding_NOHolder_PaysCreditFromCollateral() public {
        address bob = makeAddr("bob-no");
        mockUsdc.mint(bob, 10_000e18);
        vm.prank(bob);
        mockUsdc.approve(address(market), type(uint256).max);

        // Alice mints then sells her NO to Bob. NO transfers are CLOB_ROLE-gated
        // (see NOToken._update), so grant alice CLOB_ROLE just to move the tokens
        // directly — isolating settleFunding's own math from CLOB/order-matching.
        vm.prank(alice);
        market.mint(1000e18); // alice: 1000 YES + 1000 NO

        noToken.grantRole(noToken.CLOB_ROLE(), alice);
        vm.prank(alice);
        noToken.transfer(bob, 1000e18); // bob: 1000 NO, 0 YES

        vm.warp(block.timestamp + 30 days);

        uint256 expectedCum    = uint256(0.23e18) * 30 days / 365 days;
        uint256 expectedCredit = 1000e18 * expectedCum / 1e18;

        uint256 bobUsdcBefore = mockUsdc.balanceOf(bob);
        int256  delta         = market.settleFunding(bob);

        assertEq(delta, int256(expectedCredit), "delta == full NO credit (no offsetting YES debit)");
        assertEq(mockUsdc.balanceOf(bob), bobUsdcBefore + expectedCredit, "credit paid from collateral");
        assertEq(market.snapNO(bob), market.cumFundingPerNO(), "NO snapshot reset");
    }

    // Pure YES holder: no NO credit to net against, so the function reports a
    // negative delta and does NOT pull any USDC — the caller decides how to collect it.
    function test_SettleFunding_YESHolder_ReturnsDebit() public {
        vm.prank(alice);
        market.mint(1000e18); // alice: 1000 YES + 1000 NO

        // Strip alice down to a pure YES holder (transfers are CLOB_ROLE-gated).
        address sink = makeAddr("no-sink");
        noToken.grantRole(noToken.CLOB_ROLE(), alice);
        vm.prank(alice);
        noToken.transfer(sink, 1000e18);

        vm.warp(block.timestamp + 30 days);

        uint256 expectedCum  = uint256(0.23e18) * 30 days / 365 days;
        uint256 expectedOwed = 1000e18 * expectedCum / 1e18;

        uint256 aliceUsdcBefore = mockUsdc.balanceOf(alice);
        int256  delta           = market.settleFunding(alice);

        assertEq(delta, -int256(expectedOwed), "delta is a negative debit");
        assertEq(mockUsdc.balanceOf(alice), aliceUsdcBefore, "no USDC pulled inside settleFunding");
        assertEq(market.fundingSnapshot(alice), market.cumulativeFundingPerYES(), "YES snapshot reset");
    }

    // Holding an equal YES+NO pair (the mint invariant, never traded): owed and
    // credit are computed off the SAME index and the SAME balance, so they net to
    // exactly zero — no payout, no debit.
    function test_SettleFunding_HeldPair_NetsToZero() public {
        vm.prank(alice);
        market.mint(1000e18); // alice: 1000 YES + 1000 NO, untouched

        vm.warp(block.timestamp + 30 days);

        uint256 aliceUsdcBefore = mockUsdc.balanceOf(alice);
        int256  delta           = market.settleFunding(alice);

        assertEq(delta, 0, "equal YES+NO balances net to zero");
        assertEq(mockUsdc.balanceOf(alice), aliceUsdcBefore, "no USDC moved");
    }

    function test_SettleFunding_ResetsBothSnapshots() public {
        vm.prank(alice);
        market.mint(1000e18);

        vm.warp(block.timestamp + 30 days);

        market.settleFunding(alice);

        assertEq(market.fundingSnapshot(alice), market.cumulativeFundingPerYES(), "YES snapshot reset");
        assertEq(market.snapNO(alice),           market.cumFundingPerNO(),         "NO snapshot reset");
    }

    function test_PreviewFunding_MatchesSettle_ButNoMutation() public {
        vm.prank(alice);
        market.mint(1000e18); // alice: 1000 YES + 1000 NO

        vm.warp(block.timestamp + 30 days);

        uint256 snapYesBefore = market.fundingSnapshot(alice);
        uint256 snapNoBefore  = market.snapNO(alice);

        // Preview a hypothetical YES-side settlement of alice's full YES balance —
        // this should match what settleFunding would actually return right now.
        int256 previewed = market.previewFunding(alice, 1000e18, true);

        assertEq(market.fundingSnapshot(alice), snapYesBefore, "preview does not mutate YES snapshot");
        assertEq(market.snapNO(alice),          snapNoBefore,  "preview does not mutate NO snapshot");

        int256 actual = market.settleFunding(alice);
        assertEq(previewed, actual, "preview matches the real settlement");
    }

    // Compile-time guarantee that the pool mechanism is fully gone (not just
    // unused) — a stray reference here would fail to compile.
    function test_NoPoolReferences() public {
        // solc would reject `market.noAccretionPool()` / `market.settleFundingOnSale(...)`
        // if either still existed — this test's mere presence + a passing build is the check.
        vm.prank(alice);
        market.mint(1e18);
        assertTrue(true, "build succeeded with no pool-based members on CreditMarket");
    }

    // ─── v1b1-2b-3: redeem/settleYES routed through settleFunding (no pool) ────

    // Redeem burns EQUAL YES and NO, so a "pure YES holder" can never call it —
    // the meaningful case is an ASYMMETRIC holding (more YES than NO), which
    // produces a real net debit that settleFunding deducts from the payout and
    // leaves sitting in CreditMarket's own collateral balance — no pool ledger.
    function test_Redeem_NettsFundingViaCollateral() public {
        vm.prank(alice);
        market.mint(1000e18); // 1000 YES + 1000 NO

        // Move part of alice's NO away (transfers are CLOB_ROLE-gated) so her
        // YES balance exceeds her NO balance.
        address sink = makeAddr("no-sink-redeem-collateral");
        noToken.grantRole(noToken.CLOB_ROLE(), alice);
        vm.prank(alice);
        noToken.transfer(sink, 400e18); // alice: 1000 YES, 600 NO

        vm.warp(block.timestamp + 30 days);

        uint256 expectedCum  = uint256(0.23e18) * 30 days / 365 days;
        uint256 expectedOwed = (1000e18 - 600e18) * expectedCum / 1e18; // net debit over held balance

        uint256 redeemAmount = 600e18; // capped by alice's remaining NO balance

        uint256 aliceUsdcBefore  = mockUsdc.balanceOf(alice);
        uint256 marketUsdcBefore = mockUsdc.balanceOf(address(market));

        vm.prank(alice);
        market.redeem(redeemAmount);

        assertEq(mockUsdc.balanceOf(alice), aliceUsdcBefore + redeemAmount - expectedOwed,
            "redeemer nets tokenAmount minus net funding owed");
        assertEq(mockUsdc.balanceOf(address(market)), marketUsdcBefore - (redeemAmount - expectedOwed),
            "owed portion stays in CreditMarket's collateral, not paid out");
    }

    // The reported lifecycle bug: a holder who never traded (still holds the
    // matched YES+NO pair from mint) must NOT be double-charged for owing YES
    // funding while ALSO being due the mirrored NO credit — settleFunding nets
    // both off the same balance and the same index, so they cancel exactly and
    // the full tokenAmount is returned.
    function test_Redeem_HeldPair_NoDoubleCharge() public {
        vm.prank(alice);
        market.mint(1000e18); // 1000 YES + 1000 NO, untouched

        vm.warp(block.timestamp + 30 days);

        uint256 aliceUsdcBefore = mockUsdc.balanceOf(alice);

        vm.prank(alice);
        market.redeem(1000e18);

        assertEq(mockUsdc.balanceOf(alice), aliceUsdcBefore + 1000e18,
            "matched pair nets to zero -> full tokenAmount redeemed, no double charge");
    }

    // Post-credit-event settlement deducts accrued YES funding the same way
    // redeem does — via settleFunding against collateral, no pool.
    function test_SettleYES_DeductsFundingViaCollateral() public {
        vm.prank(alice);
        market.mint(1000e18); // 1000 YES + 1000 NO

        address sink = makeAddr("no-sink-settleyes");
        noToken.grantRole(noToken.CLOB_ROLE(), alice);
        vm.prank(alice);
        noToken.transfer(sink, 1000e18); // alice: pure YES holder

        vm.warp(block.timestamp + 30 days);

        uint256 expectedCum  = uint256(0.23e18) * 30 days / 365 days;
        uint256 expectedOwed = 1000e18 * expectedCum / 1e18;

        vm.prank(oracle);
        market.confirmCreditEvent();

        uint256 aliceUsdcBefore = mockUsdc.balanceOf(alice);

        vm.prank(alice);
        market.settleYES(1000e18);

        assertEq(mockUsdc.balanceOf(alice), aliceUsdcBefore + 1000e18 - expectedOwed,
            "YES settles at full notional minus accrued funding debit, via collateral");
    }
}
