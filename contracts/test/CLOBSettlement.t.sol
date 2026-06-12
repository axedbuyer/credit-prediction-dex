// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {YESToken} from "../src/YESToken.sol";
import {NOToken} from "../src/NOToken.sol";
import {CreditMarket} from "../src/CreditMarket.sol";
import {CLOBSettlement} from "../src/CLOBSettlement.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract CLOBSettlementTest is Test {
    MockUSDC usdc;
    YESToken yesToken;
    NOToken noToken;
    CreditMarket market;
    CLOBSettlement clob;

    address admin = address(this);

    // Accounts with known private keys so vm.sign works.
    uint256 makerKey = 0xA11CE;
    uint256 takerKey = 0xB0B;
    address maker;
    address taker;

    function setUp() public {
        maker = vm.addr(makerKey);
        taker = vm.addr(takerKey);

        usdc     = new MockUSDC();
        yesToken = new YESToken(admin);
        noToken  = new NOToken(admin);
        market   = new CreditMarket(
            admin, address(usdc), address(yesToken), address(noToken), 0.23e18
        );
        clob = new CLOBSettlement(address(market));

        // Wire token roles for CreditMarket
        yesToken.grantRole(yesToken.MINTER_ROLE(), address(market));
        yesToken.grantRole(yesToken.BURNER_ROLE(), address(market));
        noToken.grantRole(noToken.MINTER_ROLE(), address(market));
        noToken.grantRole(noToken.BURNER_ROLE(), address(market));

        // Grant CLOB_ROLE on tokens so CLOBSettlement can transferFrom YES/NO
        yesToken.grantRole(yesToken.CLOB_ROLE(), address(clob));
        noToken.grantRole(noToken.CLOB_ROLE(),  address(clob));

        // Grant CLOB_ROLE on market so CLOBSettlement can call syncUserFunding
        market.grantRole(market.CLOB_ROLE(), address(clob));

        // Give maker USDC and taker YES + NO tokens (direct mint for test setup)
        usdc.mint(maker, 10_000e18);
        yesToken.grantRole(yesToken.MINTER_ROLE(), admin);
        noToken.grantRole(noToken.MINTER_ROLE(), admin);
        yesToken.mint(taker, 1_000e18);
        noToken.mint(taker, 1_000e18);

        // Approvals: both parties approve the CLOB contract for all tokens
        vm.startPrank(maker);
        usdc.approve(address(clob), type(uint256).max);
        yesToken.approve(address(clob), type(uint256).max);
        noToken.approve(address(clob), type(uint256).max);
        vm.stopPrank();

        vm.startPrank(taker);
        usdc.approve(address(clob), type(uint256).max);
        yesToken.approve(address(clob), type(uint256).max);
        noToken.approve(address(clob), type(uint256).max);
        vm.stopPrank();
    }

    // ── helpers ───────────────────────────────────────────────────────────────

    function _order(
        address _maker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint256 expiry,
        uint256 nonce
    ) internal pure returns (CLOBSettlement.Order memory) {
        return CLOBSettlement.Order({
            maker: _maker,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: minAmountOut,
            expiry: expiry,
            nonce: nonce
        });
    }

    // vm.sign returns (v, r, s); OZ ECDSA expects r || s || v (65 bytes).
    function _sign(uint256 key, CLOBSettlement.Order memory order)
        internal
        view
        returns (bytes memory)
    {
        bytes32 digest = clob.hashOrder(order);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // ── tests ─────────────────────────────────────────────────────────────────

    function test_ValidYESBuy_Settles() public {
        uint256 usdcIn  = 100e18;
        uint256 yesOut  = 80e18;
        uint256 expiry  = block.timestamp + 1 hours;

        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), usdcIn, yesOut, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), yesOut, usdcIn, expiry, 0
        );

        uint256 makerUsdcBefore = usdc.balanceOf(maker);
        uint256 takerYesBefore  = yesToken.balanceOf(taker);

        clob.verifyAndSettle(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_));

        assertEq(usdc.balanceOf(maker),     makerUsdcBefore - usdcIn, "maker paid USDC");
        assertEq(yesToken.balanceOf(maker), yesOut,                   "maker received YES");
        assertEq(yesToken.balanceOf(taker), takerYesBefore - yesOut,  "taker gave YES");
        assertEq(usdc.balanceOf(taker),     usdcIn,                   "taker received USDC");
        assertTrue(clob.usedNonces(maker, 0), "maker nonce spent");
        assertTrue(clob.usedNonces(taker, 0), "taker nonce spent");
    }

    function test_ValidNOBuy_Settles() public {
        uint256 usdcIn = 100e18;
        uint256 noOut  = 150e18;
        uint256 expiry = block.timestamp + 1 hours;

        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(noToken), usdcIn, noOut, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(noToken), address(usdc), noOut, usdcIn, expiry, 0
        );

        uint256 makerUsdcBefore = usdc.balanceOf(maker);
        uint256 takerNoBefore   = noToken.balanceOf(taker);

        clob.verifyAndSettle(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_));

        assertEq(usdc.balanceOf(maker),    makerUsdcBefore - usdcIn, "maker paid USDC");
        assertEq(noToken.balanceOf(maker), noOut,                    "maker received NO");
        assertEq(noToken.balanceOf(taker), takerNoBefore - noOut,    "taker gave NO");
        assertEq(usdc.balanceOf(taker),    usdcIn,                   "taker received USDC");
    }

    function test_ExpiredOrder_Reverts() public {
        uint256 pastExpiry = block.timestamp - 1;
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 100e18, 80e18, pastExpiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 80e18, 100e18, block.timestamp + 1 hours, 0
        );
        // Compute sigs before vm.expectRevert — _sign calls clob.hashOrder (external call)
        // which would otherwise consume the revert expectation before verifyAndSettle runs.
        bytes memory ms = _sign(makerKey, mo);
        bytes memory ts = _sign(takerKey, to_);

        vm.expectRevert(CLOBSettlement.OrderExpired.selector);
        clob.verifyAndSettle(mo, ms, to_, ts);
    }

    function test_WrongSignature_Reverts() public {
        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 100e18, 80e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 80e18, 100e18, expiry, 0
        );
        bytes memory wrongSig = _sign(takerKey, mo); // taker signs maker's order
        bytes memory ts       = _sign(takerKey, to_);

        vm.expectRevert(CLOBSettlement.InvalidSignature.selector);
        clob.verifyAndSettle(mo, wrongSig, to_, ts);
    }

    function test_DuplicateNonce_Reverts() public {
        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 100e18, 80e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 80e18, 100e18, expiry, 0
        );
        bytes memory ms = _sign(makerKey, mo);
        bytes memory ts = _sign(takerKey, to_);

        clob.verifyAndSettle(mo, ms, to_, ts);

        // Second attempt with same nonces must fail.
        vm.expectRevert(CLOBSettlement.NonceUsed.selector);
        clob.verifyAndSettle(mo, ms, to_, ts);
    }

    function test_MismatchedPair_Reverts() public {
        uint256 expiry = block.timestamp + 1 hours;
        // Both orders buy YES — tokenIn/tokenOut don't complement each other.
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 100e18, 80e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(usdc), address(yesToken), 100e18, 80e18, expiry, 0
        );
        bytes memory ms = _sign(makerKey, mo);
        bytes memory ts = _sign(takerKey, to_);

        vm.expectRevert(CLOBSettlement.MismatchedPair.selector);
        clob.verifyAndSettle(mo, ms, to_, ts);
    }

    function test_FundingSyncedOnSettle() public {
        // Taker holds 1000 YES for 1 year, then sells 80 to maker.
        // The settle must capture the accrued carry on taker's pre-trade balance.

        vm.warp(block.timestamp + 365 days);

        uint256 expiry = block.timestamp + 1 hours;
        CLOBSettlement.Order memory mo = _order(
            maker, address(usdc), address(yesToken), 100e18, 80e18, expiry, 0
        );
        CLOBSettlement.Order memory to_ = _order(
            taker, address(yesToken), address(usdc), 80e18, 100e18, expiry, 0
        );

        clob.verifyAndSettle(mo, _sign(makerKey, mo), to_, _sign(takerKey, to_));

        // After 1 year at 23% mark: cumulativeFundingPerYES = 0.23e18 (exact).
        uint256 expectedCumulative = uint256(0.23e18) * 365 days / 365 days;
        assertEq(market.cumulativeFundingPerYES(), expectedCumulative, "cumulative accrued");

        // Taker's snapshot must equal the cumulative (sync happened during settle).
        assertEq(market.fundingSnapshot(taker), expectedCumulative, "taker snapshot updated");

        // Taker held 1000 YES for 1 year → debt = 1000e18 * 0.23e18 / 1e18 = 230e18.
        uint256 expectedDebt = 1_000e18 * expectedCumulative / 1e18;
        assertEq(market.fundingDebt(taker), expectedDebt, "taker funding debt captured");
    }
}
