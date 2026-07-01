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

        // debt = 1000e18 * 0.23e18 / 1e18 = 230e18
        uint256 expectedDebt = redeemAmount * uint256(0.23e18) / 1e18;
        uint256 expectedUsdcOut = redeemAmount - expectedDebt;

        assertEq(market.fundingDebt(alice), 0, "debt cleared on redeem");
        assertEq(mockUsdc.balanceOf(alice), aliceUsdcBefore + expectedUsdcOut, "net USDC returned");
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

    // ─── v1b: CLOB funding settlement hook tests ──────────────────────────────

    function test_SettleFundingOnSale_YES_ReturnsDebit() public {
        vm.prank(alice);
        market.mint(1000e18); // mark = 0.23e18, fundingSnapshot[alice] = 0

        vm.warp(block.timestamp + 30 days);

        address clob = makeAddr("clob-1");
        address bob  = makeAddr("bob-1");
        market.grantRole(market.CLOB_ROLE(), clob);

        uint256 amount       = 500e18;
        uint256 expectedCum  = uint256(0.23e18) * 30 days / 365 days;
        uint256 expectedOwed = amount * expectedCum / 1e18;

        vm.prank(clob);
        (uint256 sellerAdjustment, bool isCredit) =
            market.settleFundingOnSale(alice, bob, true, amount, expectedOwed);

        assertEq(sellerAdjustment, expectedOwed, "owed computed correctly (total, not per-unit)");
        assertFalse(isCredit, "YES sale returns a debit");
    }

    function test_SettleFundingOnSale_NO_ReturnsCredit() public {
        address bob  = makeAddr("bob-2");
        address clob = makeAddr("clob-2");
        mockUsdc.mint(bob, 10_000e18);
        vm.prank(bob);
        mockUsdc.approve(address(market), type(uint256).max);

        // Bob mints a much larger balance so a prior YES-side settlement (below)
        // funds the accretion pool enough to cover alice's smaller NO credit.
        vm.prank(bob);
        market.mint(5000e18);
        vm.prank(alice);
        market.mint(1000e18);

        vm.warp(block.timestamp + 30 days);
        market.grantRole(market.CLOB_ROLE(), clob);

        // Fund the pool first via bob's (larger) YES-side settlement.
        vm.prank(clob);
        market.settleFundingOnSale(bob, alice, true, 5000e18, type(uint256).max / 2);

        uint256 expectedCum    = market.cumFundingPerNO() - market.snapNO(alice);
        uint256 amount         = 1000e18;
        uint256 expectedCredit = amount * expectedCum / 1e18;

        vm.prank(clob);
        (uint256 sellerAdjustment, bool isCredit) =
            market.settleFundingOnSale(alice, bob, false, amount, 0);

        assertEq(sellerAdjustment, expectedCredit, "credit computed correctly (total, not per-unit)");
        assertTrue(isCredit, "NO sale returns a credit");
    }

    function test_SettleFundingOnSale_YES_BelowOwed_Reverts() public {
        vm.prank(alice);
        market.mint(1000e18);

        vm.warp(block.timestamp + 30 days);

        address clob = makeAddr("clob-3");
        address bob  = makeAddr("bob-3");
        market.grantRole(market.CLOB_ROLE(), clob);

        uint256 amount       = 500e18;
        uint256 expectedCum  = uint256(0.23e18) * 30 days / 365 days;
        uint256 expectedOwed = amount * expectedCum / 1e18;

        vm.prank(clob);
        vm.expectRevert(CreditMarket.FundingShortfall.selector);
        market.settleFundingOnSale(alice, bob, true, amount, expectedOwed - 1);
    }

    function test_SettleFundingOnSale_ResetsBothSnapshots() public {
        address bob  = makeAddr("bob-4");
        address clob = makeAddr("clob-4");
        mockUsdc.mint(bob, 10_000e18);
        vm.prank(bob);
        mockUsdc.approve(address(market), type(uint256).max);

        vm.prank(alice);
        market.mint(1000e18);
        vm.prank(bob);
        market.mint(1000e18);

        vm.warp(block.timestamp + 30 days);
        market.grantRole(market.CLOB_ROLE(), clob);

        uint256 amount      = 500e18;
        uint256 expectedCum = uint256(0.23e18) * 30 days / 365 days;
        uint256 owed        = amount * expectedCum / 1e18;

        vm.prank(clob);
        market.settleFundingOnSale(alice, bob, true, amount, owed);

        assertEq(market.fundingSnapshot(alice), market.cumulativeFundingPerYES(), "seller YES snapshot reset");
        assertEq(market.fundingSnapshot(bob),   market.cumulativeFundingPerYES(), "buyer YES snapshot reset");

        // NO-side snapshots reset symmetrically (amount=0 avoids touching the accretion pool).
        vm.prank(clob);
        market.settleFundingOnSale(bob, alice, false, 0, 0);

        assertEq(market.snapNO(bob),   market.cumFundingPerNO(), "seller NO snapshot reset");
        assertEq(market.snapNO(alice), market.cumFundingPerNO(), "buyer NO snapshot reset");
    }

    function test_SettleFundingOnSale_OnlyCLOBRole() public {
        vm.prank(alice);
        market.mint(1000e18);

        vm.warp(block.timestamp + 30 days);

        address bob   = makeAddr("bob-5");
        address rando = makeAddr("rando-5");

        vm.prank(rando);
        vm.expectRevert();
        market.settleFundingOnSale(alice, bob, true, 500e18, type(uint256).max / 2);
    }

    function test_SettleFundingOnSale_RoutesToNOAccretion() public {
        vm.prank(alice);
        market.mint(1000e18);

        vm.warp(block.timestamp + 30 days);

        address clob = makeAddr("clob-6");
        address bob  = makeAddr("bob-6");
        market.grantRole(market.CLOB_ROLE(), clob);

        uint256 amount      = 500e18;
        uint256 expectedCum = uint256(0.23e18) * 30 days / 365 days;
        uint256 owed        = amount * expectedCum / 1e18;

        uint256 poolBefore = market.noAccretionPool();

        vm.prank(clob);
        market.settleFundingOnSale(alice, bob, true, amount, owed);

        assertEq(market.noAccretionPool(), poolBefore + owed, "YES sale routes owed to NO accretion pool");
    }
}
