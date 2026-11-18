# Redeploy batch 4 — runbook (Base Sepolia)

Same shape as `docs/redeploy-batch3-runbook.md`. Steps marked **OWNER** are blocked by the
auto-mode classifier for Claude (forge `--broadcast`, `railway variable set`, Redis
flushes, Railway domain changes); the owner runs them as `!` commands. Claude does
read-only checks, PRs and docs.

## Why

Bug on batch-3 contracts: after `confirmCreditEvent()`, `flagClaimable` / `claim` are NOT
blocked unless a motion is open. A liquidator can seize an Upbet that is about to pay $1,
at the stale mark (a proof-of-concept test showed the liquidator netting about 951 USDC per
1,000 Upbets; now regression tests `forge test --match-test AfterCreditEvent` plus the
`invariant_NoLiquidationAfterCreditEvent` invariant). Also, nobody can open a motion on batch 3: only the OracleRouter
holds CreditMarket `ORACLE_ROLE`, and the router only forwards `confirmCreditEvent`.

Stop-gap until batch 4 is live: the admin grants CreditMarket `ORACLE_ROLE` to the attester
on all 3 batch-3 markets with `contracts/script/GrantMotionRole.s.sol` (env
`MARKET_REGISTRY_ADDRESS`, `ORACLE_ATTESTER_ADDRESS`; **OWNER** broadcasts). `/admin` then
offers Open/Close motion and refuses to confirm without an open motion. See
`docs/credit-event-runbook.md`.

## What changed

- `CreditMarket.flagClaimable` and `clearLiquidatedPosition` revert
  `CreditEventAlreadyConfirmed()` after confirmation (so `claim` reverts).
- `CreditMarket.setMotionPending` emits `MotionPendingSet(bool)`.
- `OracleRouter.setMotionPending(bool)` (`ORACLE_ROLE`) emits
  `MotionPendingSet(address indexed by, bool pending)`; the attester no longer needs
  CreditMarket `ORACLE_ROLE`.
- Keepers and liquidator-bot skip flag/claim when `creditEventConfirmed` or `motionPending`.
- `/admin` Open/Close motion buttons (router path; direct CreditMarket path if the wallet
  holds that role).

Constructors are unchanged, so deploy scripts are unchanged. CreditMarket and OracleRouter
changed, so **every market gets a new contract set** under a **new MarketRegistry** (slugs
`mstr`, `crwv`, `try`); the shared **InsuranceFund is reused**. Seeds (23% / 10% / 2%), cap
(50,000 USDC), keeper bounds (5 points, 1h) and fee (50 bps, 50/50) are unchanged.

Deploy first while batch-3 markets trade; downtime is steps 3–5.

## 0. Pre-flight

1. The fix branch (`fix/post-event-liquidation-guard`) merged to `main` by the owner;
   `cd contracts && forge test` green, `git status` clean (the broadcast compiles the
   working tree). Optional: deep invariant profile and `scripts/smoke/run-smoke.sh`.
2. Deployer `0x0D09…80f1` ETH ≥ 0.0005.
3. Operator = settler `0x1a4A3796189a6aAB0E0D7fFFA111B5e90e3d98b9` (script default); if
   the settler key changed, `export OPERATOR_ADDRESS=<address>` first.
4. Archive the batch-3 files: copy `contracts/deployments/base-sepolia/core.json` and
   `markets/*.json` to `contracts/deployments/base-sepolia/archive/batch3/` before the
   deploy rewrites them.

## 1. Deploy the new markets (no downtime) — OWNER

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

Each must log `Operator : 0x1a4A…98b9` and end with `Post-broadcast configuration
assertions passed`. Record the new registry address and start block: **TBD**.

**Blockscout verification** (Claude can run it; one contract at a time, 20–45s apart to
avoid 429s): recipe in `docs/HANDOVER.md` (`forge verify-contract <addr> src/<F>.sol:<C>
--chain-id 84532 --verifier blockscout --verifier-url https://base-sepolia.blockscout.com/api
--constructor-args ...`), with constructor args taken from the broadcast records' CREATE
`arguments`.

## 2. On-chain sanity (no downtime)

`marketCount()` 3; per market: CLOB `hasRole(OPERATOR_ROLE(), 0x1a4A…98b9)` true, `feeBps()`
50, `insuranceFund()` = `0x1a0d…403b`; `currentCarryRate()` MSTR 0.20125 / CRWV 0.09482 /
TRY 0.01980; InsuranceFund `hasRole(LIQUIDATOR_ROLE, <new engine>)` true.

## 3. Wind down the batch-3 markets (downtime starts) — OWNER

```bash
OLD_DEPLOYMENTS=contracts/deployments/base-sepolia/archive/batch3 \
  scripts/redeploy/batch2-wind-down.sh $R      # DEPLOYER_PRIVATE_KEY from contracts/.env
```

Redeems the deployer's pairs, pauses each batch-3 CreditMarket, deactivates it in registry
`0xA7bc…69b1` (read from the archived `core.json`), revokes the old engines' InsuranceFund
`LIQUIDATOR_ROLE`. Idempotent. Tell testers before this step: `redeem` is blocked while
paused. Rollback: `unpause()` + `setActive(id, true)`.

## 4. Flip (≈10 min) — OWNER

1. **Vercel:** `NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS = <new registry: TBD>`, saved before the
   merge that carries the new addresses.
2. **Redis:** delete `orders:*`, `orderbook:*`, `nonces:*` (every resting order is signed
   for a batch-3 CLOB domain). Never `holder-index:*`. Commands as in batch-2 runbook §4.2.
3. **Railway:** `railway variable set MARKET_REGISTRY_ADDRESS=<new registry: TBD>` on
   order-book-server, matching-engine, funding-keeper, liquidation-keeper, liquidator-bot.
   Any Railway domain change is also owner-run.
4. **Merge** the deployment-files PR (new `core.json` + `markets/*.json`, frontend
   contract-addresses page, `docs/hosted-env-vars.md`, uptime fallback address) so Railway
   and Vercel rebuild. Keepers must run the batch-4 skip logic before or with the flip.

## 5. Re-seed (downtime ends) — OWNER

Top the deployer up with USDC first (batch 3's `try` ladder was short).

```bash
cd scripts/demo && set -a && . ../../contracts/.env && set +a
for m in mstr crwv try; do ORDER_BOOK_URL=https://order-book-server-production-9bb6.up.railway.app \
  npx tsx mm-sepolia-seed.ts --market $m; done
```

## 6. Verify

- Every `/health`: registry mode, 3 markets, new registry, no `lastError`; order-book-server
  `fee.source: chain`, 50 bps per market.
- `npx tsx sepolia-test-trade.ts --market <slug>` fills on each market; a 0.5-Upbet order
  gets `400 BelowMinOrderSize`; `sepolia-cancel-check.ts` passes.
- **Router motion works, attester needs no CreditMarket role** (Claude, read-only plus one
  owner-signed pair of sends on one market):

```bash
cast call $CREDIT_MARKET "hasRole(bytes32,address)(bool)" $(cast keccak ORACLE_ROLE) $ATTESTER --rpc-url $R   # false
cast call $CREDIT_MARKET "hasRole(bytes32,address)(bool)" $(cast keccak ORACLE_ROLE) $ORACLE_ROUTER --rpc-url $R   # true
cast send $ORACLE_ROUTER "setMotionPending(bool)" true  --rpc-url $R --private-key $ATTESTER_KEY   # OWNER
cast call $CREDIT_MARKET "motionPending()(bool)" --rpc-url $R   # true; MotionPendingSet logged by both contracts
cast send $ORACLE_ROUTER "setMotionPending(bool)" false --rpc-url $R --private-key $ATTESTER_KEY   # OWNER
cast call $CREDIT_MARKET "motionPending()(bool)" --rpc-url $R   # false
```

- Do NOT confirm a credit event on the live markets to test the guard; it is covered by
  `forge test --match-test AfterCreditEvent` and the invariant suites.
- `/admin` on the new registry shows Open/Close motion working with the attester wallet.
- Next funding-keeper tick accrues on the new markets; uptime workflow (manual run) green.

## 7. After

Update `CLAUDE.md` status (batch 4 live; registry address), `docs/HANDOVER.md`,
`docs/multi-market-cutover.md` pointer, `docs/credit-event-runbook.md` §7 (remove the
batch-3 caveat), memory. Batch-3 contracts stay paused and inactive.

## Record

TBD (date, new registry + start block, CreditMarket/OracleRouter addresses per market,
wind-down results, Redis key counts, verification status).
