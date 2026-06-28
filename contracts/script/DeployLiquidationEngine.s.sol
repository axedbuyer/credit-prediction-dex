// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {YESToken} from "../src/YESToken.sol";
import {CreditMarket} from "../src/CreditMarket.sol";
import {InsuranceFund} from "../src/InsuranceFund.sol";
import {LiquidationEngine} from "../src/LiquidationEngine.sol";

// Deploys LiquidationEngine against an already-deployed CreditMarket stack and
// wires the three required roles:
//   YESToken.CLOB_ROLE           → LiquidationEngine  (forcedTransfer for seizures)
//   CreditMarket.LIQUIDATOR_ROLE → LiquidationEngine  (clearLiquidatedPosition)
//   InsuranceFund.LIQUIDATOR_ROLE → LiquidationEngine (coverShortfall, tail-case)
//
// Migration note: CreditMarket is not UUPS-upgradeable — cumFundingPerNO,
// costBasis, claimable, and frozenFunding all default to zero/false for every
// existing holder. In particular costBasis is 0 for positions opened before
// this deployment; a known MVP gap, acceptable for the single-market case where
// the holder set is small enough to backfill manually if needed.
//
// Required env vars:
//   DEPLOYER_PRIVATE_KEY — must hold DEFAULT_ADMIN_ROLE on each contract
//   DEPLOYMENTS_FILE     — path to the existing JSON
//                          (default: deployments/base-sepolia.json)
contract DeployLiquidationEngine is Script {
    using stdJson for string;

    // Written in run(), consumed in _updateJson() to stay under the stack limit.
    string  internal _deploymentsFile;
    address internal _liquidationEngine;
    address internal _deployer;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        _deployer           = vm.addr(deployerKey);
        _deploymentsFile    = vm.envOr("DEPLOYMENTS_FILE", string("deployments/base-sepolia.json"));

        string memory json        = vm.readFile(_deploymentsFile);
        address creditMarketAddr  = json.readAddress(".creditMarket");
        address yesTokenAddr      = json.readAddress(".yesToken");
        address insuranceFundAddr = json.readAddress(".insuranceFund");

        console.log("=== DeployLiquidationEngine ===");
        console.log("Deployer      :", _deployer);
        console.log("ChainId       :", block.chainid);
        console.log("CreditMarket  :", creditMarketAddr);
        console.log("YESToken      :", yesTokenAddr);
        console.log("InsuranceFund :", insuranceFundAddr);

        vm.startBroadcast(deployerKey);

        LiquidationEngine engine = new LiquidationEngine(creditMarketAddr, insuranceFundAddr);
        _liquidationEngine = address(engine);

        // 1. YESToken.CLOB_ROLE — needed for forcedTransfer (seizure token move)
        YESToken(yesTokenAddr).grantRole(
            YESToken(yesTokenAddr).CLOB_ROLE(), _liquidationEngine
        );
        // 2. CreditMarket.LIQUIDATOR_ROLE — needed for clearLiquidatedPosition
        CreditMarket(creditMarketAddr).grantRole(
            CreditMarket(creditMarketAddr).LIQUIDATOR_ROLE(), _liquidationEngine
        );
        // 3. InsuranceFund.LIQUIDATOR_ROLE — needed for coverShortfall (tail-case top-up)
        InsuranceFund(insuranceFundAddr).grantRole(
            InsuranceFund(insuranceFundAddr).LIQUIDATOR_ROLE(), _liquidationEngine
        );

        vm.stopBroadcast();

        console.log("LiquidationEngine :", _liquidationEngine);
        console.log("Roles granted:");
        console.log("  YESToken.CLOB_ROLE           -> LiquidationEngine");
        console.log("  CreditMarket.LIQUIDATOR_ROLE -> LiquidationEngine");
        console.log("  InsuranceFund.LIQUIDATOR_ROLE -> LiquidationEngine");

        _updateJson(json);
    }

    // Separate stack frame keeps the overall variable count under the EVM limit.
    function _updateJson(string memory existingJson) internal {
        address creditMarketAddr  = existingJson.readAddress(".creditMarket");
        address usdcAddr          = existingJson.readAddress(".usdc");
        address yesTokenAddr      = existingJson.readAddress(".yesToken");
        address noTokenAddr       = existingJson.readAddress(".noToken");
        address clobAddr          = existingJson.readAddress(".clobSettlement");
        address oracleAddr        = existingJson.readAddress(".oracleRouter");
        address insuranceFundAddr = existingJson.readAddress(".insuranceFund");
        uint256 initialMark       = existingJson.readUint(".initialMark");

        vm.createDir("deployments", true);

        string memory obj = "deployment";
        vm.serializeAddress(obj, "deployer",           _deployer);
        vm.serializeAddress(obj, "usdc",               usdcAddr);
        vm.serializeAddress(obj, "yesToken",           yesTokenAddr);
        vm.serializeAddress(obj, "noToken",            noTokenAddr);
        vm.serializeAddress(obj, "clobSettlement",     clobAddr);
        vm.serializeAddress(obj, "oracleRouter",       oracleAddr);
        vm.serializeAddress(obj, "insuranceFund",      insuranceFundAddr);
        vm.serializeAddress(obj, "liquidationEngine",  _liquidationEngine);
        vm.serializeUint(obj,    "initialMark",        initialMark);
        vm.serializeUint(obj,    "chainId",            block.chainid);
        string memory out = vm.serializeAddress(obj,   "creditMarket", creditMarketAddr);

        vm.writeFile(_deploymentsFile, out);
        console.log("Deployment JSON updated ->", _deploymentsFile);
    }
}
