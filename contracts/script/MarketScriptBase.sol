// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {console} from "forge-std/console.sol";

import {YESToken} from "../src/YESToken.sol";
import {NOToken} from "../src/NOToken.sol";
import {CreditMarket} from "../src/CreditMarket.sol";
import {CLOBSettlement} from "../src/CLOBSettlement.sol";
import {OracleRouter} from "../src/OracleRouter.sol";
import {InsuranceFund} from "../src/InsuranceFund.sol";
import {LiquidationEngine} from "../src/LiquidationEngine.sol";
import {MarketRegistry} from "../src/MarketRegistry.sol";

// Shared plumbing for the multi-market scripts (DeployMarketRegistry, AddMarket): env
// parsing, the per-market deploy + wiring, the post-broadcast configuration assertions
// (everything Deploy.s.sol asserts, plus registry-entry correctness), and the deployment
// JSON writers. script/Deploy.s.sol is deliberately NOT refactored onto this — it describes
// the live MSTR set and its behaviour must not change.
//
// Deployment files (new layout; the legacy flat deployments/base-sepolia.json is untouched):
//   <DEPLOYMENTS_DIR>/core.json             {chainId, deployer, usdc, insuranceFund, marketRegistry, registryStartBlock}
//   <DEPLOYMENTS_DIR>/markets/<slug>.json   flat, same field names as the legacy file + slug/entityName/entityType/ticker
// DEPLOYMENTS_DIR defaults to deployments/base-sepolia. Files are written ONLY in a real
// broadcast (vm.isContext(ScriptBroadcast)); a dry run logs what it would write instead
// (docs/HANDOVER.md: a dry run of a redeploy script once rewrote the tracked JSON).
abstract contract MarketScriptBase is Script {
    // Same launch values as script/Deploy.s.sol.
    uint256 constant EPOCH_LENGTH = 1 days;
    uint256 constant FEE_BPS = 50;
    uint256 constant INSURANCE_SHARE_BPS = 5_000;
    uint256 constant DEFAULT_DEPOSIT_CAP = 50_000e6;
    uint256 constant DEFAULT_MAX_MARK_STEP = 0.05e18;
    uint256 constant DEFAULT_MIN_MARK_INTERVAL = 1 hours;
    address constant DEFAULT_KEEPER = 0x63F98358246D5860A5b4c85fBB7936494F4FeC54;

    // Resolved config + deployed addresses live in storage (post-broadcast helpers read
    // them without blowing the stack — same pattern as Deploy.s.sol).
    address internal _deployer;
    address internal _usdc;
    address internal _insuranceFund;
    address internal _registry;

    string internal _slug;
    string internal _entityName;
    string internal _entityType; // "corporate" | "sovereign"
    string internal _ticker;
    uint256 internal _initialMark;
    uint256 internal _startBlock;

    address internal _yesToken;
    address internal _noToken;
    address internal _market;
    address internal _clob;
    address internal _oracleRouter;
    address internal _liquidationEngine;

    address internal _keeperAddress;
    address internal _pauserAddress;
    address internal _oracleAttester;
    address internal _teamWallet;
    uint256 internal _depositCap;
    uint256 internal _maxMarkStep;
    uint256 internal _minMarkInterval;
    uint256 internal _epochLength;

    string internal _deploymentsDir;

    // ─── env ────────────────────────────────────────────────────────────────────

    function _readDeploymentsDir() internal {
        _deploymentsDir = vm.envOr("DEPLOYMENTS_DIR", string("deployments/base-sepolia"));
    }

    // Ops addresses and launch guard-rails: env-overridable, same defaults as Deploy.s.sol.
    function _readOpsEnv() internal {
        _teamWallet = vm.envOr("TEAM_WALLET", _deployer);
        _keeperAddress = vm.envOr("KEEPER_ADDRESS", DEFAULT_KEEPER);
        _pauserAddress = vm.envOr("PAUSER_ADDRESS", _deployer);
        _oracleAttester = vm.envOr("ORACLE_ATTESTER_ADDRESS", _deployer);
        _depositCap = vm.envOr("DEPOSIT_CAP", DEFAULT_DEPOSIT_CAP);
        _maxMarkStep = vm.envOr("MAX_MARK_STEP", DEFAULT_MAX_MARK_STEP);
        _minMarkInterval = vm.envOr("MIN_MARK_INTERVAL", DEFAULT_MIN_MARK_INTERVAL);
        _epochLength = EPOCH_LENGTH;
    }

    function _entityTypeEnum() internal view returns (MarketRegistry.EntityType) {
        bytes32 h = keccak256(bytes(_entityType));
        if (h == keccak256("corporate")) return MarketRegistry.EntityType.Corporate;
        if (h == keccak256("sovereign")) return MarketRegistry.EntityType.Sovereign;
        revert("ENTITY_TYPE must be corporate|sovereign");
    }

    function _contracts() internal view returns (MarketRegistry.MarketContracts memory) {
        return MarketRegistry.MarketContracts({
            creditMarket: _market,
            yesToken: _yesToken,
            noToken: _noToken,
            clobSettlement: _clob,
            oracleRouter: _oracleRouter,
            liquidationEngine: _liquidationEngine
        });
    }

    // ─── deploy + wire (call between vm.startBroadcast / vm.stopBroadcast) ───────

    // Deploys one market set against the SHARED InsuranceFund and leaves it fully
    // configured: every role grant script/Deploy.s.sol does (incl. the new engine's
    // InsuranceFund.LIQUIDATOR_ROLE — the deployer must be the fund's admin), the launch
    // guard-rails, and the fee config routing the insurance share to the shared fund.
    function _deployAndWireMarket() internal {
        YESToken yesToken = new YESToken(_deployer, string.concat("YES-", _ticker), string.concat("YES-", _ticker));
        NOToken noToken = new NOToken(_deployer, string.concat("NO-", _ticker), string.concat("NO-", _ticker));
        CreditMarket market =
            new CreditMarket(_deployer, _usdc, address(yesToken), address(noToken), _initialMark, _epochLength);
        CLOBSettlement clob = new CLOBSettlement(address(market), _deployer);
        OracleRouter oracleRouter = new OracleRouter(_deployer, address(market));
        LiquidationEngine engine = new LiquidationEngine(address(market), _insuranceFund);
        InsuranceFund insuranceFund = InsuranceFund(_insuranceFund);

        _yesToken = address(yesToken);
        _noToken = address(noToken);
        _market = address(market);
        _clob = address(clob);
        _oracleRouter = address(oracleRouter);
        _liquidationEngine = address(engine);

        yesToken.grantRole(yesToken.MINTER_ROLE(), address(market));
        yesToken.grantRole(yesToken.BURNER_ROLE(), address(market));
        noToken.grantRole(noToken.MINTER_ROLE(), address(market));
        noToken.grantRole(noToken.BURNER_ROLE(), address(market));

        yesToken.grantRole(yesToken.CLOB_ROLE(), address(clob));
        noToken.grantRole(noToken.CLOB_ROLE(), address(clob));
        market.grantRole(market.CLOB_ROLE(), address(clob));

        market.grantRole(market.ORACLE_ROLE(), address(oracleRouter));

        yesToken.grantRole(yesToken.CLOB_ROLE(), address(engine));
        market.grantRole(market.LIQUIDATOR_ROLE(), address(engine));
        insuranceFund.grantRole(insuranceFund.LIQUIDATOR_ROLE(), address(engine));

        market.grantRole(market.KEEPER_ROLE(), _keeperAddress);
        market.grantRole(market.PAUSER_ROLE(), _pauserAddress);
        oracleRouter.grantRole(oracleRouter.ORACLE_ROLE(), _oracleAttester);

        market.setDepositCap(_depositCap);
        market.setMarkBounds(_maxMarkStep, _minMarkInterval);

        clob.setFeeConfig(FEE_BPS, _teamWallet, _insuranceFund, INSURANCE_SHARE_BPS);
    }

    // ─── post-broadcast assertions ───────────────────────────────────────────────

    // Everything Deploy.s.sol asserts, against the shared InsuranceFund, plus registry
    // correctness. `checkMark`: AddMarket asserts currentMark == INITIAL_MARK; the legacy
    // MSTR market's mark has moved since launch, so DeployMarketRegistry skips it.
    function _assertConfiguration(bool checkMark) internal view {
        YESToken yesToken = YESToken(_yesToken);
        NOToken noToken = NOToken(_noToken);
        CreditMarket market = CreditMarket(_market);
        CLOBSettlement clob = CLOBSettlement(_clob);
        OracleRouter oracleRouter = OracleRouter(_oracleRouter);
        InsuranceFund insuranceFund = InsuranceFund(_insuranceFund);
        MarketRegistry registry = MarketRegistry(_registry);

        // set wiring (the registry re-checks this on register(); asserted here too so the
        // script fails on its own terms)
        require(market.usdc() == _usdc, "assert: market usdc");
        require(market.yesToken() == _yesToken, "assert: market yesToken");
        require(market.noToken() == _noToken, "assert: market noToken");
        require(clob.creditMarket() == _market, "assert: clob creditMarket");
        require(oracleRouter.creditMarket() == _market, "assert: router creditMarket");
        require(LiquidationEngine(_liquidationEngine).creditMarket() == _market, "assert: engine creditMarket");
        require(LiquidationEngine(_liquidationEngine).insuranceFund() == _insuranceFund, "assert: engine insuranceFund");
        require(insuranceFund.usdc() == _usdc, "assert: insuranceFund usdc");

        // Mint/burn wiring
        require(yesToken.hasRole(yesToken.MINTER_ROLE(), _market), "assert: YES MINTER_ROLE");
        require(yesToken.hasRole(yesToken.BURNER_ROLE(), _market), "assert: YES BURNER_ROLE");
        require(noToken.hasRole(noToken.MINTER_ROLE(), _market), "assert: NO MINTER_ROLE");
        require(noToken.hasRole(noToken.BURNER_ROLE(), _market), "assert: NO BURNER_ROLE");

        // CLOB wiring
        require(yesToken.hasRole(yesToken.CLOB_ROLE(), _clob), "assert: YES CLOB_ROLE(clob)");
        require(noToken.hasRole(noToken.CLOB_ROLE(), _clob), "assert: NO CLOB_ROLE(clob)");
        require(market.hasRole(market.CLOB_ROLE(), _clob), "assert: market CLOB_ROLE(clob)");

        // Oracle wiring
        require(market.hasRole(market.ORACLE_ROLE(), _oracleRouter), "assert: market ORACLE_ROLE(oracleRouter)");
        require(
            oracleRouter.hasRole(oracleRouter.ORACLE_ROLE(), _oracleAttester),
            "assert: oracleRouter ORACLE_ROLE(attester)"
        );

        // Liquidation wiring (incl. the SHARED InsuranceFund's role for this market's engine)
        require(yesToken.hasRole(yesToken.CLOB_ROLE(), _liquidationEngine), "assert: YES CLOB_ROLE(liqEngine)");
        require(
            market.hasRole(market.LIQUIDATOR_ROLE(), _liquidationEngine), "assert: market LIQUIDATOR_ROLE(liqEngine)"
        );
        require(
            insuranceFund.hasRole(insuranceFund.LIQUIDATOR_ROLE(), _liquidationEngine),
            "assert: insuranceFund LIQUIDATOR_ROLE(liqEngine)"
        );

        // Ops roles
        require(market.hasRole(market.KEEPER_ROLE(), _keeperAddress), "assert: KEEPER_ROLE");
        require(market.hasRole(market.PAUSER_ROLE(), _pauserAddress), "assert: PAUSER_ROLE");

        // Fee config
        require(clob.feeBps() == FEE_BPS, "assert: feeBps");
        require(clob.teamWallet() == _teamWallet, "assert: teamWallet");
        require(clob.insuranceFund() == _insuranceFund, "assert: clob insuranceFund");
        require(clob.insuranceShareBps() == INSURANCE_SHARE_BPS, "assert: insuranceShareBps");

        // Guard-rails + mark
        require(market.depositCap() == _depositCap, "assert: depositCap");
        require(market.maxMarkStep() == _maxMarkStep, "assert: maxMarkStep");
        require(market.minMarkInterval() == _minMarkInterval, "assert: minMarkInterval");
        require(market.epochLength() == _epochLength, "assert: epochLength");
        if (checkMark) require(market.currentMark() == _initialMark, "assert: currentMark");

        // Token naming — new markets only (MSTR's batch-1 tokens keep "YES"/"NO").
        if (checkMark) {
            require(
                keccak256(bytes(yesToken.symbol())) == keccak256(bytes(string.concat("YES-", _ticker))),
                "assert: YES symbol"
            );
            require(
                keccak256(bytes(noToken.symbol())) == keccak256(bytes(string.concat("NO-", _ticker))),
                "assert: NO symbol"
            );
        }

        // Registry entry correctness
        require(registry.usdc() == _usdc, "assert: registry usdc");
        require(registry.insuranceFund() == _insuranceFund, "assert: registry insuranceFund");
        uint256 id = registry.marketIdBySlug(_slug);
        require(registry.marketIdOf(_market) == id, "assert: registry marketIdOf(creditMarket)");
        require(registry.marketIdOf(_yesToken) == id, "assert: registry marketIdOf(yes)");
        require(registry.marketIdOf(_noToken) == id, "assert: registry marketIdOf(no)");
        require(registry.marketIdOf(_clob) == id, "assert: registry marketIdOf(clob)");
        require(registry.marketIdOf(_oracleRouter) == id, "assert: registry marketIdOf(router)");
        require(registry.marketIdOf(_liquidationEngine) == id, "assert: registry marketIdOf(engine)");
        MarketRegistry.Market memory m = registry.getMarket(id);
        require(keccak256(bytes(m.slug)) == keccak256(bytes(_slug)), "assert: registry slug");
        require(keccak256(bytes(m.entityName)) == keccak256(bytes(_entityName)), "assert: registry entityName");
        require(m.entityType == _entityTypeEnum(), "assert: registry entityType");
        require(m.creditMarket == _market, "assert: registry creditMarket");
        require(m.yesToken == _yesToken, "assert: registry yesToken");
        require(m.noToken == _noToken, "assert: registry noToken");
        require(m.clobSettlement == _clob, "assert: registry clobSettlement");
        require(m.oracleRouter == _oracleRouter, "assert: registry oracleRouter");
        require(m.liquidationEngine == _liquidationEngine, "assert: registry liquidationEngine");
        require(m.active, "assert: registry active");
        require(m.startBlock == uint64(_startBlock), "assert: registry startBlock");

        console.log("=== Post-broadcast configuration assertions passed ===");
    }

    // ─── deployment JSON ─────────────────────────────────────────────────────────

    function _shouldWrite() internal view returns (bool) {
        return vm.isContext(VmSafe.ForgeContext.ScriptBroadcast);
    }

    function _writeFileGuarded(string memory path, string memory json) internal {
        if (_shouldWrite()) {
            vm.createDir(_dirname(path), true);
            vm.writeFile(path, json);
            console.log("Wrote ->", path);
        } else {
            console.log("DRY RUN - would write ->", path);
            console.log(json);
        }
    }

    function _writeCoreJson(uint256 registryStartBlock) internal {
        string memory obj = "core";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "deployer", _deployer);
        vm.serializeAddress(obj, "usdc", _usdc);
        vm.serializeAddress(obj, "insuranceFund", _insuranceFund);
        vm.serializeUint(obj, "registryStartBlock", registryStartBlock);
        string memory json = vm.serializeAddress(obj, "marketRegistry", _registry);
        _writeFileGuarded(string.concat(_deploymentsDir, "/core.json"), json);
    }

    function _writeMarketJson() internal {
        string memory obj = "market";
        vm.serializeString(obj, "slug", _slug);
        vm.serializeString(obj, "entityName", _entityName);
        vm.serializeString(obj, "entityType", _entityType);
        vm.serializeString(obj, "ticker", _ticker);
        vm.serializeAddress(obj, "yesToken", _yesToken);
        vm.serializeAddress(obj, "noToken", _noToken);
        vm.serializeAddress(obj, "clobSettlement", _clob);
        vm.serializeAddress(obj, "oracleRouter", _oracleRouter);
        vm.serializeAddress(obj, "insuranceFund", _insuranceFund);
        vm.serializeAddress(obj, "liquidationEngine", _liquidationEngine);
        vm.serializeAddress(obj, "usdc", _usdc);
        vm.serializeUint(obj, "initialMark", _initialMark);
        vm.serializeUint(obj, "epochLength", _epochLength);
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeUint(obj, "startBlock", _startBlock);
        vm.serializeUint(obj, "depositCap", _depositCap);
        vm.serializeUint(obj, "maxMarkStep", _maxMarkStep);
        vm.serializeUint(obj, "minMarkInterval", _minMarkInterval);
        vm.serializeAddress(obj, "keeperAddress", _keeperAddress);
        vm.serializeAddress(obj, "pauserAddress", _pauserAddress);
        vm.serializeAddress(obj, "oracleAttester", _oracleAttester);
        vm.serializeAddress(obj, "teamWallet", _teamWallet);
        string memory json = vm.serializeAddress(obj, "creditMarket", _market);
        _writeFileGuarded(string.concat(_deploymentsDir, "/markets/", _slug, ".json"), json);
    }

    function _logMarket() internal view {
        console.log("Slug              :", _slug);
        console.log("YESToken          :", _yesToken);
        console.log("NOToken           :", _noToken);
        console.log("CreditMarket      :", _market);
        console.log("CLOBSettlement    :", _clob);
        console.log("OracleRouter      :", _oracleRouter);
        console.log("LiquidationEngine :", _liquidationEngine);
        console.log("InsuranceFund     :", _insuranceFund, "(shared)");
    }

    // Foundry's vm.createDir needs a directory, not a file path.
    function _dirname(string memory path) internal pure returns (string memory) {
        bytes memory b = bytes(path);
        uint256 lastSlash = 0;
        bool found = false;
        for (uint256 i = 0; i < b.length; i++) {
            if (b[i] == "/") {
                lastSlash = i;
                found = true;
            }
        }
        if (!found) return ".";
        bytes memory dir = new bytes(lastSlash);
        for (uint256 i = 0; i < lastSlash; i++) {
            dir[i] = b[i];
        }
        return string(dir);
    }
}
