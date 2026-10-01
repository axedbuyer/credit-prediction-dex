// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {stdJson} from "forge-std/StdJson.sol";

// Reads deployments/base-sepolia.json and runs forge verify-contract for each contract.
// Requires: ETHERSCAN_API_KEY env var, ffi = true in foundry.toml.
// Usage: forge script script/VerifyContracts.s.sol --rpc-url base_sepolia
contract VerifyContracts is Script {
    using stdJson for string;

    string constant DEPLOYMENT_PATH = "deployments/base-sepolia.json";
    string constant CHAIN           = "base-sepolia";

    function run() external {
        string memory json     = vm.readFile(DEPLOYMENT_PATH);
        string memory apiKey   = vm.envString("ETHERSCAN_API_KEY");

        address deployer         = json.readAddress(".deployer");
        address usdc             = json.readAddress(".usdc");
        address yesToken         = json.readAddress(".yesToken");
        address noToken          = json.readAddress(".noToken");
        address market           = json.readAddress(".creditMarket");
        address clob             = json.readAddress(".clobSettlement");
        address oracleRouter     = json.readAddress(".oracleRouter");
        address insuranceFund    = json.readAddress(".insuranceFund");
        address liquidationEngine = json.readAddress(".liquidationEngine");
        uint256 initialMark      = json.readUint(".initialMark");
        // epochLength was added to the deployments JSON alongside this fix — a fresh
        // Deploy.s.sol run always writes it; readUint reverts on an older JSON missing
        // the key, which is the correct failure mode (re-run Deploy first).
        uint256 epochLength      = json.readUint(".epochLength");

        console.log("=== Verifying Credit Prediction DEX on", CHAIN, "===");

        _verify(
            yesToken,
            "src/YESToken.sol:YESToken",
            abi.encode(deployer),
            apiKey
        );
        _verify(
            noToken,
            "src/NOToken.sol:NOToken",
            abi.encode(deployer),
            apiKey
        );
        _verify(
            market,
            "src/CreditMarket.sol:CreditMarket",
            // NOTE: CreditMarket's constructor takes 6 args (admin, usdc, yesToken,
            // noToken, initialMark, epochLength) — this used to encode only 5, which
            // silently failed verification (bytecode/constructor-arg mismatch) since
            // epochLength was added. Fixed here; not a constructor change from
            // a9476ea, a pre-existing gap this pass caught while checking constructor
            // args for the fresh redeploy.
            abi.encode(deployer, usdc, yesToken, noToken, initialMark, epochLength),
            apiKey
        );
        _verify(
            clob,
            "src/CLOBSettlement.sol:CLOBSettlement",
            abi.encode(market),
            apiKey
        );
        _verify(
            oracleRouter,
            "src/OracleRouter.sol:OracleRouter",
            abi.encode(deployer, market),
            apiKey
        );
        _verify(
            insuranceFund,
            "src/InsuranceFund.sol:InsuranceFund",
            abi.encode(deployer, usdc),
            apiKey
        );
        // Previously a documented gap (docs/deploy-testnet.md §1a): LiquidationEngine
        // was deployed but never verified by this script, only via a manual command.
        _verify(
            liquidationEngine,
            "src/LiquidationEngine.sol:LiquidationEngine",
            abi.encode(market, insuranceFund),
            apiKey
        );

        console.log("=== Verification requests submitted ===");
    }

    // Shells out to `forge verify-contract` with ABI-encoded constructor args.
    function _verify(
        address contractAddr,
        string memory contractPath,
        bytes memory constructorArgs,
        string memory apiKey
    ) internal {
        console.log("Verifying", contractPath, "@", vm.toString(contractAddr));

        string[] memory cmd = new string[](10);
        cmd[0] = "forge";
        cmd[1] = "verify-contract";
        cmd[2] = vm.toString(contractAddr);
        cmd[3] = contractPath;
        cmd[4] = "--chain";
        cmd[5] = CHAIN;
        cmd[6] = "--constructor-args";
        cmd[7] = vm.toString(constructorArgs); // 0x-prefixed ABI encoding
        cmd[8] = "--etherscan-api-key";
        cmd[9] = apiKey;

        vm.ffi(cmd);
        console.log("  submitted");
    }
}
