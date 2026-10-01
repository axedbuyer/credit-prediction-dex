// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";
import {InsuranceFund} from "../src/InsuranceFund.sol";
import {CreditMarket} from "../src/CreditMarket.sol";
import {CLOBSettlement} from "../src/CLOBSettlement.sol";
import {OracleRouter} from "../src/OracleRouter.sol";
import {LiquidationEngine} from "../src/LiquidationEngine.sol";
import {MockUSDC} from "./invariant/Handler.sol";
import {MarketSetBuilder} from "./helpers/MarketSetBuilder.sol";

contract MarketRegistryTest is Test {
    using MarketSetBuilder for *;

    MockUSDC usdc;
    InsuranceFund insuranceFund;
    MarketRegistry registry;

    MarketSetBuilder.MarketSet a;
    MarketSetBuilder.MarketSet b;

    address admin = address(this);
    address stranger = makeAddr("stranger");

    event MarketRegistered(
        uint256 indexed marketId,
        string slug,
        address creditMarket,
        address yesToken,
        address noToken,
        address clobSettlement,
        address oracleRouter,
        address liquidationEngine
    );
    event MarketActiveSet(uint256 indexed marketId, bool active);

    function setUp() public {
        usdc = new MockUSDC();
        insuranceFund = new InsuranceFund(admin, address(usdc));
        registry = new MarketRegistry(admin, address(usdc), address(insuranceFund));
        a = MarketSetBuilder.build(address(usdc), insuranceFund, "YES-CRWV", "NO-CRWV", 0.10e18);
        b = MarketSetBuilder.build(address(usdc), insuranceFund, "YES-TRY", "NO-TRY", 0.02e18);
    }

    function _c(MarketSetBuilder.MarketSet memory s) internal pure returns (MarketRegistry.MarketContracts memory) {
        return MarketRegistry.MarketContracts({
            creditMarket: address(s.market),
            yesToken: address(s.yes),
            noToken: address(s.no),
            clobSettlement: address(s.clob),
            oracleRouter: address(s.router),
            liquidationEngine: address(s.engine)
        });
    }

    function _registerA() internal returns (uint256) {
        return registry.register("crwv", "CoreWeave", MarketRegistry.EntityType.Corporate, _c(a), 1);
    }

    // ── happy path / lookups ────────────────────────────────────────────────────

    function test_Constructor() public view {
        assertEq(registry.usdc(), address(usdc));
        assertEq(registry.insuranceFund(), address(insuranceFund));
        assertTrue(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), admin));
        assertEq(registry.marketCount(), 0);
    }

    function test_Constructor_RevertsOnZero() public {
        vm.expectRevert(MarketRegistry.ZeroAddress.selector);
        new MarketRegistry(address(0), address(usdc), address(insuranceFund));
        vm.expectRevert(MarketRegistry.ZeroAddress.selector);
        new MarketRegistry(admin, address(0), address(insuranceFund));
        vm.expectRevert(MarketRegistry.ZeroAddress.selector);
        new MarketRegistry(admin, address(usdc), address(0));
    }

    function test_Register_HappyPath() public {
        vm.roll(100);
        vm.expectEmit(true, false, false, true);
        emit MarketRegistered(
            0, "crwv", address(a.market), address(a.yes), address(a.no), address(a.clob), address(a.router), address(a.engine)
        );
        uint256 id = registry.register("crwv", "CoreWeave", MarketRegistry.EntityType.Corporate, _c(a), 42);
        assertEq(id, 0);
        assertEq(registry.marketCount(), 1);

        MarketRegistry.Market memory m = registry.getMarket(0);
        assertEq(m.slug, "crwv");
        assertEq(m.entityName, "CoreWeave");
        assertEq(uint8(m.entityType), uint8(MarketRegistry.EntityType.Corporate));
        assertEq(m.creditMarket, address(a.market));
        assertEq(m.yesToken, address(a.yes));
        assertEq(m.noToken, address(a.no));
        assertEq(m.clobSettlement, address(a.clob));
        assertEq(m.oracleRouter, address(a.router));
        assertEq(m.liquidationEngine, address(a.engine));
        assertTrue(m.active);
        assertEq(m.registeredAt, 100);
        assertEq(m.startBlock, 42);
    }

    function test_Register_TwoMarkets_IdsAndLookups() public {
        assertEq(_registerA(), 0);
        assertEq(registry.register("try", "Turkey", MarketRegistry.EntityType.Sovereign, _c(b), 1), 1);
        assertEq(registry.marketCount(), 2);

        assertEq(registry.marketIdBySlug("crwv"), 0);
        assertEq(registry.marketIdBySlug("try"), 1);
        assertEq(registry.getMarketBySlug("try").creditMarket, address(b.market));
        assertEq(uint8(registry.getMarketBySlug("try").entityType), uint8(MarketRegistry.EntityType.Sovereign));

        // every one of the six addresses maps back to its market
        assertEq(registry.marketIdOf(address(a.market)), 0);
        assertEq(registry.marketIdOf(address(a.yes)), 0);
        assertEq(registry.marketIdOf(address(a.no)), 0);
        assertEq(registry.marketIdOf(address(a.clob)), 0);
        assertEq(registry.marketIdOf(address(a.router)), 0);
        assertEq(registry.marketIdOf(address(a.engine)), 0);
        assertEq(registry.marketIdOf(address(b.market)), 1);
        assertEq(registry.marketIdOf(address(b.engine)), 1);
        assertTrue(registry.isRegisteredAddress(address(b.no)));
        assertFalse(registry.isRegisteredAddress(stranger));

        MarketRegistry.Market[] memory all = registry.allMarkets();
        assertEq(all.length, 2);
        assertEq(all[0].slug, "crwv");
        assertEq(all[1].slug, "try");
    }

    function test_Lookups_UnknownRevert() public {
        _registerA();
        vm.expectRevert(MarketRegistry.UnknownMarket.selector);
        registry.getMarket(1);
        vm.expectRevert(MarketRegistry.UnknownMarket.selector);
        registry.getMarketBySlug("nope");
        vm.expectRevert(MarketRegistry.UnknownMarket.selector);
        registry.marketIdBySlug("nope");
        vm.expectRevert(MarketRegistry.UnknownMarket.selector);
        registry.marketIdOf(stranger);
    }

    function test_Register_StartBlockMayPrecedeRegistration() public {
        vm.roll(500);
        registry.register("crwv", "CoreWeave", MarketRegistry.EntityType.Corporate, _c(a), 7);
        assertEq(registry.getMarket(0).startBlock, 7);
        assertEq(registry.getMarket(0).registeredAt, 500);
    }

    // ── register reverts ────────────────────────────────────────────────────────

    function test_Register_OnlyAdmin() public {
        MarketRegistry.MarketContracts memory c = _c(a);
        bytes memory err = abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, registry.DEFAULT_ADMIN_ROLE()
        );
        vm.prank(stranger);
        vm.expectRevert(err);
        registry.register("crwv", "CoreWeave", MarketRegistry.EntityType.Corporate, c, 1);
    }

    function test_Register_InvalidSlug() public {
        MarketRegistry.MarketContracts memory c = _c(a);
        string[7] memory bad = [
            "",
            "abcdefghijklmnopqrstuvwxyz0123456", // 33 bytes
            "CRWV", // uppercase
            "cr wv", // space
            "cr_wv", // underscore
            "crwv.", // dot
            unicode"crwé" // non-ascii
        ];
        for (uint256 i = 0; i < bad.length; i++) {
            vm.expectRevert(MarketRegistry.InvalidSlug.selector);
            registry.register(bad[i], "CoreWeave", MarketRegistry.EntityType.Corporate, c, 1);
        }
    }

    function test_Register_SlugBoundaries_Accepted() public {
        // exactly 32 bytes, digits and hyphens allowed
        registry.register("a2345678901234567890123456789-12", "X", MarketRegistry.EntityType.Corporate, _c(a), 1);
        assertEq(registry.marketCount(), 1);
    }

    function test_Register_DuplicateSlug() public {
        _registerA();
        vm.expectRevert(MarketRegistry.SlugAlreadyRegistered.selector);
        registry.register("crwv", "Other", MarketRegistry.EntityType.Corporate, _c(b), 1);
    }

    function test_Register_EmptyEntityName() public {
        vm.expectRevert(MarketRegistry.EmptyEntityName.selector);
        registry.register("crwv", "", MarketRegistry.EntityType.Corporate, _c(a), 1);
    }

    function test_Register_StartBlockInFuture() public {
        vm.expectRevert(MarketRegistry.InvalidStartBlock.selector);
        registry.register("crwv", "CoreWeave", MarketRegistry.EntityType.Corporate, _c(a), uint64(block.number + 1));
    }

    function test_Register_ZeroAddressEach() public {
        for (uint256 i = 0; i < 6; i++) {
            MarketRegistry.MarketContracts memory c = _c(a);
            if (i == 0) c.creditMarket = address(0);
            if (i == 1) c.yesToken = address(0);
            if (i == 2) c.noToken = address(0);
            if (i == 3) c.clobSettlement = address(0);
            if (i == 4) c.oracleRouter = address(0);
            if (i == 5) c.liquidationEngine = address(0);
            vm.expectRevert(MarketRegistry.ZeroAddress.selector);
            registry.register("crwv", "CoreWeave", MarketRegistry.EntityType.Corporate, c, 1);
        }
    }

    function test_Register_SameSetUnderNewSlugReverts() public {
        _registerA();
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.AddressAlreadyRegistered.selector, address(a.market)));
        registry.register("crwv2", "CoreWeave", MarketRegistry.EntityType.Corporate, _c(a), 1);
    }

    // A second, fully self-consistent set built over market A's TOKENS (new CreditMarket/CLOB/router/
    // engine, same YES/NO) passes every consistency check — only the uniqueness check can reject it.
    function test_Register_ConsistentSetReusingTokensReverts() public {
        _registerA();
        CreditMarket m2 = new CreditMarket(admin, address(usdc), address(a.yes), address(a.no), 0.05e18, 1 days);
        MarketRegistry.MarketContracts memory c = MarketRegistry.MarketContracts({
            creditMarket: address(m2),
            yesToken: address(a.yes),
            noToken: address(a.no),
            clobSettlement: address(new CLOBSettlement(address(m2), admin)),
            oracleRouter: address(new OracleRouter(admin, address(m2))),
            liquidationEngine: address(new LiquidationEngine(address(m2), address(insuranceFund)))
        });
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.AddressAlreadyRegistered.selector, address(a.yes)));
        registry.register("try", "Turkey", MarketRegistry.EntityType.Sovereign, c, 1);
    }

    function test_Register_SameAddressInTwoSlotsOfOneSet() public {
        // oracleRouter slot == creditMarket slot: consistency reverts first (router has no creditMarket())
        MarketRegistry.MarketContracts memory c = _c(a);
        c.oracleRouter = address(a.market);
        vm.expectRevert(); // CreditMarket has no creditMarket(): call reverts
        registry.register("crwv", "CoreWeave", MarketRegistry.EntityType.Corporate, c, 1);
    }

    // ── consistency checks, each with a deliberately mismatched set ─────────────

    function _expectInconsistent(string memory check, MarketRegistry.MarketContracts memory c) internal {
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.InconsistentMarketSet.selector, check));
        registry.register("try", "Turkey", MarketRegistry.EntityType.Sovereign, c, 1);
    }

    function test_Consistency_MarketUsdc() public {
        MockUSDC other = new MockUSDC();
        MarketSetBuilder.MarketSet memory s = MarketSetBuilder.build(address(other), insuranceFund, "YES-X", "NO-X", 0.1e18);
        _expectInconsistent("creditMarket.usdc", _c(s));
    }

    function test_Consistency_MarketYesToken() public {
        MarketRegistry.MarketContracts memory c = _c(b);
        c.yesToken = address(a.yes);
        _expectInconsistent("creditMarket.yesToken", c);
    }

    function test_Consistency_MarketNoToken() public {
        MarketRegistry.MarketContracts memory c = _c(b);
        c.noToken = address(a.no);
        _expectInconsistent("creditMarket.noToken", c);
    }

    function test_Consistency_ClobCreditMarket() public {
        MarketRegistry.MarketContracts memory c = _c(b);
        c.clobSettlement = address(a.clob);
        _expectInconsistent("clob.creditMarket", c);
    }

    // CLOB that points at the right CreditMarket but a different USDC / token set is impossible to
    // build through CLOBSettlement's constructor (it reads usdc/yes/no from the CreditMarket), so
    // those three checks are exercised via a stub that lies about one field.
    function _stubClob(MarketSetBuilder.MarketSet memory s, address usdc_, address yes_, address no_)
        internal
        returns (address)
    {
        return address(new StubClob(address(s.market), usdc_, yes_, no_));
    }

    function test_Consistency_ClobUsdc() public {
        MarketRegistry.MarketContracts memory c = _c(b);
        c.clobSettlement = _stubClob(b, makeAddr("otherUsdc"), address(b.yes), address(b.no));
        _expectInconsistent("clob.usdc", c);
    }

    function test_Consistency_ClobYesToken() public {
        MarketRegistry.MarketContracts memory c = _c(b);
        c.clobSettlement = _stubClob(b, address(usdc), makeAddr("otherYes"), address(b.no));
        _expectInconsistent("clob.yesToken", c);
    }

    function test_Consistency_ClobNoToken() public {
        MarketRegistry.MarketContracts memory c = _c(b);
        c.clobSettlement = _stubClob(b, address(usdc), address(b.yes), makeAddr("otherNo"));
        _expectInconsistent("clob.noToken", c);
    }

    function test_Consistency_EngineCreditMarket() public {
        MarketRegistry.MarketContracts memory c = _c(b);
        c.liquidationEngine = address(a.engine);
        _expectInconsistent("liquidationEngine.creditMarket", c);
    }

    function test_Consistency_EngineInsuranceFund() public {
        InsuranceFund otherFund = new InsuranceFund(admin, address(usdc));
        LiquidationEngine rogue = new LiquidationEngine(address(b.market), address(otherFund));
        MarketRegistry.MarketContracts memory c = _c(b);
        c.liquidationEngine = address(rogue);
        _expectInconsistent("liquidationEngine.insuranceFund", c);
    }

    function test_Consistency_RouterCreditMarket() public {
        MarketRegistry.MarketContracts memory c = _c(b);
        c.oracleRouter = address(a.router);
        _expectInconsistent("oracleRouter.creditMarket", c);
    }

    // The uniqueness check fires for a consistency-passing set that reuses a registered address:
    // a second router/engine/clob built over the SAME CreditMarket is consistent but collides on
    // the CreditMarket (and the tokens) already owned by market A.
    function test_Register_SecondSetOverSameCreditMarketReverts() public {
        _registerA();
        OracleRouter router2 = new OracleRouter(admin, address(a.market));
        MarketRegistry.MarketContracts memory c = _c(a);
        c.oracleRouter = address(router2);
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.AddressAlreadyRegistered.selector, address(a.market)));
        registry.register("crwv2", "CoreWeave 2", MarketRegistry.EntityType.Corporate, c, 1);
    }

    // A reverted register leaves no trace (slug and addresses stay free).
    function test_Register_FailedRegisterLeavesNoState() public {
        MarketRegistry.MarketContracts memory c = _c(b);
        c.oracleRouter = address(a.router);
        vm.expectRevert();
        registry.register("try", "Turkey", MarketRegistry.EntityType.Sovereign, c, 1);
        assertEq(registry.marketCount(), 0);
        assertFalse(registry.isRegisteredAddress(address(b.market)));
        // the slug is still free, and B registers cleanly afterwards
        assertEq(registry.register("try", "Turkey", MarketRegistry.EntityType.Sovereign, _c(b), 1), 0);
    }

    // ── immutability + setActive ────────────────────────────────────────────────

    function test_SetActive_TogglesOnlyActive() public {
        _registerA();
        MarketRegistry.Market memory before_ = registry.getMarket(0);

        vm.expectEmit(true, false, false, true);
        emit MarketActiveSet(0, false);
        registry.setActive(0, false);

        MarketRegistry.Market memory after_ = registry.getMarket(0);
        assertFalse(after_.active);
        assertEq(keccak256(abi.encode(_withActive(after_, true))), keccak256(abi.encode(before_)), "only `active` may change");

        registry.setActiveBySlug("crwv", true);
        assertTrue(registry.getMarket(0).active);
        assertEq(keccak256(abi.encode(registry.getMarket(0))), keccak256(abi.encode(before_)));

        // lookups still work while inactive
        assertEq(registry.marketIdBySlug("crwv"), 0);
        assertEq(registry.marketIdOf(address(a.market)), 0);
    }

    function _withActive(MarketRegistry.Market memory m, bool v) internal pure returns (MarketRegistry.Market memory) {
        m.active = v;
        return m;
    }

    function test_SetActive_OnlyAdmin() public {
        _registerA();
        vm.startPrank(stranger);
        bytes memory err = abi.encodeWithSelector(
            IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, registry.DEFAULT_ADMIN_ROLE()
        );
        vm.expectRevert(err);
        registry.setActive(0, false);
        vm.expectRevert(err);
        registry.setActiveBySlug("crwv", false);
        vm.stopPrank();
        assertTrue(registry.getMarket(0).active);
    }

    function test_SetActive_Unknown() public {
        vm.expectRevert(MarketRegistry.UnknownMarket.selector);
        registry.setActive(0, false);
        vm.expectRevert(MarketRegistry.UnknownMarket.selector);
        registry.setActiveBySlug("crwv", false);
    }

    // A deactivated market's addresses and slug stay reserved forever (no unregister).
    function test_Deactivated_StaysReserved() public {
        _registerA();
        registry.setActive(0, false);
        vm.expectRevert(MarketRegistry.SlugAlreadyRegistered.selector);
        registry.register("crwv", "CoreWeave", MarketRegistry.EntityType.Corporate, _c(b), 1);
        vm.expectRevert(abi.encodeWithSelector(MarketRegistry.AddressAlreadyRegistered.selector, address(a.market)));
        registry.register("crwv2", "CoreWeave", MarketRegistry.EntityType.Corporate, _c(a), 1);
    }

    function test_NoOtherMutators() public {
        // The only state-changing selectors beyond AccessControl: register, setActive, setActiveBySlug.
        // Fuzz-free structural check: after a batch of calls, entry 0 differs from its snapshot only in `active`.
        _registerA();
        bytes32 h = keccak256(abi.encode(_withActive(registry.getMarket(0), true)));
        registry.register("try", "Turkey", MarketRegistry.EntityType.Sovereign, _c(b), 1);
        registry.setActive(1, false);
        registry.setActive(0, false);
        registry.setActive(0, true);
        assertEq(keccak256(abi.encode(_withActive(registry.getMarket(0), true))), h);
    }
}

// Minimal CLOBSettlement look-alike that lies about one of usdc/yes/no.
contract StubClob {
    address public creditMarket;
    address public usdc;
    address public yesToken;
    address public noToken;

    constructor(address cm, address u, address y, address n) {
        creditMarket = cm;
        usdc = u;
        yesToken = y;
        noToken = n;
    }
}
