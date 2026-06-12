// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

interface ICreditMarketOracle {
    function confirmCreditEvent() external;
}

contract OracleRouter is AccessControl {
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");

    address public immutable creditMarket;

    event CreditEventConfirmed(address indexed by);

    constructor(address admin, address _creditMarket) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        creditMarket = _creditMarket;
    }

    // ORACLE_ROLE on this contract forwards the attestation to CreditMarket.
    // CreditMarket enforces its own ORACLE_ROLE check (OracleRouter must hold it).
    function confirmCreditEvent() external onlyRole(ORACLE_ROLE) {
        ICreditMarketOracle(creditMarket).confirmCreditEvent();
        emit CreditEventConfirmed(msg.sender);
    }
}
