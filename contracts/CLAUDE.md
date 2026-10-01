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
src/InsuranceFund.sol     — USDC reserve with timelock (ONE, shared by all markets)
src/LiquidationEngine.sol — formulaic claim of flagged YES positions
src/MarketRegistry.sol    — (multi-market) slug → per-market contract set; entries immutable
                            (only `active` is mutable; register() verifies the set is wired
                            to itself and to the shared USDC/InsuranceFund)

script/Deploy.s.sol              — legacy single-market deploy (the live MSTR set; flat JSON)
script/DeployMarketRegistry.s.sol — deploys MarketRegistry, registers the existing set as `mstr`
script/AddMarket.s.sol           — env-driven: deploys + wires + registers one more market
                                   against the shared InsuranceFund
script/MarketScriptBase.sol      — shared wiring/assertions/JSON writers for the two above
deployments/<net>/core.json, markets/<slug>.json — new layout, written only under --broadcast
test/helpers/MarketSetBuilder.sol — builds a wired per-market set for multi-market tests

Multi-market: one CreditMarket/YES/NO/CLOBSettlement/OracleRouter/LiquidationEngine set
per market (script/AddMarket.s.sol), recorded in MarketRegistry. Never let one market's
contracts touch another market's collateral.

## Invariant
Per market: YES.totalSupply() == NO.totalSupply(), and the CreditMarket's USDC collateral
always backs every outstanding pair (1 USDC each) plus credited-but-unpaid NO funding.
The 10 hard invariants in root CLAUDE.md are canonical and hold per market.

## Do not build
MarketFactory (use AddMarket.s.sol + MarketRegistry), LiquidityVault, ISDARelayer, BondModule,
shared multi-market CLOBSettlement (v2)