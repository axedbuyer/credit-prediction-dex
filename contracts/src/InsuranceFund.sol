// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

contract InsuranceFund is AccessControl, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant TIMELOCK = 48 hours;

    struct PendingWithdrawal {
        uint256 amount;
        address recipient;
        uint256 initiatedAt;
        bool    executed;
    }

    address public immutable usdc;

    uint256 public nextWithdrawalId;
    mapping(uint256 => PendingWithdrawal) public pendingWithdrawals;

    event Deposited(address indexed from, uint256 amount);
    event WithdrawalInitiated(
        uint256 indexed withdrawalId,
        address indexed recipient,
        uint256 amount,
        uint256 executeAfter
    );
    event WithdrawalExecuted(
        uint256 indexed withdrawalId,
        address indexed recipient,
        uint256 amount
    );

    error TimelockNotExpired(uint256 executeAfter);
    error AlreadyExecuted();
    error InvalidWithdrawalId();

    constructor(address admin, address _usdc) {
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        usdc = _usdc;
    }

    // Anyone may deposit USDC into the reserve.
    function deposit(uint256 amount) external nonReentrant {
        IERC20(usdc).safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    // Queue a withdrawal. Returns the withdrawalId needed to execute it later.
    function initiateWithdrawal(uint256 amount, address recipient)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
        returns (uint256 withdrawalId)
    {
        withdrawalId = nextWithdrawalId++;
        pendingWithdrawals[withdrawalId] = PendingWithdrawal({
            amount:      amount,
            recipient:   recipient,
            initiatedAt: block.timestamp,
            executed:    false
        });
        emit WithdrawalInitiated(withdrawalId, recipient, amount, block.timestamp + TIMELOCK);
    }

    // Execute a queued withdrawal after the 48-hour timelock has elapsed.
    function executeWithdrawal(uint256 withdrawalId)
        external
        nonReentrant
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        PendingWithdrawal storage w = pendingWithdrawals[withdrawalId];
        if (w.initiatedAt == 0) revert InvalidWithdrawalId();
        if (w.executed) revert AlreadyExecuted();
        uint256 executeAfter = w.initiatedAt + TIMELOCK;
        if (block.timestamp < executeAfter) revert TimelockNotExpired(executeAfter);
        w.executed = true;
        IERC20(usdc).safeTransfer(w.recipient, w.amount);
        emit WithdrawalExecuted(withdrawalId, w.recipient, w.amount);
    }

    function getBalance() external view returns (uint256) {
        return IERC20(usdc).balanceOf(address(this));
    }
}
