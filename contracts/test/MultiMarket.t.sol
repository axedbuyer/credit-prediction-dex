// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {InsuranceFund} from "../src/InsuranceFund.sol";
import {CLOBSettlement} from "../src/CLOBSettlement.sol";
import {CreditMarket} from "../src/CreditMarket.sol";
import {YESToken} from "../src/YESToken.sol";
import {MockUSDC} from "./invariant/Handler.sol";
import {MarketSetBuilder} from "./helpers/MarketSetBuilder.sol";

// Two complete market sets (A, B) sharing ONE MockUSDC and ONE InsuranceFund, both
// registered. Nothing in one market's contracts may touch the other's collateral,
// signatures, tokens, or funding ledger.
contract MultiMarketTest is Test {
    MockUSDC usdc;
    InsuranceFund insuranceFund;
    MarketRegistry registry;
    MarketSetBuilder.MarketSet A;
    MarketSetBuilder.MarketSet B;

    address admin = address(this);
    address keeper = makeAddr("keeper");
    address oracle = makeAddr("oracle");
    address teamWallet = makeAddr("teamWallet");

    uint256 aliceKey = 0xA11CE;
    uint256 bobKey = 0xB0B;
    address alice;
    address bob;
    address liq = makeAddr("liquidator");

    uint256 constant MARK = 0.05e18;
    uint256 constant AMT = 1_000e18;
    uint256 constant IF_SEED = 100_000e18;

    function setUp() public {
        alice = vm.addr(aliceKey);
        bob = vm.addr(bobKey);

        usdc = new MockUSDC();
        insuranceFund = new InsuranceFund(admin, address(usdc));
        registry = new MarketRegistry(admin, address(usdc), address(insuranceFund));
        A = MarketSetBuilder.build(address(usdc), insuranceFund, "YES-CRWV", "NO-CRWV", MARK);
        B = MarketSetBuilder.build(address(usdc), insuranceFund, "YES-TRY", "NO-TRY", MARK);

        _finish(A, "crwv", "CoreWeave", MarketRegistry.EntityType.Corporate);
        _finish(B, "try", "Republic of Turkey", MarketRegistry.EntityType.Sovereign);

        usdc.mint(address(insuranceFund), IF_SEED);
        address[3] memory users = [alice, bob, liq];
        for (uint256 i = 0; i < 3; i++) {
            usdc.mint(users[i], 1_000_000e18);
            _approveAll(users[i], A);
            _approveAll(users[i], B);
        }
    }

    function _finish(
        MarketSetBuilder.MarketSet memory s,
        string memory slug,
        string memory name,
        MarketRegistry.EntityType t
    ) internal {
        s.market.grantRole(s.market.KEEPER_ROLE(), keeper);
        s.router.grantRole(s.router.ORACLE_ROLE(), oracle);
        s.clob.setFeeConfig(50, teamWallet, address(insuranceFund), 5_000);
        registry.register(
            slug,
            name,
            t,
            MarketRegistry.MarketContracts({
                creditMarket: address(s.market),
                yesToken: address(s.yes),
                noToken: address(s.no),
                clobSettlement: address(s.clob),
                oracleRouter: address(s.router),
                liquidationEngine: address(s.engine)
            }),
            1
        );
    }

    function _approveAll(address u, MarketSetBuilder.MarketSet memory s) internal {
        vm.startPrank(u);
        usdc.approve(address(s.market), type(uint256).max);
        usdc.approve(address(s.clob), type(uint256).max);
        usdc.approve(address(s.engine), type(uint256).max);
        s.yes.approve(address(s.clob), type(uint256).max);
        s.no.approve(address(s.clob), type(uint256).max);
        vm.stopPrank();
    }

    function _mint(MarketSetBuilder.MarketSet memory s, address who, uint256 amt) internal {
        vm.prank(who);
        s.market.mint(amt);
    }

    function _order(address maker, address tIn, address tOut, uint256 aIn, uint256 minOut, uint256 nonce)
        internal
        view
        returns (CLOBSettlement.Order memory)
    {
        return CLOBSettlement.Order({
            maker: maker,
            tokenIn: tIn,
            tokenOut: tOut,
            amountIn: aIn,
            minAmountOut: minOut,
            expiry: block.timestamp + 1 hours,
            nonce: nonce
        });
    }

    function _sign(CLOBSettlement clobDomain, uint256 key, CLOBSettlement.Order memory o)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, clobDomain.hashOrder(o));
        return abi.encodePacked(r, s, v);
    }

    // `seller` (key sellerKey) sells `amt` YES to `buyer` (key buyerKey) for `price` on market s.
    function _sellYes(
        MarketSetBuilder.MarketSet memory s,
        uint256 sellerKey,
        uint256 buyerKey,
        uint256 amt,
        uint256 price,
        uint256 nonce
    ) internal {
        address seller = vm.addr(sellerKey);
        address buyer = vm.addr(buyerKey);
        CLOBSettlement.Order memory mo = _order(buyer, address(usdc), address(s.yes), price, amt, nonce);
        CLOBSettlement.Order memory to_ = _order(seller, address(s.yes), address(usdc), amt, price, nonce);
        s.clob.verifyAndSettle(mo, _sign(s.clob, buyerKey, mo), to_, _sign(s.clob, sellerKey, to_));
    }

    // ── registry sanity ─────────────────────────────────────────────────────────

    function test_BothMarketsRegistered() public view {
        assertEq(registry.marketCount(), 2);
        assertEq(registry.marketIdOf(address(A.yes)), 0);
        assertEq(registry.marketIdOf(address(B.engine)), 1);
        assertEq(registry.getMarketBySlug("try").clobSettlement, address(B.clob));
        assertEq(YESToken(address(A.yes)).symbol(), "YES-CRWV");
        assertEq(YESToken(address(B.yes)).symbol(), "YES-TRY");
    }

    // ── shared InsuranceFund receives fees from BOTH CLOBs ──────────────────────

    function test_FeesFromBothCLOBsLandInSharedInsuranceFund() public {
        _mint(A, bob, AMT);
        _mint(B, bob, AMT);

        uint256 price = 300e18; // 30% of 1000
        uint256 expectedFee = A.clob.tradeFee(AMT, price); // 50 bps * min(p,1-p) * Q
        assertEq(expectedFee, 1.5e18);
        uint256 toIF = expectedFee * 5_000 / 10_000;
        uint256 toTeam = expectedFee - toIF;

        uint256 ifBefore = usdc.balanceOf(address(insuranceFund));

        _sellYes(A, bobKey, aliceKey, AMT, price, 1);
        assertEq(usdc.balanceOf(address(insuranceFund)), ifBefore + toIF, "A's fee -> shared IF");
        _sellYes(B, bobKey, aliceKey, AMT, price, 1); // nonces are per-CLOB, so 1 is fresh on B too
        assertEq(usdc.balanceOf(address(insuranceFund)), ifBefore + 2 * toIF, "B's fee -> same shared IF");
        assertEq(usdc.balanceOf(teamWallet), 2 * toTeam);
        // fees never touch either collateral pool
        assertEq(usdc.balanceOf(address(A.market)), AMT);
        assertEq(usdc.balanceOf(address(B.market)), AMT);
    }

    // ── tail-case claim in A draws the IF shortfall into A only ─────────────────

    function test_TailCaseClaimInA_ShortfallGoesToA_BCollateralUntouched() public {
        _mint(A, alice, AMT);
        _mint(B, alice, AMT);
        vm.warp(block.timestamp + 356 days);
        A.market.accrueFunding();
        B.market.accrueFunding();
        assertTrue(A.market.isSeizable(alice));
        assertTrue(B.market.isSeizable(alice));

        vm.prank(keeper);
        A.market.flagClaimable(alice);
        // mark gap in A only: tokenValue collapses so owed > m*Q
        vm.prank(keeper);
        A.market.setMark(0.001e18);

        uint256 owedA = A.market.owed(alice);
        uint256 tokenValue = AMT * 0.001e18 / 1e18;
        assertGt(owedA, tokenValue, "tail case");
        uint256 shortfall = owedA - tokenValue;

        uint256 bBefore = usdc.balanceOf(address(B.market));
        uint256 aBefore = usdc.balanceOf(address(A.market));
        uint256 ifBefore = usdc.balanceOf(address(insuranceFund));
        uint256 bOwedBefore = B.market.owed(alice);

        vm.prank(liq);
        A.engine.claim(alice);

        assertEq(usdc.balanceOf(address(insuranceFund)), ifBefore - shortfall, "IF paid the shortfall");
        assertEq(usdc.balanceOf(address(A.market)), aBefore + owedA, "A collateral += owed (P + shortfall)");
        assertEq(usdc.balanceOf(address(B.market)), bBefore, "B collateral exactly unchanged");
        assertEq(B.market.owed(alice), bOwedBefore, "B ledger unchanged");
        assertFalse(B.market.claimable(alice));
        assertEq(B.yes.balanceOf(alice), AMT, "alice still holds B's YES");
        assertEq(A.yes.balanceOf(liq), AMT, "liquidator got A's YES");
        assertEq(A.yes.totalSupply(), A.no.totalSupply());
    }

    // ── orders are bound to one CLOB's EIP-712 domain ───────────────────────────

    function test_OrderSignedForA_CannotSettleOnB() public {
        _mint(A, bob, AMT);
        _mint(B, bob, AMT);

        uint256 price = 300e18;
        // sign against A's domain, but with B's tokens, submitted to B
        CLOBSettlement.Order memory mo = _order(alice, address(usdc), address(B.yes), price, AMT, 7);
        CLOBSettlement.Order memory to_ = _order(bob, address(B.yes), address(usdc), AMT, price, 7);
        bytes memory mSig = _sign(A.clob, aliceKey, mo);
        bytes memory tSig = _sign(A.clob, bobKey, to_);

        vm.expectRevert(CLOBSettlement.InvalidSignature.selector);
        B.clob.verifyAndSettle(mo, mSig, to_, tSig);

        // the same A-signed orders (A's tokens) DO settle on A
        CLOBSettlement.Order memory mo2 = _order(alice, address(usdc), address(A.yes), price, AMT, 8);
        CLOBSettlement.Order memory to2 = _order(bob, address(A.yes), address(usdc), AMT, price, 8);
        A.clob.verifyAndSettle(mo2, _sign(A.clob, aliceKey, mo2), to2, _sign(A.clob, bobKey, to2));
        assertEq(A.yes.balanceOf(alice), AMT);

        // and an A-signed order replayed on B (same order contents) is rejected too
        bytes memory m2Sig = _sign(A.clob, aliceKey, mo2);
        bytes memory t2Sig = _sign(A.clob, bobKey, to2);
        vm.expectRevert(CLOBSettlement.InvalidSignature.selector);
        B.clob.verifyAndSettle(mo2, m2Sig, to2, t2Sig);
    }

    // B's CLOB can never move A's tokens: it has no CLOB_ROLE on them.
    function test_ATokensCannotBeTradedThroughB() public {
        _mint(A, bob, AMT);
        uint256 price = 300e18;

        // Orders properly signed for B's domain but naming A's YES. bob holds NO B tokens, so B's CLOB
        // has nothing to move; A's YES balances must be untouched either way.
        CLOBSettlement.Order memory mo = _order(alice, address(usdc), address(A.yes), price, AMT, 1);
        CLOBSettlement.Order memory to_ = _order(bob, address(A.yes), address(usdc), AMT, price, 1);
        bytes memory mSig = _sign(B.clob, aliceKey, mo);
        bytes memory tSig = _sign(B.clob, bobKey, to_);
        vm.expectRevert();
        B.clob.verifyAndSettle(mo, mSig, to_, tSig);
        assertEq(A.yes.balanceOf(bob), AMT);
        assertEq(A.yes.balanceOf(alice), 0);

        // Directly: B's CLOB (and B's engine) hold no role on A's tokens.
        vm.prank(bob);
        A.yes.approve(address(B.clob), type(uint256).max); // even WITH an allowance
        vm.prank(address(B.clob));
        vm.expectRevert(YESToken.TransferRestricted.selector);
        A.yes.transferFrom(bob, alice, 1);
        vm.prank(address(B.engine));
        vm.expectRevert();
        A.yes.forcedTransfer(bob, alice, 1);
        // nor can B's contracts mint/burn A's tokens
        vm.prank(address(B.market));
        vm.expectRevert();
        A.yes.mint(alice, 1);
        vm.prank(address(B.market));
        vm.expectRevert();
        A.yes.burn(bob, 1);
        // nor call into A's CreditMarket as a liquidator/clob
        vm.prank(address(B.engine));
        vm.expectRevert();
        A.market.clearLiquidatedPosition(bob, alice);
        vm.prank(address(B.clob));
        vm.expectRevert();
        A.market.markDebtCollected(bob);
    }

    // ── a credit event in A leaves B fully operational ──────────────────────────

    function test_CreditEventInA_BStaysOperational() public {
        _mint(A, alice, AMT);
        _mint(B, alice, AMT);
        _mint(B, bob, AMT);

        vm.prank(oracle);
        A.router.confirmCreditEvent();
        assertTrue(A.market.creditEventConfirmed());
        assertTrue(A.market.paused());
        assertFalse(B.market.creditEventConfirmed());
        assertFalse(B.market.paused());

        // A: settleYES pays par, mint is paused
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        A.market.settleYES(AMT);
        assertEq(usdc.balanceOf(alice), before + AMT);
        vm.prank(alice);
        vm.expectRevert();
        A.market.mint(1e18);

        // B: mint, CLOB trade, redeem all work
        _mint(B, alice, AMT);
        _sellYes(B, bobKey, aliceKey, AMT, 300e18, 1);
        assertEq(B.yes.balanceOf(alice), 3 * AMT);
        vm.prank(alice);
        B.market.redeem(AMT); // alice holds 3*AMT YES but only AMT NO in B
        assertEq(B.yes.totalSupply(), B.no.totalSupply());

        // B: liquidation lifecycle still works
        vm.warp(block.timestamp + 356 days);
        B.market.accrueFunding();
        assertTrue(B.market.isSeizable(bob) || B.market.isSeizable(alice));
        address victim = B.market.isSeizable(alice) ? alice : bob;
        vm.prank(keeper);
        B.market.flagClaimable(victim);
        vm.prank(liq);
        B.engine.claim(victim);
        assertEq(B.yes.totalSupply(), B.no.totalSupply());
    }

    // ── same user, two markets: settled independently ───────────────────────────

    function test_SameUserInBothMarkets_SettledIndependently() public {
        // distinct marks so the two ledgers genuinely differ
        vm.prank(keeper);
        B.market.setMark(0.10e18);

        _mint(A, alice, AMT);
        _mint(B, alice, AMT);
        _mint(A, bob, AMT);
        vm.warp(block.timestamp + 100 days);
        A.market.accrueFunding();
        B.market.accrueFunding();

        uint256 owedA = A.market.owed(alice);
        uint256 owedB = B.market.owed(alice);
        uint256 span = 100 days;
        uint256 markB = 0.10e18;
        assertEq(owedA, AMT * (MARK * span / 365 days) / 1e18);
        assertEq(owedB, AMT * (markB * span / 365 days) / 1e18);
        assertTrue(owedA != owedB);

        // alice sells her YES in A: only A's ledger/snapshots move
        uint256 snapB = B.market.fundingSnapshot(alice);
        uint256 debtB = B.market.fundingDebt(alice);
        uint256 collB = usdc.balanceOf(address(B.market));
        _sellYes(A, aliceKey, bobKey, AMT, 300e18, 1);
        assertEq(A.market.fundingSnapshot(alice), A.market.cumulativeFundingPerYES());
        assertEq(A.market.owed(alice), 0);
        assertEq(B.market.fundingSnapshot(alice), snapB, "B snapshot untouched");
        assertEq(B.market.fundingDebt(alice), debtB, "B debt untouched");
        assertEq(B.market.owed(alice), owedB, "B owed untouched");
        assertEq(usdc.balanceOf(address(B.market)), collB, "B collateral untouched");

        // flagging alice in B locks B only: A still lets her mint/redeem (she has NO in A)
        vm.warp(block.timestamp + 256 days);
        A.market.accrueFunding();
        B.market.accrueFunding();
        assertTrue(B.market.isSeizable(alice));
        vm.prank(keeper);
        B.market.flagClaimable(alice);
        vm.prank(alice);
        vm.expectRevert(CreditMarket.PositionFrozen.selector);
        B.market.mint(1e18);
        _mint(A, alice, 10e18); // A unaffected
        vm.prank(alice);
        A.market.redeem(10e18);

        // cure in B settles B's owed only
        uint256 aBal = usdc.balanceOf(address(A.market));
        vm.prank(alice);
        B.market.cure();
        assertFalse(B.market.claimable(alice));
        assertEq(usdc.balanceOf(address(A.market)), aBal, "cure in B did not touch A collateral");
    }
}
