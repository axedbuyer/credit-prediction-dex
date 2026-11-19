# Contracts Context

Parent spec: see root CLAUDE.md

## Stack
- Solidity 0.8.24, Foundry, OpenZeppelin v5; Solady v0.1.26 (`FixedPointMathLib.lnWad` only —
  the carry rate, see docs/carry-formula.md)
- Chain: Base (chainId 8453), testnet: Base Sepolia (chainId 84532)

## File layout
src/CreditMarket.sol      — main contract
src/YESToken.sol          — ERC-20, transfer restricted to CLOB_ROLE
src/NOToken.sol           — ERC-20, transfer restricted to CLOB_ROLE
src/CLOBSettlement.sol    — EIP-712 order settlement; batch 3: partial fills (`fillOrders`,
                            OPERATOR_ROLE only), `cancelOrders` / `setMinNonce`, `remaining`;
                            rejects pairs that aren't {USDC, this market's YES/NO}
src/OracleRouter.sol      — credit-event attestation: confirmCreditEvent + (batch 4)
                            setMotionPending forwarder (ORACLE_ROLE) and openMotion
                            (ORACLE_ROLE or the narrow MOTION_ROLE: open only)
src/InsuranceFund.sol     — USDC reserve with timelock (ONE, shared by all markets)
src/LiquidationEngine.sol — formulaic claim of flagged YES positions
src/MarketRegistry.sol    — (multi-market) slug → per-market contract set; entries immutable
                            (only `active` is mutable; register() verifies the set is wired
                            to itself and to the shared USDC/InsuranceFund)

script/Deploy.s.sol              — legacy single-set + InsuranceFund deploy (batch-1 shape, flat
                                   JSON; also what `make deploy-mainnet` runs)
script/DeployEmptyRegistry.s.sol — fresh MarketRegistry on the existing USDC + InsuranceFund
                                   (batches 2/3: then AddMarket.s.sol per market)
script/DeployMarketRegistry.s.sol — deploys MarketRegistry, registers the existing set as `mstr`
script/AddMarket.s.sol           — env-driven: deploys + wires + registers one more market
                                   against the shared InsuranceFund
script/MarketScriptBase.sol      — shared wiring/assertions/JSON writers for the two above
script/GrantMotionRole.s.sol     — HISTORICAL (batch 3, retired): granted the attester CreditMarket
                                   ORACLE_ROLE so it can open motions (batch 4 uses the router)
deployments/<net>/core.json, markets/<slug>.json — new layout, written only under --broadcast
test/helpers/MarketSetBuilder.sol — builds a wired per-market set for multi-market tests
test/MotionEscrow.t.sol          — batch-4 motion escrow scenarios (No/Yes, pay carry, claims)
test/invariant/EscrowMath.sol    — independent spec mirror of the escrow; two-world solvency

Batch 4 motion escrow (docs/design/motion-escrow-and-mark.md): CreditMarket keeps ordinary
debt in `_debt`; `fundingDebt(user)` is a VIEW (ordinary + live post-EDD debt) so CLOB and
off-chain readers are unchanged. All settlement math is `_computeSettlement` (shared by
settleFunding and previewFunding — keep it that way). `setMark` needs MARK_ROLE.

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