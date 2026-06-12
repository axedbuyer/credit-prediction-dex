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
            admin, address(usdc), address(yesToken), address(noToken), MARK
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
    //   1. Alice mints 1 000 USDC → 230 YES + 770 NO
    //   2. Alice sells all 770 NO to Bob (CLOB trade 1: Bob pays 770 USDC)
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
        // ── 1. alice mints 1 000 USDC ──────────────────────────────────────
        vm.prank(alice);
        market.mint(1_000e18);

        assertEq(yesToken.balanceOf(alice), 230e18,    "alice YES after mint");
        assertEq(noToken.balanceOf(alice),  770e18,    "alice NO after mint");
        assertEq(usdc.balanceOf(address(market)), 1_000e18, "market holds collateral");

        // ── 2. CLOB trade 1: alice sells 770 NO → bob sends 770 USDC ───────
        // alice = maker (sells NO), bob = taker (buys NO with USDC)
        uint256 expiry1 = block.timestamp + 1 hours;
        CLOBSettlement.Order memory a1 = _order(
            alice, address(noToken), address(usdc), 770e18, 770e18, expiry1, 0
        );
        CLOBSettlement.Order memory b1 = _order(
            bob,   address(usdc),    address(noToken), 770e18, 770e18, expiry1, 0
        );
        clob.verifyAndSettle(a1, _sign(aliceKey, a1), b1, _sign(bobKey, b1));

        // post-trade-1 balances
        assertEq(noToken.balanceOf(alice), 0,       "alice sold all NO");
        assertEq(noToken.balanceOf(bob),   770e18,  "bob holds 770 NO");
        assertEq(usdc.balanceOf(alice),    770e18,  "alice received USDC from bob");
        assertEq(usdc.balanceOf(bob),      230e18,  "bob spent 770 USDC");
        // CLOB is peer-to-peer — market USDC is untouched
        assertEq(usdc.balanceOf(address(market)), 1_000e18, "market USDC unchanged");

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

        // alice: 230 YES + 230 NO + 540 USDC — fully balanced for redeem
        assertEq(yesToken.balanceOf(alice), 230e18, "alice YES unchanged");
        assertEq(noToken.balanceOf(alice),  230e18, "alice reacquired 230 NO");
        assertEq(usdc.balanceOf(alice),     540e18, "alice USDC after buyback");

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

    // Credit event path: mint → become YES holder → credit event → settleYES at 1:1.
    //
    // Steps:
    //   1. Alice mints 1 000 USDC → 230 YES + 770 NO
    //   2. Alice sells all 770 NO to Bob (CLOB trade: Bob pays 770 USDC)
    //      → alice: 230 YES  bob: 770 NO
    //   3. vm.warp(60 days)
    //   4. OracleRouter.confirmCreditEvent() — market paused, flag set
    //   5. mint() and redeem() both revert
    //   6. Alice calls settleYES(230) → receives 230 USDC at zero recovery
    //   7. Bob (NO holder) tries settleYES → reverts (no YES to burn)
    //   8. Market retains 770 USDC (Bob's NO tokens are worthless)
    function test_FullLifecycle_CreditEvent() public {
        // ── 1. alice mints 1 000 USDC ──────────────────────────────────────
        vm.prank(alice);
        market.mint(1_000e18);

        // ── 2. CLOB trade: alice sells 770 NO → bob sends 770 USDC ─────────
        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory ao = _order(
            alice, address(noToken), address(usdc),    770e18, 770e18, expiry, 0
        );
        CLOBSettlement.Order memory bo = _order(
            bob,   address(usdc),    address(noToken), 770e18, 770e18, expiry, 0
        );
        clob.verifyAndSettle(ao, _sign(aliceKey, ao), bo, _sign(bobKey, bo));

        // alice: 230 YES, 0 NO, 770 USDC
        // bob:   0 YES, 770 NO, 230 USDC
        assertEq(yesToken.balanceOf(alice), 230e18, "alice holds YES");
        assertEq(noToken.balanceOf(bob),    770e18, "bob holds NO");
        assertEq(yesToken.balanceOf(bob),   0,      "bob has no YES");
        assertEq(usdc.balanceOf(address(market)), 1_000e18, "market USDC unchanged");

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

        // ── 6. alice settleYES(230) → 230 USDC at zero recovery ───────────
        uint256 aliceUsdcBefore = usdc.balanceOf(alice); // 770 + 1 from test setup above
        vm.prank(alice);
        market.settleYES(230e18);

        assertEq(yesToken.balanceOf(alice), 0, "alice YES burned on settlement");
        assertEq(usdc.balanceOf(alice), aliceUsdcBefore + 230e18,
            "alice receives exactly 230 USDC (zero recovery)");

        // ── 7. bob (NO holder) cannot redeem or settle ────────────────────
        vm.prank(bob);
        vm.expectRevert(); // ERC20InsufficientBalance — bob has 0 YES to burn
        market.settleYES(1);

        assertEq(noToken.balanceOf(bob), 770e18, "bob NO tokens still exist but worthless");

        // ── 8. market holds 770 USDC: bob's NO position is unclaimable ────
        // market started with 1 000 USDC; paid out 230 to alice's YES settlement
        assertEq(usdc.balanceOf(address(market)), 770e18,
            "770 USDC locked: corresponds to unclaimable NO collateral");

        // total USDC conservation: 1 000 (alice initial) + 1 000 (bob initial) + 1 (test mint) = 2 001
        uint256 total = usdc.balanceOf(alice)
                      + usdc.balanceOf(bob)
                      + usdc.balanceOf(address(market));
        assertEq(total, 2_001e18, "USDC invariant: total supply conserved through credit event");
    }
}
