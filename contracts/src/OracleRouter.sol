// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

interface ICreditMarketOracle {
    function confirmCreditEvent() external;
    function setMotionPending(bool pending) external;
}

contract OracleRouter is AccessControl {
    bytes32 public constant ORACLE_ROLE = keccak256("ORACLE_ROLE");
    // Narrow role (batch 4): may only OPEN a motion — for the on-call rota now and a DC
    // monitor later. A false motion only delays Downbet carry until the attester closes
    // it; closing and confirming stay with ORACLE_ROLE (the multisig).
    bytes32 public constant MOTION_ROLE = keccak256("MOTION_ROLE");

    address public immutable creditMarket;

    event CreditEventConfirmed(address indexed by);
    event MotionPendingSet(address indexed by, bool pending);

    error ZeroAddress();
    error NotMotionOpener(address account);

    constructor(address admin, address _creditMarket) {
        if (admin == address(0) || _creditMarket == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        creditMarket = _creditMarket;
    }

    // ORACLE_ROLE on this contract forwards the attestation to CreditMarket.
    // CreditMarket enforces its own ORACLE_ROLE check (OracleRouter must hold it).
    function confirmCreditEvent() external onlyRole(ORACLE_ROLE) {
        ICreditMarketOracle(creditMarket).confirmCreditEvent();
        emit CreditEventConfirmed(msg.sender);
    }

    // Open (true) or close (false) a credit-event motion on the market. Opened when a
    // DC question is raised on the entity: it marks the EDD and escrows carry accrued
    // after it; it blocks nothing. Closed only if the DC rules No or declines the
    // question. A DC Yes goes through confirmCreditEvent.
    function setMotionPending(bool pending) external onlyRole(ORACLE_ROLE) {
        ICreditMarketOracle(creditMarket).setMotionPending(pending);
        emit MotionPendingSet(msg.sender, pending);
    }

    // Open a motion: ORACLE_ROLE or MOTION_ROLE.
    function openMotion() external {
        if (!hasRole(ORACLE_ROLE, msg.sender) && !hasRole(MOTION_ROLE, msg.sender)) {
            revert NotMotionOpener(msg.sender);
        }
        ICreditMarketOracle(creditMarket).setMotionPending(true);
        emit MotionPendingSet(msg.sender, true);
    }
}
