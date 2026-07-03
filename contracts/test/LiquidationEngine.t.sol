// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {YESToken} from "../src/YESToken.sol";
import {NOToken} from "../src/NOToken.sol";
import {CreditMarket} from "../src/CreditMarket.sol";
import {InsuranceFund} from "../src/InsuranceFund.sol";
import {LiquidationEngine} from "../src/LiquidationEngine.sol";

// 18-decimal mock (same as in other test files).
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

contract LiquidationEngineTest is Test {
    // ── infrastructure ────────────────────────────────────────────────────────
    MockUSDC      mockUsdc;
    YESToken      yesToken;
    NOToken       noToken;
    CreditMarket  market;
    InsuranceFund insuranceFund;
    LiquidationEngine engine;

    address admin    = address(this);
    address oracle   = makeAddr("oracle");
    address keeper   = makeAddr("keeper");
    address alice    = makeAddr("alice");   // position holder (gets liquidated)
    address bob      = makeAddr("bob");     // liquidator

    // 5% mark — seizure fires at ~354 epochs (daily); 356 days is safely past it.
    uint256 constant MARK_5PCT = 0.05e18;
    uint256 constant MINT_AMT  = 1_000e18; // 1000 YES + 1000 NO

    // ── setup ─────────────────────────────────────────────────────────────────

    function setUp() public {
        mockUsdc      = new MockUSDC();
        yesToken      = new YESToken(admin);
        noToken       = new NOToken(admin);
        insuranceFund = new InsuranceFund(admin, address(mockUsdc));
        market        = _deployMarket(MARK_5PCT);
        engine        = new LiquidationEngine(address(market), address(insuranceFund));

        // Wire roles.
        yesToken.grantRole(yesToken.CLOB_ROLE(),       address(engine));
        market.grantRole(market.LIQUIDATOR_ROLE(),      address(engine));
        insuranceFund.grantRole(insuranceFund.LIQUIDATOR_ROLE(), address(engine));

        // Seed InsuranceFund with ample USDC for tail-case coverage.
        mockUsdc.mint(address(insuranceFund), 100_000e18);

        // Give alice USDC to mint tokens and approve market.
        mockUsdc.mint(alice, 10_000e18);
        vm.prank(alice);
        mockUsdc.approve(address(market), type(uint256).max);

        // Give bob USDC to pay as liquidator and approve engine.
        mockUsdc.mint(bob, 10_000e18);
        vm.prank(bob);
        mockUsdc.approve(address(engine), type(uint256).max);
    }

    // Deploy a market at `mark` and wire all roles.
    function _deployMarket(uint256 mark) internal returns (CreditMarket m) {
        m = new CreditMarket(
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
        m.grantRole(m.KEEPER_ROLE(), keeper);
        m.grantRole(m.ORACLE_ROLE(), oracle);
    }

    // Mint and advance time past the seizure threshold, then flag.
    // Returns (Q, fFrozenTotal, tokenValue, P) computed at flag time.
    function _mintAndFlag(address holder, uint256 mintAmt)
        internal
        returns (
            uint256 Q,
            uint256 fFrozenTotal,
            uint256 tokenValue,
            uint256 P
        )
    {
        vm.prank(holder);
        market.mint(mintAmt);

        // 356 days at 5% mark puts us safely past the ~354-day seizure threshold.
        vm.warp(block.timestamp + 356 days);
        market.accrueFunding();
        assertTrue(market.isSeizable(holder), "must be seizable before flag");

        vm.prank(keeper);
        market.flagClaimable(holder);

        Q             = yesToken.balanceOf(holder);
        uint256 fPerUnit = market.frozenFunding(holder);
        fFrozenTotal  = market.fundingDebt(holder) + fPerUnit * Q / 1e18;
        tokenValue    = Q * market.currentMark() / 1e18;
        P             = fFrozenTotal <= tokenValue ? fFrozenTotal : tokenValue;
    }

    // ── normal-case tests ──────────────────────────────────────────────────────

    // P == fFrozenTotal USDC enters CreditMarket (the NO accretion / collateral pool).
    function test_Claim_NormalCase_PaysNOAccretion() public {
        (uint256 Q, uint256 fFrozenTotal, uint256 tokenValue, uint256 P) =
            _mintAndFlag(alice, MINT_AMT);

        // Normal case: fFrozenTotal < tokenValue (seizure trigger fires before full exhaustion).
        assertLt(fFrozenTotal, tokenValue, "setup: must be normal case");

        uint256 marketUsdcBefore = mockUsdc.balanceOf(address(market));

        vm.prank(bob);
        engine.claim(alice);

        // P USDC entered CreditMarket — the NO accretion pool is replenished.
        assertEq(
            mockUsdc.balanceOf(address(market)),
            marketUsdcBefore + P,
            "P USDC credited to CreditMarket"
        );
        assertEq(P, fFrozenTotal, "P equals full frozen funding in normal case");

        // Alice's frozen state is cleared.
        assertEq(market.fundingDebt(alice),   0,     "fundingDebt cleared");
        assertFalse(market.claimable(alice),          "claimable cleared");
        assertEq(market.frozenFunding(alice), 0,     "frozenFunding cleared");

        // Silence unused-variable warning.
        Q;
    }

    // YES tokens transfer from original holder to liquidator; totalSupply unchanged.
    function test_Claim_NormalCase_YESTransfers() public {
        (uint256 Q,,,) = _mintAndFlag(alice, MINT_AMT);

        uint256 totalSupplyBefore = yesToken.totalSupply();
        uint256 bobYesBefore      = yesToken.balanceOf(bob);

        vm.prank(bob);
        engine.claim(alice);

        assertEq(yesToken.balanceOf(alice), 0,                      "alice YES to 0");
        assertEq(yesToken.balanceOf(bob),   bobYesBefore + Q,       "bob receives Q YES");
        assertEq(yesToken.totalSupply(),    totalSupplyBefore,       "YES totalSupply unchanged");
    }

    // Original holder receives no USDC residual — the sliver (tokenValue − P) goes
    // to the liquidator as profit embedded in the transferred YES token value.
    function test_Claim_NormalCase_NoResidualToOriginalHolder() public {
        _mintAndFlag(alice, MINT_AMT);

        uint256 aliceUsdcBefore = mockUsdc.balanceOf(alice);

        vm.prank(bob);
        engine.claim(alice);

        assertEq(mockUsdc.balanceOf(alice), aliceUsdcBefore, "alice USDC unchanged");
    }

    // ── tail-case tests ────────────────────────────────────────────────────────

    // Simulate keeper downtime: mark drops sharply after flagging so
    // fFrozenTotal > tokenValue. InsuranceFund must cover the shortfall,
    // and CreditMarket receives fFrozenTotal total USDC so NO is fully made whole.
    function test_Claim_TailCase_InsuranceFundTopsUp() public {
        (, uint256 fFrozenTotal,,) = _mintAndFlag(alice, MINT_AMT);

        // Drop mark after flagging to create the tail-case scenario.
        // newMark = 0.001e18 → tokenValue = 1000e18 * 0.001e18 / 1e18 = 1e18 (1 USDC).
        uint256 newMark = 0.001e18;
        vm.prank(keeper);
        market.setMark(newMark);

        uint256 Q          = yesToken.balanceOf(alice);
        uint256 tokenValue = Q * newMark / 1e18;
        assertGt(fFrozenTotal, tokenValue, "setup: must be tail case after mark drop");

        uint256 shortfall    = fFrozenTotal - tokenValue;
        uint256 ifUsdcBefore = mockUsdc.balanceOf(address(insuranceFund));
        uint256 mktUsdcBefore = mockUsdc.balanceOf(address(market));

        vm.prank(bob);
        engine.claim(alice);

        // InsuranceFund paid the shortfall.
        assertEq(
            mockUsdc.balanceOf(address(insuranceFund)),
            ifUsdcBefore - shortfall,
            "InsuranceFund reduced by shortfall"
        );

        // CreditMarket received tokenValue (from bob) + shortfall (from IF) = fFrozenTotal.
        assertEq(
            mockUsdc.balanceOf(address(market)),
            mktUsdcBefore + fFrozenTotal,
            "CreditMarket received full fFrozenTotal (NO made whole)"
        );
    }

    // ── snapshot / fresh-start tests ──────────────────────────────────────────

    // After claim, the liquidator's fundingSnapshot equals cumulativeFundingPerYES —
    // they owe no back-funding on the inherited YES tokens.
    function test_Claim_LiquidatorSnapshotResets() public {
        _mintAndFlag(alice, MINT_AMT);

        vm.prank(bob);
        engine.claim(alice);

        assertEq(
            market.fundingSnapshot(bob),
            market.cumulativeFundingPerYES(),
            "liquidator snapshot == current index (no back-funding)"
        );
        // Bob owes nothing for the inherited tokens at this moment.
        assertEq(market.yesFundingOwed(bob), 0, "liquidator owes no back-funding at claim");
    }

    // ── guard tests ────────────────────────────────────────────────────────────

    function test_Claim_DuringMotionPending_Reverts() public {
        _mintAndFlag(alice, MINT_AMT);

        vm.prank(oracle);
        market.setMotionPending(true);

        vm.prank(bob);
        vm.expectRevert(LiquidationEngine.MotionPending.selector);
        engine.claim(alice);
    }

    function test_Claim_NotClaimable_Reverts() public {
        // Alice has a healthy position — not flagged.
        vm.prank(alice);
        market.mint(MINT_AMT);

        vm.prank(bob);
        vm.expectRevert(LiquidationEngine.NotClaimable.selector);
        engine.claim(alice);
    }

    // ── invariant fuzz test ────────────────────────────────────────────────────

    // YES.totalSupply() == NO.totalSupply() must hold before and after every claim,
    // across multiple sequential claims with different holders and amounts.
    function test_Claim_CompleteSetInvariantHolds(
        uint256 aliceMint,
        uint256 charlieMint
    ) public {
        aliceMint   = bound(aliceMint,   1e18, 5_000e18);
        charlieMint = bound(charlieMint, 1e18, 5_000e18);

        address charlie = makeAddr("charlie");
        mockUsdc.mint(charlie, charlieMint);
        vm.prank(charlie);
        mockUsdc.approve(address(market), type(uint256).max);

        // Both mint at t=0.
        vm.prank(alice);
        market.mint(aliceMint);
        vm.prank(charlie);
        market.mint(charlieMint);

        // Invariant holds at entry.
        assertEq(yesToken.totalSupply(), noToken.totalSupply(), "invariant at entry");

        // Advance past seizure threshold (356 days @ 5% mark).
        vm.warp(block.timestamp + 356 days);
        market.accrueFunding();

        // Flag and claim alice.
        vm.prank(keeper);
        market.flagClaimable(alice);

        assertEq(yesToken.totalSupply(), noToken.totalSupply(), "invariant after alice flagged");

        // Bob (liquidator) needs enough USDC for both claims.
        mockUsdc.mint(bob, 20_000e18);

        vm.prank(bob);
        engine.claim(alice);
        assertEq(yesToken.totalSupply(), noToken.totalSupply(), "invariant after alice claimed");

        // Flag and claim charlie.
        vm.prank(keeper);
        market.flagClaimable(charlie);

        assertEq(yesToken.totalSupply(), noToken.totalSupply(), "invariant after charlie flagged");

        vm.prank(bob);
        engine.claim(charlie);
        assertEq(yesToken.totalSupply(), noToken.totalSupply(), "invariant after charlie claimed");

        // Total YES supply is still the full minted amount — no tokens were burned.
        assertEq(yesToken.totalSupply(), aliceMint + charlieMint, "total YES supply unchanged");
        assertEq(noToken.totalSupply(),  aliceMint + charlieMint, "total NO supply unchanged");
    }

    // ─── v1b1-2b-3: settleFunding + collateral, no pool ────────────────────────

    // Give the seized holder some NO on top of her frozen YES position (test
    // setup only — a plain-transfer redistribution, so total supply stays
    // balanced) so her own settleFunding call inside claim() has a real, nonzero
    // net credit to pay — proving that credit comes directly out of CreditMarket's
    // collateral balance, not any pool (there is no pool left in the codebase).
    function test_Liquidation_UsesCollateralNotPool() public {
        address charlie = makeAddr("charlie-no-holder");
        mockUsdc.mint(charlie, 10_000e18);
        vm.prank(charlie);
        mockUsdc.approve(address(market), type(uint256).max);

        vm.prank(alice);
        market.mint(MINT_AMT); // alice: 1000 YES + 1000 NO
        vm.prank(charlie);
        market.mint(500e18);   // charlie: 500 YES + 500 NO

        // Redistribute charlie's NO to alice so she holds more NO than YES.
        noToken.grantRole(noToken.CLOB_ROLE(), charlie);
        vm.prank(charlie);
        noToken.transfer(alice, 500e18); // alice: 1000 YES, 1500 NO; charlie: 500 YES, 0 NO

        vm.warp(block.timestamp + 356 days);
        market.accrueFunding();
        assertTrue(market.isSeizable(alice), "must be seizable before flag");

        vm.prank(keeper);
        market.flagClaimable(alice);

        uint256 cum              = market.cumulativeFundingPerYES(); // == cumFundingPerNO
        uint256 expectedYesOwed  = 1_000e18 * cum / 1e18;
        uint256 expectedNoCredit = 1_500e18 * cum / 1e18;
        uint256 expectedNetCredit = expectedNoCredit - expectedYesOwed;

        uint256 aliceUsdcBefore = mockUsdc.balanceOf(alice);

        vm.prank(bob);
        engine.claim(alice);

        // Alice's own NO-side credit nets against her frozen YES debit and is
        // paid directly out of CreditMarket's collateral balance during claim
        // (via settleFunding) — no pool anywhere.
        assertEq(mockUsdc.balanceOf(alice), aliceUsdcBefore + expectedNetCredit,
            "seized holder's net NO credit paid directly from collateral, not a pool");

        // Liquidation still proceeds normally: YES transfers, complete-set intact.
        assertEq(yesToken.balanceOf(bob), 1_000e18, "liquidator receives seized YES");
        assertEq(yesToken.totalSupply(), noToken.totalSupply(), "complete-set invariant holds");
    }
}
