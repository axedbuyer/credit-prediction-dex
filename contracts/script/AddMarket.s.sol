// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console} from "forge-std/console.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {MarketRegistry} from "../src/MarketRegistry.sol";
import {InsuranceFund} from "../src/InsuranceFund.sol";
import {MarketScriptBase} from "./MarketScriptBase.sol";

// Adds one market to an existing multi-market deployment: deploys YES-<TICKER>/NO-<TICKER>,
// CreditMarket, CLOBSettlement, OracleRouter and a LiquidationEngine pointed at the SHARED
// InsuranceFund (no new fund), does every role grant Deploy.s.sol does, sets the guard-rails
// and fee routing, registers the set in MarketRegistry, runs the full post-broadcast
// assertions, then writes markets/<slug>.json.
//
// The DEPLOYER_PRIVATE_KEY must be admin of both the shared InsuranceFund (to grant the new
// engine's LIQUIDATOR_ROLE) and the MarketRegistry — checked BEFORE anything is broadcast.
//
// Env (required): DEPLOYER_PRIVATE_KEY, MARKET_SLUG, ENTITY_NAME, ENTITY_TYPE (corporate|
//   sovereign), TOKEN_TICKER, INITIAL_MARK (1e18-scaled integer, e.g. 100000000000000000
//   for 10%).
// Env (optional, defaults = Deploy.s.sol): KEEPER_ADDRESS, PAUSER_ADDRESS,
//   ORACLE_ATTESTER_ADDRESS, TEAM_WALLET, DEPOSIT_CAP (50_000e6), MAX_MARK_STEP (0.05e18),
//   MIN_MARK_INTERVAL (1h), DEPLOYMENTS_DIR (deployments/base-sepolia; core.json is read
//   from here).
contract AddMarket is MarketScriptBase {
    using stdJson for string;

    function run() external {
        _startBlock = block.number; // before any contract of this market exists
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        _deployer = vm.addr(deployerKey);
        _readDeploymentsDir();

        _slug = vm.envString("MARKET_SLUG");
        _entityName = vm.envString("ENTITY_NAME");
        _entityType = vm.envString("ENTITY_TYPE");
        _ticker = vm.envString("TOKEN_TICKER");
        _initialMark = vm.envUint("INITIAL_MARK");
        require(bytes(_ticker).length > 0, "TOKEN_TICKER empty");
        _entityTypeEnum(); // validates ENTITY_TYPE early
        _readOpsEnv();

        string memory core = vm.readFile(string.concat(_deploymentsDir, "/core.json"));
        _usdc = core.readAddress(".usdc");
        _insuranceFund = core.readAddress(".insuranceFund");
        _registry = core.readAddress(".marketRegistry");

        console.log("=== Add market ===");
        console.log("Slug         :", _slug);
        console.log("Entity       :", _entityName, _entityType);
        console.log("Ticker       :", _ticker);
        console.log("Initial mark :", _initialMark);
        console.log("Deployer     :", _deployer);
        console.log("Registry     :", _registry);
        console.log("InsuranceFund:", _insuranceFund, "(shared)");
        console.log("Keeper       :", _keeperAddress);
        console.log("Pauser       :", _pauserAddress);
        console.log("Oracle       :", _oracleAttester);
        console.log("DepositCap   :", _depositCap);

        _preflight();

        vm.startBroadcast(deployerKey);
        _deployAndWireMarket();
        MarketRegistry(_registry).register(_slug, _entityName, _entityTypeEnum(), _contracts(), uint64(_startBlock));
        vm.stopBroadcast();

        _logMarket();
        _assertConfiguration(true);
        _writeMarketJson();
    }

    // Fail before broadcasting anything that would half-deploy.
    function _preflight() internal view {
        MarketRegistry registry = MarketRegistry(_registry);
        InsuranceFund fund = InsuranceFund(_insuranceFund);
        require(registry.usdc() == _usdc, "preflight: registry usdc != core usdc");
        require(registry.insuranceFund() == _insuranceFund, "preflight: registry insuranceFund != core insuranceFund");
        require(
            registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), _deployer), "preflight: deployer is not registry admin"
        );
        require(
            fund.hasRole(fund.DEFAULT_ADMIN_ROLE(), _deployer),
            "preflight: deployer is not InsuranceFund admin (cannot grant LIQUIDATOR_ROLE)"
        );
        try registry.marketIdBySlug(_slug) returns (uint256) {
            revert("preflight: slug already registered");
        } catch {}
    }
}
