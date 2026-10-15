// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {console} from "forge-std/console.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {MarketRegistry} from "../src/MarketRegistry.sol";
import {InsuranceFund} from "../src/InsuranceFund.sol";
import {MarketScriptBase} from "./MarketScriptBase.sol";

// Batch-2 redeploy (docs/redeploy-batch2-runbook.md): deploys a fresh, EMPTY
// MarketRegistry against the SAME USDC and shared InsuranceFund as the current core.json,
// then rewrites core.json so AddMarket.s.sol registers every market (mstr included) into
// it. Unlike DeployMarketRegistry.s.sol it registers nothing: registry slugs are permanent
// and every market gets a new contract set, so the old registry can't be reused.
//
// Env: DEPLOYER_PRIVATE_KEY (becomes registry admin; must already be InsuranceFund admin so
//      the following AddMarket runs can grant LIQUIDATOR_ROLE), DEPLOYMENTS_DIR (default
//      deployments/base-sepolia; core.json is read from AND written to it).
contract DeployEmptyRegistry is MarketScriptBase {
    using stdJson for string;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        _deployer = vm.addr(deployerKey);
        _readDeploymentsDir();

        string memory core = vm.readFile(string.concat(_deploymentsDir, "/core.json"));
        _usdc = core.readAddress(".usdc");
        _insuranceFund = core.readAddress(".insuranceFund");
        address oldRegistry = core.readAddress(".marketRegistry");

        InsuranceFund fund = InsuranceFund(_insuranceFund);
        require(
            fund.hasRole(fund.DEFAULT_ADMIN_ROLE(), _deployer),
            "preflight: deployer is not InsuranceFund admin (AddMarket could not grant LIQUIDATOR_ROLE)"
        );

        console.log("=== Deploy empty MarketRegistry (batch 2) ===");
        console.log("Deployer     :", _deployer);
        console.log("USDC         :", _usdc);
        console.log("InsuranceFund:", _insuranceFund, "(shared, reused)");
        console.log("Old registry :", oldRegistry, "(superseded)");
        console.log("ChainId      :", block.chainid);

        uint256 registryStartBlock = block.number;
        vm.startBroadcast(deployerKey);
        MarketRegistry registry = new MarketRegistry(_deployer, _usdc, _insuranceFund);
        vm.stopBroadcast();
        _registry = address(registry);

        console.log("MarketRegistry    :", _registry);

        require(registry.usdc() == _usdc, "assert: registry usdc");
        require(registry.insuranceFund() == _insuranceFund, "assert: registry insuranceFund");
        require(registry.hasRole(registry.DEFAULT_ADMIN_ROLE(), _deployer), "assert: registry admin");
        require(registry.marketCount() == 0, "assert: registry empty");
        console.log("=== Post-broadcast configuration assertions passed ===");

        _writeCoreJson(registryStartBlock);
    }
}
