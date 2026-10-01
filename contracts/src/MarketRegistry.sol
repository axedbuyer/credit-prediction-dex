// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

interface IRegCreditMarket {
    function usdc() external view returns (address);
    function yesToken() external view returns (address);
    function noToken() external view returns (address);
}

interface IRegCLOB {
    function creditMarket() external view returns (address);
    function usdc() external view returns (address);
    function yesToken() external view returns (address);
    function noToken() external view returns (address);
}

interface IRegLiquidationEngine {
    function creditMarket() external view returns (address);
    function insuranceFund() external view returns (address);
}

interface IRegOracleRouter {
    function creditMarket() external view returns (address);
}

// Admin-owned directory of per-market contract sets (slug -> CreditMarket / YES / NO /
// CLOBSettlement / OracleRouter / LiquidationEngine). Every market shares ONE USDC and
// ONE InsuranceFund (immutables here). The registry is purely a lookup layer — nothing
// in the protocol calls it, so a registry bug can never touch collateral.
//
// Entries are IMMUTABLE once registered: the only mutable bit is `active` (a UI/keeper
// listing flag, flipped by setActive). There is no unregister. register() verifies on
// chain that the six addresses form one internally consistent set pointed at this
// registry's USDC and InsuranceFund, and that no address already belongs to any market.
contract MarketRegistry is AccessControl {
    enum EntityType { Corporate, Sovereign }

    struct Market {
        string slug;
        string entityName;
        EntityType entityType;
        address creditMarket;
        address yesToken;
        address noToken;
        address clobSettlement;
        address oracleRouter;
        address liquidationEngine;
        bool active;
        uint64 registeredAt; // block.number of the register() call
        uint64 startBlock;   // caller-supplied lower bound for log scans (keeper holder-index start)
    }

    // register() input — the six contract addresses, grouped to keep the call stack shallow.
    struct MarketContracts {
        address creditMarket;
        address yesToken;
        address noToken;
        address clobSettlement;
        address oracleRouter;
        address liquidationEngine;
    }

    uint256 public constant MAX_SLUG_LENGTH = 32;

    address public immutable usdc;
    address public immutable insuranceFund;

    Market[] private _markets;
    mapping(bytes32 => uint256) private _slugToIdPlusOne;    // keccak(slug) -> marketId + 1
    mapping(address => uint256) private _addressToIdPlusOne; // any of a market's six addresses -> marketId + 1

    event MarketRegistered(
        uint256 indexed marketId,
        string slug,
        address creditMarket,
        address yesToken,
        address noToken,
        address clobSettlement,
        address oracleRouter,
        address liquidationEngine
    );
    event MarketActiveSet(uint256 indexed marketId, bool active);

    error ZeroAddress();
    error InvalidSlug();
    error SlugAlreadyRegistered();
    error EmptyEntityName();
    error AddressAlreadyRegistered(address account);
    error InconsistentMarketSet(string check);
    error UnknownMarket();
    error InvalidStartBlock();

    constructor(address admin, address _usdc, address _insuranceFund) {
        if (admin == address(0) || _usdc == address(0) || _insuranceFund == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        usdc = _usdc;
        insuranceFund = _insuranceFund;
    }

    // ─── write ──────────────────────────────────────────────────────────────────

    // Registers a market and returns its 0-based marketId. `startBlock` is a safe lower
    // bound for scanning the market's logs (the block before its first contract was
    // deployed) — it may precede registration (the legacy MSTR market is registered long
    // after it launched) but never exceed the current block.
    function register(
        string calldata slug,
        string calldata entityName,
        EntityType entityType,
        MarketContracts calldata c,
        uint64 startBlock
    ) external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 marketId) {
        _validateSlug(slug);
        bytes32 slugKey = keccak256(bytes(slug));
        if (_slugToIdPlusOne[slugKey] != 0) revert SlugAlreadyRegistered();
        if (bytes(entityName).length == 0) revert EmptyEntityName();
        if (startBlock > block.number) revert InvalidStartBlock();

        if (
            c.creditMarket == address(0) || c.yesToken == address(0) || c.noToken == address(0)
                || c.clobSettlement == address(0) || c.oracleRouter == address(0) || c.liquidationEngine == address(0)
        ) revert ZeroAddress();

        _verifyConsistency(c);

        marketId = _markets.length;
        _claimAddress(c.creditMarket, marketId);
        _claimAddress(c.yesToken, marketId);
        _claimAddress(c.noToken, marketId);
        _claimAddress(c.clobSettlement, marketId);
        _claimAddress(c.oracleRouter, marketId);
        _claimAddress(c.liquidationEngine, marketId);
        _slugToIdPlusOne[slugKey] = marketId + 1;

        _markets.push(
            Market({
                slug: slug,
                entityName: entityName,
                entityType: entityType,
                creditMarket: c.creditMarket,
                yesToken: c.yesToken,
                noToken: c.noToken,
                clobSettlement: c.clobSettlement,
                oracleRouter: c.oracleRouter,
                liquidationEngine: c.liquidationEngine,
                active: true,
                registeredAt: uint64(block.number),
                startBlock: startBlock
            })
        );

        emit MarketRegistered(
            marketId, slug, c.creditMarket, c.yesToken, c.noToken, c.clobSettlement, c.oracleRouter, c.liquidationEngine
        );
    }

    // The ONLY mutation of an existing entry.
    function setActive(uint256 marketId, bool active) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (marketId >= _markets.length) revert UnknownMarket();
        _markets[marketId].active = active;
        emit MarketActiveSet(marketId, active);
    }

    function setActiveBySlug(string calldata slug, bool active) external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 idPlusOne = _slugToIdPlusOne[keccak256(bytes(slug))];
        if (idPlusOne == 0) revert UnknownMarket();
        _markets[idPlusOne - 1].active = active;
        emit MarketActiveSet(idPlusOne - 1, active);
    }

    // ─── views ──────────────────────────────────────────────────────────────────

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function getMarket(uint256 marketId) external view returns (Market memory) {
        if (marketId >= _markets.length) revert UnknownMarket();
        return _markets[marketId];
    }

    function getMarketBySlug(string calldata slug) external view returns (Market memory) {
        return _markets[_idBySlug(slug)];
    }

    // Reverts UnknownMarket for an unregistered slug (no sentinel — 0 is a valid id).
    function marketIdBySlug(string calldata slug) external view returns (uint256) {
        return _idBySlug(slug);
    }

    // Maps any of a market's six contract addresses (CreditMarket, YES, NO, CLOB, router,
    // engine) to its marketId. Reverts UnknownMarket for an address in no market.
    function marketIdOf(address account) external view returns (uint256) {
        uint256 idPlusOne = _addressToIdPlusOne[account];
        if (idPlusOne == 0) revert UnknownMarket();
        return idPlusOne - 1;
    }

    // Non-reverting membership test for callers that want a bool.
    function isRegisteredAddress(address account) external view returns (bool) {
        return _addressToIdPlusOne[account] != 0;
    }

    function allMarkets() external view returns (Market[] memory) {
        return _markets;
    }

    // ─── internal ───────────────────────────────────────────────────────────────

    function _idBySlug(string calldata slug) internal view returns (uint256) {
        uint256 idPlusOne = _slugToIdPlusOne[keccak256(bytes(slug))];
        if (idPlusOne == 0) revert UnknownMarket();
        return idPlusOne - 1;
    }

    // 1..32 bytes of [a-z0-9-].
    function _validateSlug(string calldata slug) internal pure {
        bytes calldata b = bytes(slug);
        if (b.length == 0 || b.length > MAX_SLUG_LENGTH) revert InvalidSlug();
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 ch = b[i];
            bool ok = (ch >= 0x61 && ch <= 0x7a) || (ch >= 0x30 && ch <= 0x39) || ch == 0x2d;
            if (!ok) revert InvalidSlug();
        }
    }

    function _claimAddress(address account, uint256 marketId) internal {
        if (_addressToIdPlusOne[account] != 0) revert AddressAlreadyRegistered(account);
        _addressToIdPlusOne[account] = marketId + 1;
    }

    // The set must be wired to itself and to the registry's shared USDC / InsuranceFund.
    function _verifyConsistency(MarketContracts calldata c) internal view {
        IRegCreditMarket cm = IRegCreditMarket(c.creditMarket);
        if (cm.usdc() != usdc) revert InconsistentMarketSet("creditMarket.usdc");
        if (cm.yesToken() != c.yesToken) revert InconsistentMarketSet("creditMarket.yesToken");
        if (cm.noToken() != c.noToken) revert InconsistentMarketSet("creditMarket.noToken");

        IRegCLOB clob = IRegCLOB(c.clobSettlement);
        if (clob.creditMarket() != c.creditMarket) revert InconsistentMarketSet("clob.creditMarket");
        if (clob.usdc() != usdc) revert InconsistentMarketSet("clob.usdc");
        if (clob.yesToken() != c.yesToken) revert InconsistentMarketSet("clob.yesToken");
        if (clob.noToken() != c.noToken) revert InconsistentMarketSet("clob.noToken");

        IRegLiquidationEngine le = IRegLiquidationEngine(c.liquidationEngine);
        if (le.creditMarket() != c.creditMarket) revert InconsistentMarketSet("liquidationEngine.creditMarket");
        if (le.insuranceFund() != insuranceFund) revert InconsistentMarketSet("liquidationEngine.insuranceFund");

        if (IRegOracleRouter(c.oracleRouter).creditMarket() != c.creditMarket) {
            revert InconsistentMarketSet("oracleRouter.creditMarket");
        }
    }
}
