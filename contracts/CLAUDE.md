# Contracts Context

Parent spec: see root CLAUDE.md

## Stack
- Solidity 0.8.24, Foundry, OpenZeppelin v5
- Chain: Base (chainId 8453), testnet: Base Sepolia (chainId 84532)

## File layout
src/CreditMarket.sol      — main contract
src/YESToken.sol          — ERC-20, transfer restricted to CLOB_ROLE
src/NOToken.sol           — ERC-20, transfer restricted to CLOB_ROLE
src/CLOBSettlement.sol    — EIP-712 order settlement
src/OracleRouter.sol      — credit event trigger
src/InsuranceFund.sol     — USDC reserve with timelock

## Invariant
YES.totalSupply() × currentMark + NO.totalSupply() × (1 − currentMark)
must always equal USDC balance of CreditMarket. Never break this.

## Do not build
MarketFactory, LiquidityVault, ISDARelayer, BondModule