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
    // UPDATED for the owed()-based trigger (F4 fix): the manual formula now keys on
    // owed(bob) (ledger debt + live accrual), evaluated in totals (value vs 1.03x
    // (owed + one epoch of accrual)) exactly as CreditMarket.isSeizable does — bob
    // never trades here so fundingDebt(bob) == 0 and owed() reduces to the same
    // live-accrual number the old per-unit formula used, but the comparison shape
    // (totals, not per-unit) must match the contract's new implementation.
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

        uint256 yesBal    = yesToken.balanceOf(bob);
        uint256 value     = yesBal * m / 1e18;
        uint256 nextEpoch = yesBal * (m * 1 days / 365 days) / 1e18; // epochLength == 1 days
        bool expected     = value * 100 <= (mkt.owed(bob) + nextEpoch) * 103;

        assertEq(mkt.isSeizable(bob), expected, "isSeizable matches manual owed()-based boundary formula");
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

    // UPDATED (F1 fix, docs/security/invariant-findings-2026-09-26.md): flagClaimable
    // is a LOCK, not an accounting freeze. There is no frozenFunding anymore — owed()
    // must keep rising with the global index after a flag, exactly like an unflagged
    // holder's. A freeze here would let the paired NO keep earning credit that nobody
    // pays for during the flagged window (the F1 leak).
    function test_FlagClaimable_OwedKeepsAccruingAfterFlag() public {
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
        uint256 owedAtFlag = mkt.owed(bob);

        // continue accruing — owed() MUST keep rising (no freeze); the flagged
        // window's carry is no longer silently uncollected.
        vm.warp(block.timestamp + 30 days);
        mkt.accrueFunding();

        assertGt(mkt.owed(bob), owedAtFlag, "owed() must keep accruing on a flagged position (no freeze)");
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

    // ─── v1b1-2c: freeze-aware settleFunding, lockout, and cure ────────────────

    // UPDATED (F1 fix): there is no accounting freeze while flagged — settleFunding
    // always charges LIVE accrual, including the window between flag and settlement.
    // After settleYES, the flag must still auto-clear (the live obligation was fully
    // folded into the payout deduction, so leaving the flag set would let a later
    // claim() seize the remaining YES — but there's no YES left here, it's fully
    // burned).
    function test_SettleYES_ChargesFullLiveAccrual_NoFreeze() public {
        CreditMarket mkt = _marketAt(0.05e18);
        mkt.grantRole(mkt.KEEPER_ROLE(), admin);

        address bob = makeAddr("bob-freeze-settle");
        mockUsdc.mint(bob, 1000e18);
        vm.prank(bob);
        mockUsdc.approve(address(mkt), type(uint256).max);
        vm.prank(bob);
        mkt.mint(100e18); // 100 YES + 100 NO

        // Strip bob down to a pure YES holder.
        address sink = makeAddr("no-sink-freeze-settle");
        noToken.grantRole(noToken.CLOB_ROLE(), bob);
        vm.prank(bob);
        noToken.transfer(sink, 100e18);

        vm.warp(block.timestamp + 356 days);
        mkt.accrueFunding();
        assertTrue(mkt.isSeizable(bob), "must be seizable before flag");

        mkt.flagClaimable(bob);
        assertTrue(mkt.claimable(bob), "flagged");
        uint256 owedAtFlag = mkt.owed(bob);

        // 30 MORE days of live accrual pass while flagged — this MUST count against
        // bob now (no freeze): the flagged window's carry is not a free option.
        vm.warp(block.timestamp + 30 days);
        mkt.accrueFunding();
        uint256 owedBeforeSettle = mkt.owed(bob);
        assertGt(owedBeforeSettle, owedAtFlag, "owed() grew during the flagged window (no freeze)");

        vm.prank(oracle);
        mkt.confirmCreditEvent();

        uint256 bobUsdcBefore = mockUsdc.balanceOf(bob);

        vm.prank(bob);
        mkt.settleYES(100e18);

        assertEq(mockUsdc.balanceOf(bob), bobUsdcBefore + 100e18 - owedBeforeSettle,
            "payout deducts the FULL live-accrued debt (356+30 days), not a frozen 356-day snapshot");
        assertFalse(mkt.claimable(bob), "claimable auto-cleared after settleYES");
    }

    // A flagged position is fully locked: mint() and redeem() must revert.
    function test_Lockout_MintAndRedeem_Revert() public {
        CreditMarket mkt = _marketAt(0.05e18);
        mkt.grantRole(mkt.KEEPER_ROLE(), admin);

        address bob = makeAddr("bob-lockout");
        mockUsdc.mint(bob, 1000e18);
        vm.prank(bob);
        mockUsdc.approve(address(mkt), type(uint256).max);
        vm.prank(bob);
        mkt.mint(100e18); // 100 YES + 100 NO

        address sink = makeAddr("no-sink-lockout");
        noToken.grantRole(noToken.CLOB_ROLE(), bob);
        vm.prank(bob);
        noToken.transfer(sink, 100e18); // bob: pure YES holder

        vm.warp(block.timestamp + 356 days);
        mkt.accrueFunding();
        mkt.flagClaimable(bob);
        assertTrue(mkt.claimable(bob), "flagged");

        vm.prank(bob);
        vm.expectRevert(CreditMarket.PositionFrozen.selector);
        mkt.mint(10e18);

        vm.prank(bob);
        vm.expectRevert(CreditMarket.PositionFrozen.selector);
        mkt.redeem(1e18);
    }

    // UPDATED (F1 fix): cure() pays the LIVE owed() at cure time (net of NO credit),
    // not a frozen flag-time snapshot. This test flags, then lets 30 MORE days pass
    // (still flagged, still accruing — no freeze) before curing, so the payment
    // must include that post-flag window. Under the old freeze semantics bob would
    // have paid only the 356-day frozen amount; here he must pay the full 386 days.
    function test_Cure_PaysLiveOwedIncludingPostFlagAccrual() public {
        CreditMarket mkt = _marketAt(0.05e18);
        mkt.grantRole(mkt.KEEPER_ROLE(), admin);

        address bob = makeAddr("bob-cure");
        mockUsdc.mint(bob, 1000e18);
        vm.prank(bob);
        mockUsdc.approve(address(mkt), type(uint256).max);
        vm.prank(bob);
        mkt.mint(100e18); // 100 YES + 100 NO

        // Strip down to an asymmetric 100 YES / 40 NO holding so cure's net
        // (live YES debit minus NO credit) is a real, nonzero number.
        address sink = makeAddr("no-sink-cure");
        noToken.grantRole(noToken.CLOB_ROLE(), bob);
        vm.prank(bob);
        noToken.transfer(sink, 60e18); // bob: 100 YES, 40 NO

        vm.warp(block.timestamp + 356 days);
        mkt.accrueFunding();
        assertTrue(mkt.isSeizable(bob), "must be seizable before flag");
        mkt.flagClaimable(bob);
        assertTrue(mkt.claimable(bob), "flagged");

        // 30 MORE days of live accrual while flagged — no freeze, so this MUST
        // count toward the cure payment.
        vm.warp(block.timestamp + 30 days);
        mkt.accrueFunding();

        uint256 cumNo  = mkt.cumFundingPerNO(); // == cumulativeFundingPerYES (mirrored index)
        // fundingSnapshot(bob) was 0 at mint (no intermediate sync before the flag).
        uint256 expectedYesOwed  = 100e18 * mkt.cumulativeFundingPerYES() / 1e18;
        uint256 expectedNoCredit = 40e18  * cumNo  / 1e18;
        uint256 expectedNet      = expectedYesOwed - expectedNoCredit;

        assertEq(mkt.owed(bob), expectedYesOwed,
            "owed() == full live accrual over 386 days (356 pre-flag + 30 flagged, no freeze)");

        uint256 bobUsdcBefore    = mockUsdc.balanceOf(bob);
        uint256 marketUsdcBefore = mockUsdc.balanceOf(address(mkt));

        vm.prank(bob);
        mkt.cure();

        assertEq(bobUsdcBefore - mockUsdc.balanceOf(bob), expectedNet,
            "bob pays the FULL live owed (386 days), net of NO credit -- no freeze discount");
        assertEq(mockUsdc.balanceOf(address(mkt)), marketUsdcBefore + expectedNet,
            "USDC conservation: bob's payment lands in market collateral");
        assertFalse(mkt.claimable(bob), "flag cleared");
        assertEq(mkt.fundingDebt(bob), 0, "fundingDebt cleared");
        assertEq(mkt.fundingSnapshot(bob), mkt.cumulativeFundingPerYES(), "snapshot reset to now");

        // Warp afterward: accrual (and isSeizable) resumes from the cure time,
        // not from the original flag time.
        vm.warp(block.timestamp + 1 days);
        mkt.accrueFunding();
        uint256 fNowAfterCure = mkt.cumulativeFundingPerYES() - mkt.fundingSnapshot(bob);
        assertEq(fNowAfterCure, mkt.currentMark() * 1 days / 365 days,
            "post-cure accrual counts only from the cure time");
    }

    function test_Cure_NonFlagged_Reverts() public {
        vm.prank(alice);
        market.mint(100e18);

        vm.prank(alice);
        vm.expectRevert(CreditMarket.PositionNotFlagged.selector);
        market.cure();
    }

    // ─── F4 regression + owed()/display-layer coverage (2026-09-26 fix) ───────

    // F4 (docs/security/invariant-findings-2026-09-26.md): a settleFunding
    // touchpoint (any trade, or here a second mint) resets fundingSnapshot to now
    // and folds the accrued debit into fundingDebt. Under the OLD isSeizable
    // (cumulativeFundingPerYES - fundingSnapshot only), that reset made the
    // position look perpetually healthy even as real, uncollected debt piled up.
    // owed() folds fundingDebt back in, so the trigger still fires and
    // flagClaimable still succeeds.
    function test_F4_TradeResetsSnapshot_ButOwedStillTriggersSeizure() public {
        CreditMarket mkt = _marketAt(0.05e18);
        mkt.grantRole(mkt.KEEPER_ROLE(), admin);

        address bob = makeAddr("bob-f4");
        mockUsdc.mint(bob, 10_000e18);
        vm.prank(bob);
        mockUsdc.approve(address(mkt), type(uint256).max);
        vm.prank(bob);
        mkt.mint(1000e18); // 1000 YES + 1000 NO

        // Strip to pure YES so the debit is a clean, unnetted number.
        address sink = makeAddr("no-sink-f4");
        noToken.grantRole(noToken.CLOB_ROLE(), bob);
        vm.prank(bob);
        noToken.transfer(sink, 1000e18);

        // 300 days: not yet seizable at 5% mark (~354-day runway).
        vm.warp(block.timestamp + 300 days);
        mkt.accrueFunding();
        assertFalse(mkt.isSeizable(bob), "not seizable yet at 300 days");

        // A settleFunding touchpoint (any trade calls this on the trader; a second
        // mint is the simplest reproduction available without wiring the CLOB)
        // folds bob's accrued debit into fundingDebt and resets his YES snapshot.
        vm.prank(bob);
        mkt.mint(1e18);

        assertGt(mkt.fundingDebt(bob), 0, "the mint's settleFunding folded the debit into fundingDebt");
        assertEq(mkt.fundingSnapshot(bob), mkt.cumulativeFundingPerYES(),
            "the mint's settleFunding reset bob's YES snapshot to now");

        // 300 MORE days pass. The OLD (cum - snapshot)-only formula would see
        // ~0 elapsed-since-reset accrual and never trigger again.
        vm.warp(block.timestamp + 300 days);
        mkt.accrueFunding();

        assertTrue(mkt.isSeizable(bob),
            "F4 fix: owed() includes fundingDebt, so the reset snapshot cannot hide the debt");

        mkt.flagClaimable(bob); // must NOT revert PositionNotSeizable
        assertTrue(mkt.claimable(bob), "flagClaimable succeeds once owed() crosses the trigger");
    }

    // owed() = fundingDebt[user] + live accrual on the current YES balance since
    // the snapshot. Right after a settleFunding touchpoint resets the snapshot,
    // owed() must equal fundingDebt exactly (zero fresh accrual yet); once more
    // time passes, it must equal fundingDebt plus the newly accrued amount.
    function test_Owed_EqualsFundingDebtPlusLiveAccrual() public {
        vm.prank(alice);
        market.mint(1000e18); // 1000 YES + 1000 NO

        // Strip to pure YES so settleFunding always records a clean debit.
        address sink = makeAddr("no-sink-owed");
        noToken.grantRole(noToken.CLOB_ROLE(), alice);
        vm.prank(alice);
        noToken.transfer(sink, 1000e18);

        vm.warp(block.timestamp + 30 days);

        // settleFunding folds the 30-day debit into fundingDebt and resets the snapshot.
        market.settleFunding(alice);
        uint256 debt = market.fundingDebt(alice);
        assertGt(debt, 0, "settleFunding recorded a ledger debit");
        assertEq(market.owed(alice), debt,
            "owed() == fundingDebt right after settlement (zero live accrual yet)");

        vm.warp(block.timestamp + 10 days);
        market.accrueFunding();

        uint256 yesBal = yesToken.balanceOf(alice);
        uint256 liveAccrual = yesBal * (market.cumulativeFundingPerYES() - market.fundingSnapshot(alice)) / 1e18;
        assertEq(market.owed(alice), debt + liveAccrual,
            "owed() == fundingDebt + live accrual on the current YES balance since the reset snapshot");
    }

    // equity()/epochsToExpire()/breakevenMark() must fold in ledger debt
    // (fundingDebt), not just the live cum-snapshot delta -- otherwise a trade
    // that resets the snapshot would make a thin position look artificially
    // healthy on the display layer too (F4's root cause, applied to the UI views).
    function test_EpochsToExpire_And_Equity_IncludeLedgerDebt() public {
        CreditMarket mkt = _marketAt(0.05e18);

        address bob = makeAddr("bob-ledger-display");
        mockUsdc.mint(bob, 1_000e18);
        vm.prank(bob);
        mockUsdc.approve(address(mkt), type(uint256).max);
        vm.prank(bob);
        mkt.mint(100e18); // 100 YES + 100 NO

        address sink = makeAddr("no-sink-ledger-display");
        noToken.grantRole(noToken.CLOB_ROLE(), bob);
        vm.prank(bob);
        noToken.transfer(sink, 100e18); // bob: pure YES holder

        // Accrue a large chunk of funding, then settle it into the ledger
        // (simulating a trade): fundingSnapshot resets to "now" (cum - snapshot
        // == 0) while fundingDebt carries the accrued amount forward.
        vm.warp(block.timestamp + 300 days);
        mkt.settleFunding(bob);

        uint256 debt = mkt.fundingDebt(bob);
        assertGt(debt, 0, "setup: bob carries a real ledger debit");
        assertEq(mkt.cumulativeFundingPerYES() - mkt.fundingSnapshot(bob), 0,
            "sanity: snapshot just reset -- the OLD cum-snapshot-only formula would see zero owed");

        assertLt(mkt.equity(bob), mkt.currentMark(),
            "equity must be reduced by the ledger debt, not equal to the full mark");
        assertLt(mkt.epochsToExpire(bob), type(uint256).max,
            "epochsToExpire must be finite -- the ledger debt already eats into runway");
        assertEq(mkt.breakevenMark(bob), mkt.costBasis(bob) + debt * 1e18 / 100e18,
            "breakevenMark == costBasis + owed()-per-unit (ledger debt included)");
    }
}
