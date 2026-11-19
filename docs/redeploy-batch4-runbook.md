# Redeploy batch 4 — runbook (Base Sepolia)

Same shape as `docs/redeploy-batch3-runbook.md`. Steps marked **OWNER** are blocked by the
auto-mode classifier for Claude (forge `--broadcast`, `railway variable set`, Redis
flushes, Railway domain changes); the owner runs them as `!` commands. Claude does
read-only checks, PRs and docs.

## Why

Two things change in batch 4.

1. **Post-event liquidation bug (batch 3).** After `confirmCreditEvent()`, `flagClaimable` /
   `claim` are NOT blocked unless a motion is open. A liquidator could seize an Upbet that is
   about to pay $1, at the stale mark. A proof-of-concept test showed the liquidator netting
   about 951 USDC per 1,000 Upbets. Regression tests: `forge test --match-test
   AfterCreditEvent` and `invariant_NoLiquidationAfterCreditEvent`. Nobody could open a
   motion on batch 3 either; the stop-gap (`GrantMotionRole.s.sol`) was broadcast at block
   60319124.
2. **Motion redesign** (`docs/design/motion-escrow-and-mark.md`, owner decisions
   2026-11-18). A motion marks the EDD and escrows post-EDD carry; it blocks nothing.
   Pay carry (`cure()`) is open to every holder, and the mark follows trades.

## What changed

Contracts:
- `CreditMarket`:
  - Motion lifecycle: `setMotionPending(true)` opens motion `k` and records the EDD index;
    `false` resolves it No; `confirmCreditEvent()` resolves it Yes (with no motion open, it
    opens and resolves one in the same call).
  - Per-address escrow (`escrowOf`): escrowed credit, post-EDD debt, refundable cash. It
    folds lazily in `settleFunding`, which is public.
  - `fundingDebt(user)` is now a view: ordinary debt plus live post-EDD debt.
  - `previewFunding` stays exact for the off-chain formulas.
  - `flagClaimable` and claims run during motions; both revert
    `CreditEventAlreadyConfirmed` after confirmation.
  - `cure()` works for any holder, also while paused, but not after confirmation.
  - `setMark` needs the new `MARK_ROLE`.
  - New events: `MotionOpened`, `MotionResolved`, `MotionRefundRecorded`.
- `LiquidationEngine.claim`: no motion check. It passes P and the InsuranceFund to
  `clearLiquidatedPosition`, which records the post-EDD part each payer covered as
  refundable.
- `OracleRouter`: `setMotionPending(bool)` (`ORACLE_ROLE`) and `openMotion()` (`ORACLE_ROLE`
  or the new open-only `MOTION_ROLE`).
- Deploy scripts:
  - mark bounds default to **50 points / 10 minutes**;
  - optional `MARK_UPDATER_ADDRESS` (gets `MARK_ROLE`; must differ from `KEEPER_ADDRESS`);
  - optional `MOTION_OPENER_ADDRESS` (gets router `MOTION_ROLE`).

Off-chain (**must ship before the flip in step 4**; tracked in the design note §8):
- DONE (branch `feat/batch4-offchain-keepers`): funding-keeper flags during motions;
  `DC_YES_HOLD` switch (funding-keeper + liquidator-bot); liquidator-bot claims during
  motions; `/claimable` no longer reports frozen during a motion (adds `motionPending`);
  `keepers/mark-updater` service; the smoke grants `MARK_ROLE` and checks a fill moves the
  mark (13/13).
- TODO: Frontend: Pay carry for every Upbet, health badge, motion banner, pending carry for
  Downbets, `/admin` (`openMotion`), docs pages.

Constructors are unchanged. CreditMarket, LiquidationEngine and OracleRouter changed, so
**every market gets a new contract set** under a **new MarketRegistry** (slugs `mstr`, `crwv`,
`try`); the shared **InsuranceFund is reused**. Seeds (23% / 10% / 2%), cap (50,000 USDC)
and fee (50 bps, 50/50) are unchanged. The mark bounds change to 50 points / 10 minutes.

Deploy first while batch-3 markets trade; downtime is steps 3–5.

## 0. Pre-flight

1. Batch-4 contracts are on `main` (PR #24, merged 2026-11-18 as `740d03d`). Broadcast from a
   clean checkout of `main` **after the `ops/batch4-prep` PR is merged** (it adds
   `archive/batch3/`, which step 3 reads). `cd contracts && forge test` → 252 pass on
   `740d03d` (checked 2026-11-18); `git status` clean (the broadcast compiles the working tree).
   **Done 2026-11-18 — fork dress rehearsal:** `DeployEmptyRegistry` + the three `AddMarket`
   runs below, broadcast to an anvil fork of Base Sepolia with `DEPLOYMENTS_DIR` pointed at a
   scratch copy, all printed `Post-broadcast configuration assertions passed`. On the fork:
   §2 checks all as expected. Lifecycle also checked:
   - mint; `openMotion()` by the opener (its `setMotionPending` reverts);
   - one day of accrual;
   - `setMark` by the mark updater only, with a second update inside 10 min reverting `MarkUpdateTooSoon`;
   - Pay carry on an unflagged position;
   - the attester closes the motion; redeem leaves no debt.
   Recipe, to repeat:
   `anvil --fork-url https://base-sepolia-rpc.publicnode.com --port 8547`, then the §1
   commands with `R=http://127.0.0.1:8547` and `DEPLOYMENTS_DIR=deployments/<scratch dir inside contracts/>`
   (foundry's fs permissions only allow paths under `contracts/`). Afterwards delete the scratch
   dir and the fork's `broadcast/*/84532/run-*.json` records, since they share the chain id with the
   real deploy.
2. Deployer `0x0D09…80f1` ETH ≥ 0.0005 (0.00116 ETH and 17.87 USDC on 2026-11-18; the re-seed in
   §5 needs USDC too). Other wallets on 2026-11-18: keeper 0.00248 ETH, settler 0.00714 ETH,
   liquidator 0.0015 ETH + 30 USDC, InsuranceFund 2.007 USDC.
3. Operator = settler `0x1a4A3796189a6aAB0E0D7fFFA111B5e90e3d98b9` (script default); if
   the settler key changed, `export OPERATOR_ADDRESS=<address>` first.
3a. New keys (owner generates; never commit them):
   - `export MARK_UPDATER_ADDRESS=<mark updater wallet>` (MARK_ROLE; not the keeper wallet);
   - optionally `export MOTION_OPENER_ADDRESS=<on-call wallet>` (router MOTION_ROLE).
   If unset, grant later with `cast send $CREDIT_MARKET "grantRole(bytes32,address)"
   $(cast keccak MARK_ROLE) <addr>` (and `MOTION_ROLE` on the router).
4. Archive the batch-3 files: **done** in the `ops/batch4-prep` PR
   (`contracts/deployments/base-sepolia/archive/batch3/`). The deploy then rewrites
   `core.json` and `markets/*.json` in place; commit those on a new `ops/batch4-deployment`
   branch for the deployment-files PR (§4.4).

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
assertions passed` (which now also checks `MARK_ROLE` / `MOTION_ROLE` when their env is set,
and the 50-point / 10-minute mark bounds). Record the new registry address and start block: **TBD**.

**Blockscout verification** (Claude can run it; one contract at a time, 20–45s apart to
avoid 429s): recipe in `docs/HANDOVER.md` (`forge verify-contract <addr> src/<F>.sol:<C>
--chain-id 84532 --verifier blockscout --verifier-url https://base-sepolia.blockscout.com/api
--constructor-args ...`), with constructor args taken from the broadcast records' CREATE
`arguments`.

## 2. On-chain sanity (no downtime)

`marketCount()` 3; per market: CLOB `hasRole(OPERATOR_ROLE(), 0x1a4A…98b9)` true, `feeBps()`
50, `insuranceFund()` = `0x1a0d…403b`, `maxMarkStep()` 0.5e18, `minMarkInterval()` 600,
`hasRole(MARK_ROLE, <mark updater>)` true and `hasRole(MARK_ROLE, <keeper>)` false; `currentCarryRate()` MSTR 0.20125 / CRWV 0.09482 /
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
   **New service `mark-updater`** (create before the flip): Root Directory `backend/keepers`,
   `RAILWAY_DOCKERFILE_PATH=Dockerfile.mark-updater`; vars `BASE_SEPOLIA_RPC_URL`,
   `MARKET_REGISTRY_ADDRESS`, `ORDER_BOOK_URL`, `MARK_UPDATER_PRIVATE_KEY` (the key whose
   address went into `MARK_UPDATER_ADDRESS`; fund it with ~0.002 ETH). Start it with
   `MARK_DRY_RUN=true` for the first hour, read its logs / `/health` (targets vs on-chain
   marks), then remove `MARK_DRY_RUN`.
4. **Merge** the deployment-files PR (new `core.json` + `markets/*.json`, frontend
   contract-addresses page, `docs/hosted-env-vars.md`, uptime fallback address) so Railway
   and Vercel rebuild. The batch-4 keepers (flag during motions), liquidator-bot, mark
   updater and frontend must be merged before or with the flip.

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
cast send $ORACLE_ROUTER "openMotion()" --rpc-url $R --private-key $ATTESTER_KEY   # OWNER
cast call $CREDIT_MARKET "motionPending()(bool)" --rpc-url $R   # true; MotionOpened(1, index) + MotionPendingSet logged
cast send $ORACLE_ROUTER "setMotionPending(bool)" false --rpc-url $R --private-key $ATTESTER_KEY   # OWNER
cast call $CREDIT_MARKET "motionPending()(bool)" --rpc-url $R   # false; MotionResolved(1, false)
```

  A test motion escrows carry for its duration and releases it on close; keep it short.

- Do NOT confirm a credit event on the live markets to test the guard; it is covered by
  `forge test --match-test AfterCreditEvent` and the invariant suites.
- `/admin` on the new registry shows Open/Close motion working with the attester wallet.
- The mark updater moves the mark on each market (MarkUpdated events, `adminOverride` false).
- Next funding-keeper tick accrues on the new markets; uptime workflow (manual run) green.

## 7. After

Update `CLAUDE.md` status (batch 4 live; registry address), `docs/HANDOVER.md`,
`docs/multi-market-cutover.md` pointer, `docs/credit-event-runbook.md` §7 (remove the
batch-3 caveat), memory. Batch-3 contracts stay paused and inactive.

## Record

TBD (date, new registry + start block, CreditMarket/OracleRouter addresses per market,
wind-down results, Redis key counts, verification status).
