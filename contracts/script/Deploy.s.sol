// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {YESToken} from "../src/YESToken.sol";
import {NOToken} from "../src/NOToken.sol";
import {CreditMarket} from "../src/CreditMarket.sol";
import {CLOBSettlement} from "../src/CLOBSettlement.sol";
import {OracleRouter} from "../src/OracleRouter.sol";
import {InsuranceFund} from "../src/InsuranceFund.sol";

contract Deploy is Script {
    using stdJson for string;

    // Circle's USDC on Base Sepolia
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    // 23% initial mark — team-set reference to MSTR CDS spread
    uint256 constant INITIAL_MARK = 0.23e18;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address deployer    = vm.addr(deployerKey);

        // Override USDC address for local-fork testing; falls back to Base Sepolia address.
        address usdc = vm.envOr("USDC_ADDRESS", BASE_SEPOLIA_USDC);

        console.log("=== Credit Prediction DEX Deployment ===");
        console.log("Deployer :", deployer);
        console.log("USDC     :", usdc);
        console.log("ChainId  :", block.chainid);

        vm.startBroadcast(deployerKey);

        // ── 1. token contracts ────────────────────────────────────────────────
        YESToken yesToken = new YESToken(deployer);
        NOToken  noToken  = new NOToken(deployer);

        // ── 2. core market ────────────────────────────────────────────────────
        CreditMarket market = new CreditMarket(
            deployer, usdc, address(yesToken), address(noToken), INITIAL_MARK
        );

        // ── 3. CLOB settlement ────────────────────────────────────────────────
        CLOBSettlement clob = new CLOBSettlement(address(market));

        // ── 4. oracle router ──────────────────────────────────────────────────
        OracleRouter oracleRouter = new OracleRouter(deployer, address(market));

        // ── 5. insurance fund ─────────────────────────────────────────────────
        InsuranceFund insuranceFund = new InsuranceFund(deployer, usdc);

        // ── 6. role grants ────────────────────────────────────────────────────

        // CreditMarket can mint and burn YES/NO tokens
        yesToken.grantRole(yesToken.MINTER_ROLE(), address(market));
        yesToken.grantRole(yesToken.BURNER_ROLE(), address(market));
        noToken.grantRole(noToken.MINTER_ROLE(),   address(market));
        noToken.grantRole(noToken.BURNER_ROLE(),   address(market));

        // CLOBSettlement can transfer restricted tokens and call syncUserFunding
        yesToken.grantRole(yesToken.CLOB_ROLE(), address(clob));
        noToken.grantRole(noToken.CLOB_ROLE(),   address(clob));
        market.grantRole(market.CLOB_ROLE(), address(clob));

        // OracleRouter can trigger a credit event on CreditMarket
        market.grantRole(market.ORACLE_ROLE(), address(oracleRouter));

        vm.stopBroadcast();

        // ── 7. log & persist ──────────────────────────────────────────────────
        console.log("YESToken      :", address(yesToken));
        console.log("NOToken       :", address(noToken));
        console.log("CreditMarket  :", address(market));
        console.log("CLOBSettlement:", address(clob));
        console.log("OracleRouter  :", address(oracleRouter));
        console.log("InsuranceFund :", address(insuranceFund));
        console.log("=== Roles granted ===");

        _writeDeployment(
            deployer, usdc,
            address(yesToken), address(noToken), address(market),
            address(clob), address(oracleRouter), address(insuranceFund)
        );
    }

    function _writeDeployment(
        address deployer,
        address usdc,
        address yesToken,
        address noToken,
        address market,
        address clob,
        address oracleRouter,
        address insuranceFund
    ) internal {
        // Ensure the output directory exists.
        vm.createDir("deployments", true);

        string memory obj = "deployment";
        vm.serializeAddress(obj, "deployer",       deployer);
        vm.serializeAddress(obj, "usdc",           usdc);
        vm.serializeAddress(obj, "yesToken",       yesToken);
        vm.serializeAddress(obj, "noToken",        noToken);
        vm.serializeAddress(obj, "clobSettlement", clob);
        vm.serializeAddress(obj, "oracleRouter",   oracleRouter);
        vm.serializeAddress(obj, "insuranceFund",  insuranceFund);
        vm.serializeUint(obj, "initialMark", INITIAL_MARK);
        vm.serializeUint(obj, "chainId",     block.chainid);
        // creditMarket is serialized last so its return is the fully-built JSON object.
        string memory json = vm.serializeAddress(obj, "creditMarket", market);

        vm.writeFile("deployments/base-sepolia.json", json);
        console.log("Deployment JSON -> deployments/base-sepolia.json");
    }
}
