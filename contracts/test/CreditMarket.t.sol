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

    function test_Mint_At23Percent() public {
        uint256 usdcAmount = 1000e18;
        vm.prank(alice);
        market.mint(usdcAmount);

        uint256 yesBalance = yesToken.balanceOf(alice);
        uint256 noBalance = noToken.balanceOf(alice);

        assertEq(yesBalance, 230e18, "yes amount");
        assertEq(noBalance, 770e18, "no amount");
        assertEq(yesBalance + noBalance, usdcAmount, "yes+no must equal usdcIn");
        assertEq(mockUsdc.balanceOf(address(market)), usdcAmount, "market holds collateral");
    }

    function test_Mint_At50Percent() public {
        CreditMarket m50 = _marketAt(0.5e18);
        vm.prank(alice);
        assertTrue(mockUsdc.approve(address(m50), type(uint256).max));

        uint256 usdcAmount = 1000e18;
        vm.prank(alice);
        m50.mint(usdcAmount);

        uint256 yesBalance = yesToken.balanceOf(alice);
        uint256 noBalance = noToken.balanceOf(alice);

        assertEq(yesBalance, 500e18, "yes at 50%");
        assertEq(noBalance, 500e18, "no at 50%");
        assertEq(yesBalance + noBalance, usdcAmount, "yes+no must equal usdcIn");
    }

    function test_Mint_At1Percent() public {
        // usdcAmount = 100e18 + 1 exposes integer truncation.
        // Division-only noAmount = 99e18 (loses 1 wei); subtraction gives 99e18+1. ✓
        CreditMarket m1 = _marketAt(0.01e18);
        vm.prank(alice);
        assertTrue(mockUsdc.approve(address(m1), type(uint256).max));

        uint256 usdcAmount = 100e18 + 1;
        vm.prank(alice);
        m1.mint(usdcAmount);

        uint256 yesBalance = yesToken.balanceOf(alice);
        uint256 noBalance = noToken.balanceOf(alice);

        assertEq(yesBalance, 1e18, "yes: 1% of 100+1 truncates to 1");
        assertEq(noBalance, 99e18 + 1, "no: absorbs the truncated dust");
        assertEq(yesBalance + noBalance, usdcAmount, "dust check: no USDC lost");
    }

    // ─── redeem tests ──────────────────────────────────────────────────────────

    function test_Redeem_BurnsCorrectly() public {
        uint256 usdcAmount = 1000e18;
        vm.prank(alice);
        market.mint(usdcAmount);
        // alice: 230 YES, 770 NO; market: 1000 USDC

        uint256 redeemAmount = 230e18; // redeem full YES position
        uint256 aliceUsdcBefore = mockUsdc.balanceOf(alice);

        vm.prank(alice);
        market.redeem(redeemAmount);

        assertEq(yesToken.balanceOf(alice), 0, "YES fully burned");
        assertEq(noToken.balanceOf(alice), 770e18 - redeemAmount, "partial NO burned");
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
        uint256 usdcAmount = 1000e18; // → 230 YES + 770 NO at 23%

        vm.prank(alice);
        market.mint(usdcAmount);

        // Exactly 1 year: cumulative = 0.23e18 * 365d / 365d = 0.23e18 (exact integer).
        vm.warp(block.timestamp + 365 days);

        uint256 redeemAmount = yesToken.balanceOf(alice); // 230e18
        uint256 aliceUsdcBefore = mockUsdc.balanceOf(alice);

        vm.prank(alice);
        market.redeem(redeemAmount);

        // debt = 230e18 * 0.23e18 / 1e18 = 52.9e18
        uint256 expectedDebt = redeemAmount * uint256(0.23e18) / 1e18;
        uint256 expectedUsdcOut = redeemAmount - expectedDebt;

        assertEq(market.fundingDebt(alice), 0, "debt cleared on redeem");
        assertEq(mockUsdc.balanceOf(alice), aliceUsdcBefore + expectedUsdcOut, "net USDC returned");
    }

    // Fuzz: at any valid mark and any elapsed time ≤ 1 year,
    // the USDC payout after funding deduction is always >= 0.
    function test_Funding_NeverExceedsCollateral(uint256 markPct, uint256 warpSecs) public {
        markPct = bound(markPct, 1, 99);         // 1 % – 99 %
        warpSecs = bound(warpSecs, 0, 365 days);

        uint256 mark = markPct * 1e16; // 1e16 … 99e16 in 1e18 scale
        CreditMarket m = _marketAt(mark);

        vm.prank(alice);
        assertTrue(mockUsdc.approve(address(m), type(uint256).max));
        vm.prank(alice);
        m.mint(1000e18);

        vm.warp(block.timestamp + warpSecs);

        // Redeem the smaller of the two positions so we hold enough of both tokens.
        uint256 yesBalance = yesToken.balanceOf(alice);
        uint256 noBalance = noToken.balanceOf(alice);
        uint256 redeemAmount = yesBalance < noBalance ? yesBalance : noBalance;

        if (redeemAmount == 0) return;

        uint256 aliceUsdcBefore = mockUsdc.balanceOf(alice);
        vm.prank(alice);
        m.redeem(redeemAmount);

        // Funding deduction is capped at tokenAmount → transfer amount ≥ 0.
        assertGe(mockUsdc.balanceOf(alice), aliceUsdcBefore, "USDC never goes negative");
    }
}
