// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

contract YESToken is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");
    bytes32 public constant CLOB_ROLE = keccak256("CLOB_ROLE");

    error TransferRestricted();

    constructor(address admin) ERC20("YES", "YES") {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }

    function burn(address from, uint256 amount) external onlyRole(BURNER_ROLE) {
        _burn(from, amount);
    }

    // Transfer without approval — only callable by CLOB_ROLE (e.g., LiquidationEngine
    // seizing a flagged position without holder consent).
    function forcedTransfer(address from, address to, uint256 amount) external onlyRole(CLOB_ROLE) {
        _transfer(from, to, amount);
    }

    // Only mints (from==0), burns (to==0), or CLOB_ROLE callers may move tokens.
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0) && !hasRole(CLOB_ROLE, msg.sender)) {
            revert TransferRestricted();
        }
        super._update(from, to, value);
    }
}
