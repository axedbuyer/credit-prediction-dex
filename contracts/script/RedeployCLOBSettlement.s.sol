// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script} from "forge-std/Script.sol";
import {console} from "forge-std/console.sol";
import {stdJson} from "forge-std/StdJson.sol";

import {YESToken} from "../src/YESToken.sol";
import {NOToken} from "../src/NOToken.sol";
import {CreditMarket} from "../src/CreditMarket.sol";
import {CLOBSettlement} from "../src/CLOBSettlement.sol";

// Redeploys CLOBSettlement against an already-deployed CreditMarket stack.
// Needed because the trading-fee change (2026-07-11) altered CLOBSettlement's
// constructor to (creditMarket, admin) and added setFeeConfig — the Base
// Sepolia deployment of 2026-07-06 predates it.
//
// Wiring performed in one broadcast:
//   grant  YESToken.CLOB_ROLE / NOToken.CLOB_ROLE / CreditMarket.CLOB_ROLE
//          → new CLOBSettlement
//   revoke the same three roles from the old CLOBSettlement (read from the
//          deployments JSON), so stale signed orders can't settle against it
//   setFeeConfig(50 bps, TEAM_WALLET or deployer, insuranceFund, 50/50 split)
//
// Migration note: nonces and the EIP-712 domain separator are per-contract —
// any orders signed against the old address are dead after this (their domain
// no longer matches a CLOB_ROLE-holding contract). Resting off-chain orders
// must be re-signed against the new address.
//
// Required env vars:
//   DEPLOYER_PRIVATE_KEY — must hold DEFAULT_ADMIN_ROLE on each contract
//   DEPLOYMENTS_FILE     — path to the existing JSON
//                          (default: deployments/base-sepolia.json)
//   TEAM_WALLET          — optional fee recipient (default: deployer)
contract RedeployCLOBSettlement is Script {
    using stdJson for string;

    uint256 constant FEE_BPS             = 50;
    uint256 constant INSURANCE_SHARE_BPS = 5_000;

    // Written in run(), consumed in _updateJson() to stay under the stack limit.
    string  internal _deploymentsFile;
    address internal _newClob;
    address internal _deployer;

    function run() external {
        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        _deployer           = vm.addr(deployerKey);
        _deploymentsFile    = vm.envOr("DEPLOYMENTS_FILE", string("deployments/base-sepolia.json"));

        string memory json        = vm.readFile(_deploymentsFile);
        address creditMarketAddr  = json.readAddress(".creditMarket");
        address yesTokenAddr      = json.readAddress(".yesToken");
        address noTokenAddr       = json.readAddress(".noToken");
        address insuranceFundAddr = json.readAddress(".insuranceFund");
        address oldClobAddr       = json.readAddress(".clobSettlement");
        address teamWallet        = vm.envOr("TEAM_WALLET", _deployer);

        console.log("=== RedeployCLOBSettlement ===");
        console.log("Deployer      :", _deployer);
        console.log("ChainId       :", block.chainid);
        console.log("CreditMarket  :", creditMarketAddr);
        console.log("Old CLOB      :", oldClobAddr);
        console.log("InsuranceFund :", insuranceFundAddr);
        console.log("Team wallet   :", teamWallet);

        vm.startBroadcast(deployerKey);

        CLOBSettlement clob = new CLOBSettlement(creditMarketAddr, _deployer);
        _newClob = address(clob);

        YESToken yesToken   = YESToken(yesTokenAddr);
        NOToken noToken     = NOToken(noTokenAddr);
        CreditMarket market = CreditMarket(creditMarketAddr);

        // New CLOB gets the settlement roles...
        yesToken.grantRole(yesToken.CLOB_ROLE(), _newClob);
        noToken.grantRole(noToken.CLOB_ROLE(),   _newClob);
        market.grantRole(market.CLOB_ROLE(),     _newClob);

        // ...and the pre-fee contract loses them. Guard: a prior dry run of this
        // script rewrites the deployments JSON, so `.clobSettlement` can already
        // hold the address the broadcast is about to deploy at (same nonce ⇒ same
        // address) — revoking then would strip the roles just granted above.
        if (oldClobAddr != _newClob) {
            yesToken.revokeRole(yesToken.CLOB_ROLE(), oldClobAddr);
            noToken.revokeRole(noToken.CLOB_ROLE(),   oldClobAddr);
            market.revokeRole(market.CLOB_ROLE(),     oldClobAddr);
        }

        clob.setFeeConfig(FEE_BPS, teamWallet, insuranceFundAddr, INSURANCE_SHARE_BPS);

        vm.stopBroadcast();

        console.log("New CLOBSettlement:", _newClob);
        console.log("Fee config: 50 bps, 50/50 team wallet / InsuranceFund");
        console.log("CLOB_ROLE granted to new CLOB, revoked from old, on YES/NO/CreditMarket");

        _updateJson(json);
    }

    // Separate stack frame keeps the overall variable count under the EVM limit.
    function _updateJson(string memory existingJson) internal {
        address creditMarketAddr  = existingJson.readAddress(".creditMarket");
        address usdcAddr          = existingJson.readAddress(".usdc");
        address yesTokenAddr      = existingJson.readAddress(".yesToken");
        address noTokenAddr       = existingJson.readAddress(".noToken");
        address oracleAddr        = existingJson.readAddress(".oracleRouter");
        address insuranceFundAddr = existingJson.readAddress(".insuranceFund");
        address liquidationAddr   = existingJson.readAddress(".liquidationEngine");
        uint256 initialMark       = existingJson.readUint(".initialMark");

        vm.createDir("deployments", true);

        string memory obj = "deployment";
        vm.serializeAddress(obj, "deployer",           _deployer);
        vm.serializeAddress(obj, "usdc",               usdcAddr);
        vm.serializeAddress(obj, "yesToken",           yesTokenAddr);
        vm.serializeAddress(obj, "noToken",            noTokenAddr);
        vm.serializeAddress(obj, "clobSettlement",     _newClob);
        vm.serializeAddress(obj, "oracleRouter",       oracleAddr);
        vm.serializeAddress(obj, "insuranceFund",      insuranceFundAddr);
        vm.serializeAddress(obj, "liquidationEngine",  liquidationAddr);
        vm.serializeUint(obj,    "initialMark",        initialMark);
        vm.serializeUint(obj,    "chainId",            block.chainid);
        string memory out = vm.serializeAddress(obj,   "creditMarket", creditMarketAddr);

        vm.writeFile(_deploymentsFile, out);
        console.log("Deployment JSON updated ->", _deploymentsFile);
    }
}
