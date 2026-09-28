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

    // Mint and advance time past the seizure threshold, then flag. Returns the
    // flagged holder's YES balance (Q). UPDATED: there is no frozenFunding anymore
    // (F1 fix) — owed() keeps accruing live even after the flag, so callers must
    // read market.owed(holder) themselves at whatever point they actually claim
    // (which may be right after this helper, or after an additional warp).
    function _mintAndFlag(address holder, uint256 mintAmt) internal returns (uint256 Q) {
        vm.prank(holder);
        market.mint(mintAmt);

        // 356 days at 5% mark puts us safely past the ~354-day seizure threshold.
        vm.warp(block.timestamp + 356 days);
        market.accrueFunding();
        assertTrue(market.isSeizable(holder), "must be seizable before flag");

        vm.prank(keeper);
        market.flagClaimable(holder);

        Q = yesToken.balanceOf(holder);
    }

    // ── normal-case tests ──────────────────────────────────────────────────────

    // owed() USDC (== P, since owed <= tokenValue in the normal case) enters
    // CreditMarket (the NO accretion / collateral pool).
    function test_Claim_NormalCase_PaysNOAccretion() public {
        uint256 Q = _mintAndFlag(alice, MINT_AMT);

        uint256 owedAtClaim = market.owed(alice);
        uint256 tokenValue  = Q * market.currentMark() / 1e18;
        assertLt(owedAtClaim, tokenValue, "setup: must be normal case");

        uint256 marketUsdcBefore = mockUsdc.balanceOf(address(market));

        vm.prank(bob);
        engine.claim(alice);

        // owed() USDC entered CreditMarket — the NO accretion pool is replenished.
        assertEq(
            mockUsdc.balanceOf(address(market)),
            marketUsdcBefore + owedAtClaim,
            "owed() USDC credited to CreditMarket"
        );

        // Alice's flagged state is cleared.
        assertEq(market.fundingDebt(alice), 0,     "fundingDebt cleared");
        assertFalse(market.claimable(alice),        "claimable cleared");
    }

    // YES tokens transfer from original holder to liquidator; totalSupply unchanged.
    function test_Claim_NormalCase_YESTransfers() public {
        uint256 Q = _mintAndFlag(alice, MINT_AMT);

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
        uint256 Q = _mintAndFlag(alice, MINT_AMT);
        uint256 owedTotal = market.owed(alice);

        // Drop mark after flagging to create the tail-case scenario.
        // newMark = 0.001e18 → tokenValue = 1000e18 * 0.001e18 / 1e18 = 1e18 (1 USDC).
        // setMark accrues at the OLD mark first with elapsed == 0 here (same block
        // as the flag), so owed(alice) is unchanged by this call.
        uint256 newMark = 0.001e18;
        vm.prank(keeper);
        market.setMark(newMark);
        assertEq(market.owed(alice), owedTotal, "sanity: owed() unaffected by a same-block mark change");

        uint256 tokenValue = Q * newMark / 1e18;
        assertGt(owedTotal, tokenValue, "setup: must be tail case after mark drop");

        uint256 shortfall     = owedTotal - tokenValue;
        uint256 ifUsdcBefore  = mockUsdc.balanceOf(address(insuranceFund));
        uint256 mktUsdcBefore = mockUsdc.balanceOf(address(market));

        vm.prank(bob);
        engine.claim(alice);

        // InsuranceFund paid the shortfall.
        assertEq(
            mockUsdc.balanceOf(address(insuranceFund)),
            ifUsdcBefore - shortfall,
            "InsuranceFund reduced by shortfall"
        );

        // CreditMarket received tokenValue (from bob) + shortfall (from IF) == owedTotal.
        assertEq(
            mockUsdc.balanceOf(address(market)),
            mktUsdcBefore + owedTotal,
            "CreditMarket received full owed() total (NO made whole)"
        );
    }

    // UPDATED (F1 fix): there is no frozenFunding anymore — owed() (and therefore
    // the claim price) keeps growing with live accrual during the flagged window.
    // This is exactly what prevents the F1 permanent-collateral-leak: a
    // keeper-downtime gap between flag and claim no longer lets carry silently
    // vanish, because whoever eventually claims (or the InsuranceFund, in the tail
    // case) pays for the full live obligation at claim time.
    function test_Claim_PostFlagWarp_IncreasesOwedAndP() public {
        uint256 Q = _mintAndFlag(alice, MINT_AMT);
        uint256 owedAtFlag = market.owed(alice);

        // Warp well past the flag — live accrual keeps accumulating (no freeze).
        vm.warp(block.timestamp + 60 days);
        market.accrueFunding();

        uint256 owedAfterWarp = market.owed(alice);
        assertGt(owedAfterWarp, owedAtFlag, "owed() must keep accruing on a flagged position (no freeze)");

        uint256 marketUsdcBefore   = mockUsdc.balanceOf(address(market));
        uint256 ifUsdcBefore       = mockUsdc.balanceOf(address(insuranceFund));

        vm.prank(bob);
        engine.claim(alice);

        // Whether this lands in the normal case (all from bob) or the tail case
        // (bob pays tokenValue, InsuranceFund tops up the rest), the market's total
        // inflow always equals the LIVE owed() read at claim time — NO is made
        // whole either way, and nothing from the flagged window is lost.
        assertEq(mockUsdc.balanceOf(address(market)) - marketUsdcBefore, owedAfterWarp,
            "P (+ any InsuranceFund top-up) equals the LIVE owed() at claim time, including the post-flag warp");
        // Silence unused-variable warning if the tail branch isn't reached.
        ifUsdcBefore;
        Q;
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

    // ─── v1b1-2c: claim() touches only the YES side ────────────────────────────

    // Give the seized holder some NO on top of her frozen YES position (test
    // setup only — a plain-transfer redistribution, so total supply stays
    // balanced). UPDATED for v1b1-2c: claim() no longer calls settleFunding(user)
    // (that would double-charge the just-priced frozen debt against her NO
    // credit — see LiquidationEngine.claim's comment block). Her NO-side credit
    // is now left completely untouched by the claim: snapNO is not reset by
    // clearLiquidatedPosition, so no USDC moves to her during claim() and her
    // full noFundingCredit persists, to be collected at her own next touchpoint.
    function test_Liquidation_LeavesNOSideUntouched() public {
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

        uint256 cum = market.cumulativeFundingPerYES(); // == cumFundingPerNO
        uint256 expectedNoCredit = 1_500e18 * cum / 1e18;

        uint256 aliceUsdcBefore    = mockUsdc.balanceOf(alice);
        uint256 marketUsdcBefore   = mockUsdc.balanceOf(address(market));
        uint256 bobUsdcBefore      = mockUsdc.balanceOf(bob);

        uint256 owedTotal = market.owed(alice); // YES-side only, unnetted against her NO credit
        uint256 tokenValue = 1_000e18 * market.currentMark() / 1e18;
        uint256 P = owedTotal <= tokenValue ? owedTotal : tokenValue; // normal case: P == owed

        vm.prank(bob);
        engine.claim(alice);

        // Alice receives NOTHING during claim — no cash is ever pushed to the
        // original holder inside claim() (pull-over-push).
        assertEq(mockUsdc.balanceOf(alice), aliceUsdcBefore, "claim pushes no USDC to original holder");

        // Her NO-side credit is unaffected by the claim — snapNO untouched.
        assertEq(market.noFundingCredit(alice), expectedNoCredit,
            "seized holder's NO credit unchanged by claim (snapNO untouched)");

        // USDC conservation: liquidator paid P into the market; nothing else moved.
        assertEq(mockUsdc.balanceOf(bob), bobUsdcBefore - P, "liquidator paid exactly P");
        assertEq(mockUsdc.balanceOf(address(market)), marketUsdcBefore + P, "market gained exactly P");

        // Liquidation still proceeds normally: YES transfers, complete-set intact.
        assertEq(yesToken.balanceOf(bob), 1_000e18, "liquidator receives seized YES");
        assertEq(yesToken.totalSupply(), noToken.totalSupply(), "complete-set invariant holds");
    }

    // ─── F2 + flagged-liquidator coverage (2026-09-26 fix) ─────────────────────

    // F2 fix: clearLiquidatedPosition now calls settleFunding(liquidator) instead
    // of the removed _syncUserFunding, so a liquidator who already holds NO gets
    // their accrued NO credit PAID (not forfeited) as part of claiming.
    function test_Claim_LiquidatorWithNOCredit_GetsPaid() public {
        // Bob becomes a pure NO holder before acting as liquidator, so his own
        // accrued NO credit is a clean, unnetted number (not offset by a matching
        // YES debit from the same mint).
        vm.prank(bob);
        mockUsdc.approve(address(market), type(uint256).max);
        vm.prank(bob);
        market.mint(500e18); // bob: 500 YES + 500 NO
        address sink = makeAddr("bob-yes-sink");
        yesToken.grantRole(yesToken.CLOB_ROLE(), bob);
        vm.prank(bob);
        yesToken.transfer(sink, 500e18); // bob: 0 YES, 500 NO

        uint256 Q = _mintAndFlag(alice, MINT_AMT); // mints alice, warps 356 days, flags

        uint256 expectedNoCredit = 500e18 * (market.cumFundingPerNO() - market.snapNO(bob)) / 1e18;
        assertGt(expectedNoCredit, 0, "setup: bob must have nonzero accrued NO credit before claiming");

        uint256 owedAtClaim = market.owed(alice);
        uint256 tokenValue  = Q * market.currentMark() / 1e18;
        uint256 P           = owedAtClaim <= tokenValue ? owedAtClaim : tokenValue;

        uint256 bobUsdcBefore = mockUsdc.balanceOf(bob);

        vm.prank(bob);
        engine.claim(alice);

        assertEq(mockUsdc.balanceOf(bob), bobUsdcBefore - P + expectedNoCredit,
            "F2 fix: liquidator's own accrued NO credit is paid during clearLiquidatedPosition, not forfeited");
        assertEq(market.snapNO(bob), market.cumFundingPerNO(),
            "liquidator's NO snapshot advances (settleFunding ran, not the old early-return sync)");
    }

    // Invariant 10 / F3: a flagged position is fully locked, including acting as a
    // liquidator. clearLiquidatedPosition reverts PositionFrozen if the liquidator
    // itself is currently flagged claimable.
    function test_Claim_ByFlaggedLiquidator_Reverts() public {
        // Bob mints his own position and independently crosses the seizure trigger
        // on the same timeline as alice (both mint at t0, same 5% mark).
        vm.prank(bob);
        mockUsdc.approve(address(market), type(uint256).max);
        vm.prank(bob);
        market.mint(MINT_AMT);

        _mintAndFlag(alice, MINT_AMT); // mints alice, warps 356 days, flags alice

        assertTrue(market.isSeizable(bob), "bob must independently be seizable");
        vm.prank(keeper);
        market.flagClaimable(bob);
        assertTrue(market.claimable(bob), "bob flagged claimable");

        // Bob (flagged) attempts to claim alice's position — must revert: a
        // flagged position is fully locked, including as a liquidator.
        vm.prank(bob);
        vm.expectRevert(CreditMarket.PositionFrozen.selector);
        engine.claim(alice);
    }
}
