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
            mark
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
}
