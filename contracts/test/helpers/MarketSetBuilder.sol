// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {YESToken} from "../../src/YESToken.sol";
import {NOToken} from "../../src/NOToken.sol";
import {CreditMarket} from "../../src/CreditMarket.sol";
import {CLOBSettlement} from "../../src/CLOBSettlement.sol";
import {OracleRouter} from "../../src/OracleRouter.sol";
import {LiquidationEngine} from "../../src/LiquidationEngine.sol";
import {InsuranceFund} from "../../src/InsuranceFund.sol";

// Test helper: builds one fully wired per-market contract set (same wiring as
// script/AddMarket.s.sol) against a SHARED USDC + InsuranceFund. The calling contract
// becomes admin of everything, so call it from the test contract itself.
library MarketSetBuilder {
    struct MarketSet {
        YESToken yes;
        NOToken no;
        CreditMarket market;
        CLOBSettlement clob;
        OracleRouter router;
        LiquidationEngine engine;
    }

    function build(
        address usdc,
        InsuranceFund insuranceFund,
        string memory yesSymbol,
        string memory noSymbol,
        uint256 initialMark
    ) internal returns (MarketSet memory s) {
        address admin = address(this);
        s.yes = new YESToken(admin, yesSymbol, yesSymbol);
        s.no = new NOToken(admin, noSymbol, noSymbol);
        s.market = new CreditMarket(admin, usdc, address(s.yes), address(s.no), initialMark, 1 days);
        s.clob = new CLOBSettlement(address(s.market), admin);
        s.router = new OracleRouter(admin, address(s.market));
        s.engine = new LiquidationEngine(address(s.market), address(insuranceFund));

        s.yes.grantRole(s.yes.MINTER_ROLE(), address(s.market));
        s.yes.grantRole(s.yes.BURNER_ROLE(), address(s.market));
        s.no.grantRole(s.no.MINTER_ROLE(), address(s.market));
        s.no.grantRole(s.no.BURNER_ROLE(), address(s.market));
        s.yes.grantRole(s.yes.CLOB_ROLE(), address(s.clob));
        s.no.grantRole(s.no.CLOB_ROLE(), address(s.clob));
        s.market.grantRole(s.market.CLOB_ROLE(), address(s.clob));
        s.market.grantRole(s.market.ORACLE_ROLE(), address(s.router));
        s.yes.grantRole(s.yes.CLOB_ROLE(), address(s.engine));
        s.market.grantRole(s.market.LIQUIDATOR_ROLE(), address(s.engine));
        insuranceFund.grantRole(insuranceFund.LIQUIDATOR_ROLE(), address(s.engine));
    }
}
