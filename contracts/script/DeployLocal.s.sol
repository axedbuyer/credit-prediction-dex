// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {YESToken} from "../src/YESToken.sol";
import {NOToken} from "../src/NOToken.sol";
import {CreditMarket} from "../src/CreditMarket.sol";
import {CLOBSettlement} from "../src/CLOBSettlement.sol";
import {OracleRouter} from "../src/OracleRouter.sol";
import {InsuranceFund} from "../src/InsuranceFund.sol";

// Minimal 6-decimal USDC mock matching real USDC decimals.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) { return 6; }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

contract DeployLocal is Script {
    // Anvil account #0 — only used when DEPLOYER_PRIVATE_KEY is not set.
    uint256 constant ANVIL_KEY =
        0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    // 23% initial mark — team-set reference to MSTR CDS spread.
    uint256 constant INITIAL_MARK = 0.23e18;

    // How much mock USDC to mint for the deployer (100,000 USDC with 6 decimals).
    uint256 constant SEED_USDC = 100_000e6;

    function run() external {
        uint256 deployerKey = vm.envOr("DEPLOYER_PRIVATE_KEY", ANVIL_KEY);
        address deployer    = vm.addr(deployerKey);

        console.log("=== Credit Prediction DEX - Local Deployment ===");
        console.log("Deployer:", deployer);
        console.log("ChainId :", block.chainid);

        vm.startBroadcast(deployerKey);

        // ── 0. mock USDC ──────────────────────────────────────────────────────
        MockUSDC usdc = new MockUSDC();
        usdc.mint(deployer, SEED_USDC);
        console.log("MockUSDC      :", address(usdc));
        console.log("Minted", SEED_USDC / 1e6, "USDC to deployer");

        // ── 1. token contracts ────────────────────────────────────────────────
        YESToken yesToken = new YESToken(deployer);
        NOToken  noToken  = new NOToken(deployer);

        // ── 2. core market ────────────────────────────────────────────────────
        CreditMarket market = new CreditMarket(
            deployer, address(usdc), address(yesToken), address(noToken), INITIAL_MARK, 1 days
        );

        // ── 3. CLOB settlement ────────────────────────────────────────────────
        CLOBSettlement clob = new CLOBSettlement(address(market));

        // ── 4. oracle router ──────────────────────────────────────────────────
        OracleRouter oracleRouter = new OracleRouter(deployer, address(market));

        // ── 5. insurance fund ─────────────────────────────────────────────────
        InsuranceFund insuranceFund = new InsuranceFund(deployer, address(usdc));

        // ── 6. role grants ────────────────────────────────────────────────────
        yesToken.grantRole(yesToken.MINTER_ROLE(), address(market));
        yesToken.grantRole(yesToken.BURNER_ROLE(), address(market));
        noToken.grantRole(noToken.MINTER_ROLE(),   address(market));
        noToken.grantRole(noToken.BURNER_ROLE(),   address(market));

        yesToken.grantRole(yesToken.CLOB_ROLE(), address(clob));
        noToken.grantRole(noToken.CLOB_ROLE(),   address(clob));
        market.grantRole(market.CLOB_ROLE(), address(clob));

        market.grantRole(market.ORACLE_ROLE(), address(oracleRouter));

        vm.stopBroadcast();

        // ── 7. summary ────────────────────────────────────────────────────────
        console.log("YESToken      :", address(yesToken));
        console.log("NOToken       :", address(noToken));
        console.log("CreditMarket  :", address(market));
        console.log("CLOBSettlement:", address(clob));
        console.log("OracleRouter  :", address(oracleRouter));
        console.log("InsuranceFund :", address(insuranceFund));
        console.log("=== Roles granted. Local deployment complete. ===");
    }
}
