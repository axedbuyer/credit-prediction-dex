// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";

import {MarketRegistry} from "../src/MarketRegistry.sol";
import {CreditMarket} from "../src/CreditMarket.sol";

// BATCH-3 STOP-GAP ONLY (docs/credit-event-runbook.md). On batch-3 contracts nobody can
// open a credit-event motion: CreditMarket.setMotionPending needs CreditMarket ORACLE_ROLE,
// held only by each market's OracleRouter, and that router forwards only
// confirmCreditEvent. This grants CreditMarket ORACLE_ROLE directly to the attester on
// every ACTIVE market in the registry so it can call setMotionPending itself.
//
// Side effect (accepted): the attester can also call CreditMarket.confirmCreditEvent
// directly, bypassing the router — the same wallet can already confirm via the router.
// Batch 4 makes this unnecessary (OracleRouter.setMotionPending); do NOT run it there.
//
// Env (all required, no defaults):
//   DEPLOYER_PRIVATE_KEY     — must hold DEFAULT_ADMIN_ROLE on every CreditMarket
//   MARKET_REGISTRY_ADDRESS  — the batch-3 registry
//   ORACLE_ATTESTER_ADDRESS  — wallet that will open/close motions
// Dry run (simulation): forge script script/GrantMotionRole.s.sol --rpc-url base_sepolia
// Broadcast (OWNER):    add --broadcast
contract GrantMotionRole is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address admin = vm.addr(deployerKey);
        MarketRegistry registry = MarketRegistry(vm.envAddress("MARKET_REGISTRY_ADDRESS"));
        address attester = vm.envAddress("ORACLE_ATTESTER_ADDRESS");
        require(attester != address(0), "ORACLE_ATTESTER_ADDRESS is zero");

        MarketRegistry.Market[] memory markets = registry.allMarkets();
        console.log("Registry:", address(registry));
        console.log("Admin   :", admin);
        console.log("Attester:", attester);

        // Preflight every market before broadcasting anything.
        uint256 toGrant;
        for (uint256 i = 0; i < markets.length; i++) {
            if (!markets[i].active) continue;
            CreditMarket m = CreditMarket(markets[i].creditMarket);
            require(m.hasRole(m.DEFAULT_ADMIN_ROLE(), admin), "preflight: deployer is not CreditMarket admin");
            require(
                m.hasRole(m.ORACLE_ROLE(), markets[i].oracleRouter), "preflight: router lacks ORACLE_ROLE (not batch 3?)"
            );
            require(!m.creditEventConfirmed(), "preflight: credit event already confirmed on a market");
            if (!m.hasRole(m.ORACLE_ROLE(), attester)) toGrant++;
        }
        console.log("Markets needing the grant:", toGrant);

        vm.startBroadcast(deployerKey);
        for (uint256 i = 0; i < markets.length; i++) {
            if (!markets[i].active) continue;
            CreditMarket m = CreditMarket(markets[i].creditMarket);
            if (m.hasRole(m.ORACLE_ROLE(), attester)) {
                console.log("already granted:", markets[i].slug);
                continue;
            }
            m.grantRole(m.ORACLE_ROLE(), attester);
            console.log("granted        :", markets[i].slug, markets[i].creditMarket);
        }
        vm.stopBroadcast();

        for (uint256 i = 0; i < markets.length; i++) {
            if (!markets[i].active) continue;
            CreditMarket m = CreditMarket(markets[i].creditMarket);
            require(m.hasRole(m.ORACLE_ROLE(), attester), "assert: attester ORACLE_ROLE");
            require(m.hasRole(m.ORACLE_ROLE(), markets[i].oracleRouter), "assert: router keeps ORACLE_ROLE");
        }
        console.log("=== Post-broadcast assertions passed ===");
    }
}
