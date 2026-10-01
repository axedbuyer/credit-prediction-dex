// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console} from "forge-std/console.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {MarketRegistry} from "../src/MarketRegistry.sol";
import {MarketScriptBase} from "./MarketScriptBase.sol";

// Phase 1 of the multi-market rollout: deploys MarketRegistry(admin, usdc, insuranceFund)
// and registers the EXISTING single-market deployment (the legacy flat JSON, read-only) as
// slug `mstr` — no redeploy of any market contract. Then writes the new-layout files
// (core.json + markets/mstr.json) so all markets share one layout; the legacy file stays
// untouched (off-chain services keep reading it until phase 2).
//
// Env: DEPLOYER_PRIVATE_KEY (must be the shared InsuranceFund's admin only for AddMarket,
//      here it just becomes the registry admin), LEGACY_DEPLOYMENT (default
//      deployments/base-sepolia.json), DEPLOYMENTS_DIR (default deployments/base-sepolia).
contract DeployMarketRegistry is MarketScriptBase {
    using stdJson for string;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        _deployer = vm.addr(deployerKey);
        _readDeploymentsDir();

        string memory legacyPath = vm.envOr("LEGACY_DEPLOYMENT", string("deployments/base-sepolia.json"));
        string memory j = vm.readFile(legacyPath); // read-only; never written back

        _usdc = j.readAddress(".usdc");
        _insuranceFund = j.readAddress(".insuranceFund");
        _market = j.readAddress(".creditMarket");
        _yesToken = j.readAddress(".yesToken");
        _noToken = j.readAddress(".noToken");
        _clob = j.readAddress(".clobSettlement");
        _oracleRouter = j.readAddress(".oracleRouter");
        _liquidationEngine = j.readAddress(".liquidationEngine");
        _initialMark = j.readUint(".initialMark");
        _epochLength = j.readUint(".epochLength");
        _depositCap = j.readUint(".depositCap");
        _maxMarkStep = j.readUint(".maxMarkStep");
        _minMarkInterval = j.readUint(".minMarkInterval");
        _keeperAddress = j.readAddress(".keeperAddress");
        _pauserAddress = j.readAddress(".pauserAddress");
        _oracleAttester = j.readAddress(".oracleAttester");
        _teamWallet = j.readAddress(".teamWallet");
        _startBlock = j.readUint(".startBlock");

        _slug = "mstr";
        _entityName = "MicroStrategy";
        _entityType = "corporate";
        _ticker = "MSTR";

        uint256 registryStartBlock = block.number;

        console.log("=== Deploy MarketRegistry + register legacy MSTR market ===");
        console.log("Deployer     :", _deployer);
        console.log("Legacy file  :", legacyPath);
        console.log("USDC         :", _usdc);
        console.log("InsuranceFund:", _insuranceFund);
        console.log("ChainId      :", block.chainid);

        vm.startBroadcast(deployerKey);
        MarketRegistry registry = new MarketRegistry(_deployer, _usdc, _insuranceFund);
        _registry = address(registry);
        registry.register(_slug, _entityName, _entityTypeEnum(), _contracts(), uint64(_startBlock));
        vm.stopBroadcast();

        console.log("MarketRegistry    :", _registry);
        _logMarket();

        // The legacy MSTR market's mark has moved since launch, so don't pin currentMark.
        _assertConfiguration(false);

        _writeCoreJson(registryStartBlock);
        _writeMarketJson();
    }
}
