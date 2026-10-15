# Redeploy batch 2 — runbook (Base Sepolia)

Ships the carry-formula change (`docs/carry-formula.md`, PR #12): carry = −(1 − m)·ln(1 − m)
a year instead of m, so the price is exactly the 12-month default probability. CreditMarket
changed, so **every market gets a new contract set** (CreditMarket, YES/NO, CLOB, OracleRouter,
LiquidationEngine). Registry slugs are permanent, so a **new MarketRegistry** holds the new
sets under the same slugs (`mstr`, `crwv`, `try`). The shared **InsuranceFund is reused**.

Seeds unchanged (MSTR 23%, CRWV 10%, TRY 2% — placeholders until ISDA marks). Launch
config unchanged: cap 50,000 USDC, keeper step ≤ 5 points ≥ 1h apart, fee 50 bps 50/50.
MSTR's tokens are now `YES-MSTR` / `NO-MSTR` like the other markets (cosmetic).

Code: PR #12 (contracts, merged), PR #13 (frontend + docs, **draft — merge in step 4**),
this PR (`DeployEmptyRegistry.s.sol`, `scripts/redeploy/batch2-wind-down.sh`, the batch-1
archive, then the new deployment files).

## Order (differs from batch 1)

Deploy the new contracts **first**, while the old markets keep trading; then wind down and
flip. Trading downtime is only steps 3–5 (≈15 min).

## Rehearsal evidence (2026-10-15)

Anvil fork of Base Sepolia (block ≈48,134,340), from `main` at `0e32c03` plus this PR:
`DeployEmptyRegistry` + 3 × `AddMarket` all printed `Post-broadcast configuration assertions
passed`. On the fork: `marketCount` 3; carry rates MSTR 0.20125 / CRWV 0.09482 / TRY 0.01980
(= `carryRateFor` of 23/10/2%); fee 50 bps; cap 50,000 USDC; tokens `YES-<TICKER>`; every
new engine holds InsuranceFund `LIQUIDATOR_ROLE`. A 1 USDC mint on new MSTR owed exactly
0.201250 USDC after a 1-year warp. Wind-down script: redeemed 8 pairs per market, paused,
deactivated, revoked the old engines' role; a re-run changed nothing (idempotent). ≈73 txs,
≈27M gas (≈0.0003 ETH at 0.01 gwei; deployer holds 0.0016 ETH).

## 0. Pre-flight

1. `cd contracts && forge test` green; `git status` clean on this branch (the broadcast
   compiles the working tree).
2. Deployer `0x0D09…80f1` ETH ≥ 0.0005; it is admin of the shared InsuranceFund and the old
   registry (checked by the scripts' preflights).
3. Old-market state (2026-10-15): MSTR 12 pairs (deployer 8 YES + 12 NO; the batch-1
   throwaway test wallet `0xb611…8C12` holds 4 YES, key lost), CRWV 8 and TRY 8 pairs (all
   deployer's). InsuranceFund 2.0024 USDC.
4. **Owner-only steps:** Vercel env (step 4.1) and retargeting PR #13's base to `main`
   (it was stacked on `feat/carry-formula`; the GitHub MCP has no "edit base" tool).

## 1. Deploy the new markets (no downtime)

```bash
cd contracts && export PATH=$HOME/.foundry/bin:$PATH && set -a && . ./.env && set +a
R=$BASE_SEPOLIA_RPC_URL   # or https://sepolia.base.org
forge script script/DeployEmptyRegistry.s.sol --rpc-url $R --broadcast --slow
MARKET_SLUG=mstr ENTITY_NAME=MicroStrategy ENTITY_TYPE=corporate TOKEN_TICKER=MSTR INITIAL_MARK=230000000000000000 \
  forge script script/AddMarket.s.sol --rpc-url $R --broadcast --slow
MARKET_SLUG=crwv ENTITY_NAME=CoreWeave ENTITY_TYPE=corporate TOKEN_TICKER=CRWV INITIAL_MARK=100000000000000000 \
  forge script script/AddMarket.s.sol --rpc-url $R --broadcast --slow
MARKET_SLUG=try ENTITY_NAME=Turkey ENTITY_TYPE=sovereign TOKEN_TICKER=TRY INITIAL_MARK=20000000000000000 \
  forge script script/AddMarket.s.sol --rpc-url $R --broadcast --slow
```

Each must end with `Post-broadcast configuration assertions passed`. They rewrite
`deployments/base-sepolia/core.json` + `markets/{mstr,crwv,try}.json` (batch 1 is archived
in `deployments/base-sepolia/archive/batch1/`). The legacy flat `deployments/base-sepolia.json`
stays as-is (legacy-mode fallback only). If a run dies part-way, nothing live references
the new contracts: fix and re-run that step (a half-registered slug needs a fresh registry).

**Done 2026-10-15** (all four runs printed the assertions line): registry
`0xF650221216c76Bb775cd42211aFcb7a3c99f99A0` (start block 48140921); CreditMarkets `mstr`
`0x7AF29bd2fE6CF3bE904A538f2e0217285A7da94c`, `crwv` `0xcD60CDe83f631A82f369BF7D6C03b91D2b25f5A0`,
`try` `0xA891D433DEcEf0d35C40f93b86057411777Ca594`; step-2 sanity matched the rehearsal
exactly. Deployer ETH 0.00163 → 0.00146.

Verify on Blockscout one contract at a time with backoff (Etherscan key is rejected):
`forge verify-contract <addr> <Contract> --verifier blockscout --verifier-url
https://base-sepolia.blockscout.com/api --constructor-args …` — registry + 3 × (YESToken,
NOToken, CreditMarket, CLOBSettlement, OracleRouter, LiquidationEngine). Status:
`/api/v2/smart-contracts/<addr>`.

## 2. On-chain sanity (no downtime)

`marketCount()` 3; per market `currentCarryRate()` as in the rehearsal, CLOB `feeBps()` 50,
`insuranceFund()` = `0x1a0d…403b`, InsuranceFund `hasRole(LIQUIDATOR_ROLE, <new engine>)`.

## 3. Wind down the old markets (downtime starts)

```bash
scripts/redeploy/batch2-wind-down.sh $R      # DEPLOYER_PRIVATE_KEY from contracts/.env
```

Redeems the deployer's pairs (≈24 USDC back), pauses each old CreditMarket, deactivates it
in the old registry, revokes the old engines' InsuranceFund `LIQUIDATOR_ROLE`. Old MSTR keeps
the throwaway wallet's 4 pairs (≈4 USDC, unreachable; its 0.0345 USDC carry debt stays on its
ledger). Public-RPC nonce lag ("replacement transaction underpriced"): just re-run.
Rollback: `unpause()` + `setActive(id, true)` on the old set.

**Done 2026-10-15** (run by the owner): 8 pairs redeemed per market, all three paused,
inactive, engine roles revoked. Old MSTR keeps 4 pairs / 3.965055 USDC collateral (4 − the
throwaway's 0.0345 debt); CRWV and TRY are empty.

## 4. Flip (≈10 min)

1. **Vercel** (owner): `NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS = <new registry>`. Must be saved
   before PR #13 merges (the merge builds production with it).
2. **Redis** (hosted): delete `orders:*`, `orderbook:*`, `nonces:*` — every resting order is
   signed for an old CLOB. Never `holder-index:*` (keyed by token address; new tokens just
   start fresh indexes from the registry's `startBlock`).
   ```bash
   U=$(railway variable list -s Redis --kv | sed -n 's/^REDIS_PUBLIC_URL=//p')   # never echo it
   for p in 'orders:*' 'orderbook:*' 'nonces:*'; do
     redis-cli -u "$U" --scan --pattern "$p" | xargs -r redis-cli -u "$U" del; done
   redis-cli -u "$U" --scan --pattern 'holder-index:*' | wc -l   # untouched
   ```
3. **Railway**: `MARKET_REGISTRY_ADDRESS = <new registry>` on order-book-server,
   matching-engine, funding-keeper, liquidation-keeper, liquidator-bot (`variable --set`
   redeploys). Per-market start blocks come from the registry.
4. **Merge** this PR (new deployment files, `docs/hosted-env-vars.md`, uptime fallback
   address) and PR #13 (after retargeting it to `main`; it also carries the new addresses
   for the frontend's contract-addresses page) → Railway + Vercel rebuild.

**Done 2026-10-15:** Redis cleared by the owner (34 `orders:*`, 6 `orderbook:*`, 4
`nonces:*`; 11 `holder-index:*` kept — the auto-mode classifier blocks the delete for
Claude); Railway var set on all five, each `/health` in registry mode on the new markets.

## 5. Re-seed (downtime ends)

```bash
cd scripts/demo && set -a && . ../../contracts/.env && set +a
for m in mstr crwv try; do ORDER_BOOK_URL=https://order-book-server-production-9bb6.up.railway.app \
  npx tsx mm-sepolia-seed.ts --market $m; done
```

Mints 8 USDC of sets per market and rests a ladder around each live price. The shared
InsuranceFund keeps its 2.0024 USDC — no new deposit needed.

**Done 2026-10-15:** 8 USDC minted and 7 quotes resting per market (MSTR 20–26¢, CRWV 7–13¢,
TRY 0.5–3.5¢ on the Upbet side).

## 6. Verify

- Every `/health`: `registry.mode` `registry`, 3 markets, the new registry, no `lastError`;
  order-book-server `fee.source: chain`, 50 bps per market.
- liquidation-keeper `/health` `.markets`: new CreditMarkets, holder indexes backfilled from
  each `startBlock`.
- Frontend: home shows 3 markets with "Daily carry" below the price (e.g. MSTR 0.055%/day at
  23%); market page chart, ticker "20.1% a year"; docs carry page live.
- One small trade per market settles on-chain; next funding-keeper tick accrues on the new
  markets; uptime workflow (manual run) green.

## 7. After

Update `CLAUDE.md` status (batch 2 live; registry address), `docs/HANDOVER.md`,
`docs/multi-market-cutover.md` pointer, memory. Old contracts stay paused and inactive.
