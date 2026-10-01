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
import {LiquidationEngine} from "../src/LiquidationEngine.sol";

// Deploys all seven contracts and leaves the system FULLY configured in one broadcast —
// roles, fee config, and the launch guard-rails (depositCap / setMark bounds). Ends by
// asserting (require) every piece of on-chain configuration it just set, so a broadcast
// that silently mis-wires something fails loudly instead of shipping a half-configured
// stack (see docs/HANDOVER.md "Ops wallets and secrets" gotcha this closes: KEEPER_ROLE /
// PAUSER_ROLE / OracleRouter's ORACLE_ROLE used to be manual post-deploy steps).
contract Deploy is Script {
    using stdJson for string;

    // Circle's USDC on Base Sepolia
    address constant BASE_SEPOLIA_USDC = 0x036CbD53842c5426634e7929541eC2318f3dCF7e;

    // 23% initial mark — team-set reference to MSTR CDS spread
    uint256 constant INITIAL_MARK = 0.23e18;

    // Same epoch length as DeployLocal.s.sol / previous deploys.
    uint256 constant EPOCH_LENGTH = 1 days;

    // Trading fee: 50 bps of min(p, 1-p) x Q, split 50/50 team wallet / insurance fund.
    uint256 constant FEE_BPS             = 50;
    uint256 constant INSURANCE_SHARE_BPS = 5_000;

    // Launch guard-rail defaults (env-overridable — see run()). depositCap is raw
    // 6-decimal USDC scale (YES/NO report decimals()==18 but every amount in the system,
    // including this cap, is 6-dec — see docs/HANDOVER.md "Non-obvious semantics").
    uint256 constant DEFAULT_DEPOSIT_CAP      = 50_000e6;   // 50k USDC
    uint256 constant DEFAULT_MAX_MARK_STEP    = 0.05e18;    // 5 percentage points per update
    uint256 constant DEFAULT_MIN_MARK_INTERVAL = 1 hours;

    // Today's live keeper EOA (docs/HANDOVER.md "Ops wallets and secrets") — the default
    // KEEPER_ADDRESS if the env var isn't set.
    address constant DEFAULT_KEEPER = 0x63F98358246D5860A5b4c85fBB7936494F4FeC54;

    // Deployed addresses + resolved config, held in storage so the post-broadcast
    // assertion/JSON-writing helpers can read them without blowing the stack (same
    // pattern as script/RedeployCLOBSettlement.s.sol).
    address internal _deployer;
    address internal _usdc;
    address internal _yesToken;
    address internal _noToken;
    address internal _market;
    address internal _clob;
    address internal _oracleRouter;
    address internal _insuranceFund;
    address internal _liquidationEngine;

    address internal _keeperAddress;
    address internal _pauserAddress;
    address internal _oracleAttester;
    address internal _teamWallet;

    uint256 internal _depositCap;
    uint256 internal _maxMarkStep;
    uint256 internal _minMarkInterval;
    uint256 internal _startBlock;
    string  internal _deploymentsOut;

    function run() external {
        // Safe lower bound for keeper HOLDER_INDEX_FROM_BLOCK — captured before any
        // contract exists this run, so it can only under- not over-count blocks to scan.
        _startBlock = block.number;

        uint256 deployerKey = vm.envUint("DEPLOYER_PRIVATE_KEY");
        _deployer            = vm.addr(deployerKey);

        // Override USDC address for local-fork testing; falls back to Base Sepolia address.
        _usdc = vm.envOr("USDC_ADDRESS", BASE_SEPOLIA_USDC);

        // Ops addresses — all env-overridable, defaults matching today's live setup
        // (docs/HANDOVER.md "Ops wallets and secrets").
        _teamWallet     = vm.envOr("TEAM_WALLET", _deployer);
        _keeperAddress  = vm.envOr("KEEPER_ADDRESS", DEFAULT_KEEPER);
        _pauserAddress  = vm.envOr("PAUSER_ADDRESS", _deployer);
        _oracleAttester = vm.envOr("ORACLE_ATTESTER_ADDRESS", _deployer);

        // Launch guard-rails — env-overridable.
        _depositCap      = vm.envOr("DEPOSIT_CAP", DEFAULT_DEPOSIT_CAP);
        _maxMarkStep     = vm.envOr("MAX_MARK_STEP", DEFAULT_MAX_MARK_STEP);
        _minMarkInterval = vm.envOr("MIN_MARK_INTERVAL", DEFAULT_MIN_MARK_INTERVAL);

        // Output path — overridable so fork rehearsals never touch the tracked file.
        _deploymentsOut = vm.envOr("DEPLOYMENTS_OUT", string("deployments/base-sepolia.json"));

        console.log("=== Credit Prediction DEX Deployment ===");
        console.log("Deployer :", _deployer);
        console.log("USDC     :", _usdc);
        console.log("ChainId  :", block.chainid);
        console.log("Keeper   :", _keeperAddress);
        console.log("Pauser   :", _pauserAddress);
        console.log("Oracle   :", _oracleAttester);

        vm.startBroadcast(deployerKey);

        // ── 1. token contracts ────────────────────────────────────────────────
        YESToken yesToken = new YESToken(_deployer, "YES", "YES");
        NOToken  noToken  = new NOToken(_deployer, "NO", "NO");

        // ── 2. core market ────────────────────────────────────────────────────
        CreditMarket market = new CreditMarket(
            _deployer, _usdc, address(yesToken), address(noToken), INITIAL_MARK, EPOCH_LENGTH
        );

        // ── 3. CLOB settlement ────────────────────────────────────────────────
        CLOBSettlement clob = new CLOBSettlement(address(market), _deployer);

        // ── 4. oracle router ──────────────────────────────────────────────────
        OracleRouter oracleRouter = new OracleRouter(_deployer, address(market));

        // ── 5. insurance fund ─────────────────────────────────────────────────
        InsuranceFund insuranceFund = new InsuranceFund(_deployer, _usdc);

        // ── 6. liquidation engine (v1b) ───────────────────────────────────────
        // Migration note: cumFundingPerNO, costBasis, claimable, and frozenFunding
        // all start at zero/false for every holder in a fresh deployment.
        // costBasis will be 0 for any position opened before this contract was
        // present — a known MVP gap; acceptable for the single-market case.
        LiquidationEngine liquidationEngine = new LiquidationEngine(
            address(market),
            address(insuranceFund)
        );

        _yesToken          = address(yesToken);
        _noToken           = address(noToken);
        _market            = address(market);
        _clob              = address(clob);
        _oracleRouter      = address(oracleRouter);
        _insuranceFund     = address(insuranceFund);
        _liquidationEngine = address(liquidationEngine);

        // ── 7. role grants ────────────────────────────────────────────────────

        // CreditMarket can mint and burn YES/NO tokens
        yesToken.grantRole(yesToken.MINTER_ROLE(), address(market));
        yesToken.grantRole(yesToken.BURNER_ROLE(), address(market));
        noToken.grantRole(noToken.MINTER_ROLE(),   address(market));
        noToken.grantRole(noToken.BURNER_ROLE(),   address(market));

        // CLOBSettlement can transfer restricted tokens and settle funding for both
        // parties of a trade (CreditMarket.settleFunding, called internally).
        yesToken.grantRole(yesToken.CLOB_ROLE(), address(clob));
        noToken.grantRole(noToken.CLOB_ROLE(),   address(clob));
        market.grantRole(market.CLOB_ROLE(), address(clob));

        // OracleRouter can trigger a credit event on CreditMarket
        market.grantRole(market.ORACLE_ROLE(), address(oracleRouter));

        // LiquidationEngine: CLOB_ROLE for forced YES transfer; LIQUIDATOR_ROLE
        // on CreditMarket and InsuranceFund for claim settlement
        yesToken.grantRole(yesToken.CLOB_ROLE(),                  address(liquidationEngine));
        market.grantRole(market.LIQUIDATOR_ROLE(),                 address(liquidationEngine));
        insuranceFund.grantRole(insuranceFund.LIQUIDATOR_ROLE(),   address(liquidationEngine));

        // KEEPER_ROLE / PAUSER_ROLE on CreditMarket, and ORACLE_ROLE on OracleRouter
        // itself (for whoever attests credit events) — previously manual post-deploy
        // steps (docs/deploy-testnet.md §2); granted here so one broadcast leaves the
        // system fully wired.
        market.grantRole(market.KEEPER_ROLE(), _keeperAddress);
        market.grantRole(market.PAUSER_ROLE(), _pauserAddress);
        oracleRouter.grantRole(oracleRouter.ORACLE_ROLE(), _oracleAttester);

        // ── 8. launch guard-rails ─────────────────────────────────────────────
        market.setDepositCap(_depositCap);
        market.setMarkBounds(_maxMarkStep, _minMarkInterval);

        // ── 9. trading fee ────────────────────────────────────────────────────
        // TEAM_WALLET defaults to the deployer; admin-editable later via setFeeConfig.
        clob.setFeeConfig(FEE_BPS, _teamWallet, address(insuranceFund), INSURANCE_SHARE_BPS);
        console.log("Fee config: 50 bps, team wallet", _teamWallet);

        vm.stopBroadcast();

        // ── 10. log ───────────────────────────────────────────────────────────
        console.log("YESToken          :", address(yesToken));
        console.log("NOToken           :", address(noToken));
        console.log("CreditMarket      :", address(market));
        console.log("CLOBSettlement    :", address(clob));
        console.log("OracleRouter      :", address(oracleRouter));
        console.log("InsuranceFund     :", address(insuranceFund));
        console.log("LiquidationEngine :", address(liquidationEngine));
        console.log("=== Roles granted ===");
        console.log("DepositCap        :", _depositCap);
        console.log("MaxMarkStep       :", _maxMarkStep);
        console.log("MinMarkInterval   :", _minMarkInterval);

        // ── 11. assert the on-chain config this broadcast just set ──────────────
        // A broadcast that silently mis-configures (wrong role, wrong fee split, a
        // guard-rail that didn't stick) must fail loudly here rather than ship.
        _assertConfiguration();

        // ── 12. persist ──────────────────────────────────────────────────────
        _writeDeployment();
    }

    function _assertConfiguration() internal view {
        YESToken        yesToken      = YESToken(_yesToken);
        NOToken         noToken       = NOToken(_noToken);
        CreditMarket    market        = CreditMarket(_market);
        CLOBSettlement  clob          = CLOBSettlement(_clob);
        OracleRouter    oracleRouter  = OracleRouter(_oracleRouter);
        InsuranceFund   insuranceFund = InsuranceFund(_insuranceFund);

        // Mint/burn wiring
        require(yesToken.hasRole(yesToken.MINTER_ROLE(), _market), "assert: YES MINTER_ROLE");
        require(yesToken.hasRole(yesToken.BURNER_ROLE(), _market), "assert: YES BURNER_ROLE");
        require(noToken.hasRole(noToken.MINTER_ROLE(), _market),   "assert: NO MINTER_ROLE");
        require(noToken.hasRole(noToken.BURNER_ROLE(), _market),   "assert: NO BURNER_ROLE");

        // CLOB wiring
        require(yesToken.hasRole(yesToken.CLOB_ROLE(), _clob), "assert: YES CLOB_ROLE(clob)");
        require(noToken.hasRole(noToken.CLOB_ROLE(), _clob),   "assert: NO CLOB_ROLE(clob)");
        require(market.hasRole(market.CLOB_ROLE(), _clob),     "assert: market CLOB_ROLE(clob)");

        // Oracle wiring
        require(market.hasRole(market.ORACLE_ROLE(), _oracleRouter), "assert: market ORACLE_ROLE(oracleRouter)");
        require(oracleRouter.hasRole(oracleRouter.ORACLE_ROLE(), _oracleAttester), "assert: oracleRouter ORACLE_ROLE(attester)");

        // Liquidation wiring
        require(yesToken.hasRole(yesToken.CLOB_ROLE(), _liquidationEngine), "assert: YES CLOB_ROLE(liqEngine)");
        require(market.hasRole(market.LIQUIDATOR_ROLE(), _liquidationEngine), "assert: market LIQUIDATOR_ROLE(liqEngine)");
        require(insuranceFund.hasRole(insuranceFund.LIQUIDATOR_ROLE(), _liquidationEngine), "assert: insuranceFund LIQUIDATOR_ROLE(liqEngine)");

        // Ops roles previously granted by hand
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
        require(market.currentMark() == INITIAL_MARK, "assert: currentMark");

        console.log("=== Post-broadcast configuration assertions passed ===");
    }

    function _writeDeployment() internal {
        // Ensure the output directory exists (createDir is a no-op if it already does).
        vm.createDir(_dirname(_deploymentsOut), true);

        string memory obj = "deployment";
        vm.serializeAddress(obj, "deployer",           _deployer);
        vm.serializeAddress(obj, "usdc",               _usdc);
        vm.serializeAddress(obj, "yesToken",           _yesToken);
        vm.serializeAddress(obj, "noToken",            _noToken);
        vm.serializeAddress(obj, "clobSettlement",     _clob);
        vm.serializeAddress(obj, "oracleRouter",       _oracleRouter);
        vm.serializeAddress(obj, "insuranceFund",      _insuranceFund);
        vm.serializeAddress(obj, "liquidationEngine",  _liquidationEngine);
        vm.serializeUint(obj, "initialMark",  INITIAL_MARK);
        vm.serializeUint(obj, "epochLength",  EPOCH_LENGTH);
        vm.serializeUint(obj, "chainId",      block.chainid);
        vm.serializeUint(obj, "startBlock",   _startBlock);
        vm.serializeUint(obj, "depositCap",      _depositCap);
        vm.serializeUint(obj, "maxMarkStep",     _maxMarkStep);
        vm.serializeUint(obj, "minMarkInterval", _minMarkInterval);
        vm.serializeAddress(obj, "keeperAddress",  _keeperAddress);
        vm.serializeAddress(obj, "pauserAddress",  _pauserAddress);
        vm.serializeAddress(obj, "oracleAttester", _oracleAttester);
        vm.serializeAddress(obj, "teamWallet",     _teamWallet);
        // creditMarket is serialized last so its return is the fully-built JSON object.
        string memory json = vm.serializeAddress(obj, "creditMarket", _market);

        vm.writeFile(_deploymentsOut, json);
        console.log("Deployment JSON -> ", _deploymentsOut);
    }

    // Foundry's vm.createDir needs a directory, not a file path — strip the last
    // path segment (falls back to "." for a bare filename with no directory).
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
