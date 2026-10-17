# Redeploy batch 3 — runbook (Base Sepolia)

Ships partial fills + on-chain cancel (`docs/partial-fills-plan.md`, branch
`feat/partial-fills`):
- `CLOBSettlement.fillOrders(maker, makerSig, taker, takerSig, tokens)` — orders fill in
  pieces at the resting order's price; **only `OPERATOR_ROLE` (the matching-engine settler)
  may fill** (decision E).
- `cancelOrders(Order[])` and `setMinNonce(n)` — binding on-chain cancels (decision C).
- Pro-rata YES carry-debt collection per fill via the new `CreditMarket.collectDebt`
  (decision A); YES debits now round UP in collateral's favour.
- 1-Upbet minimum order, off-chain (`MIN_ORDER_TOKENS`, decision B).

CreditMarket changed, so — as in batch 2 — **every market gets a new contract set** under a
**new MarketRegistry** (same slugs `mstr`, `crwv`, `try`); the shared **InsuranceFund is
reused**. Seeds, cap (50,000 USDC), keeper bounds (≤ 5 points, ≥ 1h) and fee (50 bps, 50/50)
are unchanged.

Same order as batch 2: deploy first while the old markets trade; downtime is steps 3–5.

## 0. Pre-flight

1. `feat/partial-fills` merged to `main` by the owner; `cd contracts && forge test` green
   and `git status` clean (the broadcast compiles the working tree). Optional: the deep
   invariant profile (`FOUNDRY_PROFILE=deep forge test --match-path 'test/invariant/*'`,
   ≈2 min, 30/30 on 2026-10-16) and the anvil smoke (`scripts/smoke/run-smoke.sh`, 12/12
   incl. the new partial-fill check).
2. Deployer `0x0D09…80f1` ETH ≥ 0.0005 (batch 2 used ≈0.0002).
3. **Operator** = the hosted matching-engine settler `0x1a4A3796189a6aAB0E0D7fFFA111B5e90e3d98b9`
   (the scripts' `DEFAULT_OPERATOR`). If the settler key has changed, export
   `OPERATOR_ADDRESS=<its address>` before step 1 — a CLOB whose operator isn't the
   settler settles nothing (every fill reverts `AccessControlUnauthorizedAccount`).
4. The batch-2 deployment files are already archived in
   `contracts/deployments/base-sepolia/archive/batch2/` (copied before the deploy rewrites
   `core.json` + `markets/*.json`).

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

Each must log `Operator : 0x1a4A…98b9` and end with `Post-broadcast configuration
assertions passed` (which now include `clob OPERATOR_ROLE`). Blockscout verification as in
batch 2 (one contract at a time, with backoff).

## 2. On-chain sanity (no downtime)

`marketCount()` 3; per market: CLOB `hasRole(OPERATOR_ROLE(), 0x1a4A…98b9)` true,
`feeBps()` 50, `insuranceFund()` = `0x1a0d…403b`; `currentCarryRate()` as in batch 2
(MSTR 0.20125 / CRWV 0.09482 / TRY 0.01980); InsuranceFund `hasRole(LIQUIDATOR_ROLE,
<new engine>)`.

## 3. Wind down the batch-2 markets (downtime starts)

```bash
OLD_DEPLOYMENTS=contracts/deployments/base-sepolia/archive/batch2 \
  scripts/redeploy/batch2-wind-down.sh $R      # DEPLOYER_PRIVATE_KEY from contracts/.env
```

Redeems the deployer's pairs, pauses each batch-2 CreditMarket, deactivates it in registry
`0xF650…99A0`, revokes the old engines' InsuranceFund `LIQUIDATOR_ROLE`. Idempotent; re-run
on public-RPC nonce lag. Pairs held by other wallets (e.g. the test taker `0x3fB5…2c0C`)
stay redeemable by their owners — `redeem` is blocked while paused, so tell testers before
this step, or unpause briefly later for them. Rollback: `unpause()` + `setActive(id, true)`.

## 4. Flip (≈10 min)

1. **Vercel** (owner): `NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS = <new registry>`, saved
   before the merge that carries the new addresses.
2. **Redis** (owner — the classifier blocks the mass delete for Claude): delete `orders:*`,
   `orderbook:*`, `nonces:*` — every resting order is signed for a batch-2 CLOB's domain.
   Never `holder-index:*`. Same commands as batch-2 runbook §4.2.
3. **Railway**: `MARKET_REGISTRY_ADDRESS = <new registry>` on order-book-server,
   matching-engine, funding-keeper, liquidation-keeper, liquidator-bot. Optional:
   `MIN_ORDER_TOKENS` on order-book-server (default 1000000 = 1 Upbet).
4. **Merge** the deployment-files PR (new `core.json` + `markets/*.json`, the frontend
   contract-addresses page, `docs/hosted-env-vars.md`, uptime fallback address) →
   Railway + Vercel rebuild. The services must run the batch-3 code before the new
   registry is live: the old settler's `verifyAndSettle` doesn't exist on a batch-3 CLOB.

## 5. Re-seed (downtime ends)

```bash
cd scripts/demo && set -a && . ../../contracts/.env && set +a
for m in mstr crwv try; do ORDER_BOOK_URL=https://order-book-server-production-9bb6.up.railway.app \
  npx tsx mm-sepolia-seed.ts --market $m; done
```

## 6. Verify

- Every `/health`: registry mode, 3 markets, the new registry, no `lastError`;
  order-book-server `fee.source: chain`, 50 bps per market.
- **Partial fill:** `npx tsx sepolia-test-trade.ts --market mstr` buys 1 Upbet out of the
  best (larger) resting ask; on `GET /orderbook?market=mstr` that ask now shows `filled`
  and a smaller remaining size. Repeat for `crwv` and `try`.
- **Minimum:** a 0.5-Upbet order is rejected `400 BelowMinOrderSize`.
- **Cancel:** `npx tsx sepolia-cancel-check.ts --market <slug>` rests a 0.1¢ bid from the
  test wallet, cancels it on-chain, syncs and confirms it left the book (or, on the market
  page, "Your Open Orders" → Cancel).
- Next funding-keeper tick accrues on the new markets; uptime workflow (manual run) green.

## Record (2026-10-17)

- **Order of events:** PR #17 merged first, so the hosted services ran batch-3 code against
  the batch-2 CLOBs, which have no `fillOrders`. Nothing could settle until the flip, about
  15 min.
- **Who ran what:** the auto-mode classifier blocked Claude from the forge broadcast and
  from `railway variable set` (allowed in batch 2). The owner ran §1, §3, §4.2 and §4.3
  (with the re-seed chained on) as `!` commands. Claude did §2, PR #18 and the rest of §5–6.
- **New registry:** `0xA7bcc124aF821388886012B905Ba8cF4B79469b1` (start block 48217498).
  CreditMarkets: `mstr` `0x89e54F5e5C996174D9d2e52dbf90589b2f355d3A`, `crwv`
  `0xB6bc5e9FA166520536453FD667B79Fb705ca09b5`, `try` `0xdD1202B077b9B89253006610F80DAD23B9fDf76e`.
  §2 matched (carry 0.20125 / 0.09482 / 0.01980).
- **Wind-down:** the deployer redeemed 4 pairs per market. Each batch-2 market keeps the
  test wallet's 4 Upbets and the deployer's 4 Downbets. Collateral plus the test wallet's
  recorded carry debt covers them, except Turkey, which is 1 wei short (the batch-2
  rounding-down bug this batch fixes; the market is paused).
- **Redis:** the owner deleted 18 `orders:*`, 6 `orderbook:*` and 6 `nonces:*`; the 14
  `holder-index:*` keys were kept.
- **Re-seed:** the deployer ran out of USDC on `try`, so its ladder was seeded with
  `MM_QTY=2` (2 per level). Top the deployer up before the next seed.
- **Verify:** all five services in registry mode on the new registry.
  - `sepolia-test-trade.ts` filled 1 Upbet out of the best ask on every market (each now
    shows `filled` 1 of 4, or 1 of 2 on `try`).
  - A 0.5-Upbet order got `400 BelowMinOrderSize`.
  - `sepolia-cancel-check.ts` passed on all three markets. Its first run exposed a stale
    read from the public RPC right after the receipt; OpenOrders and the check now retry
    the sync (PR #18).
- **Not yet done:** Blockscout verification is rate-limited ("Too many requests") —
  retry one contract at a time later.

## 7. After

Update `CLAUDE.md` status (batch 3 live; registry address), `docs/HANDOVER.md`,
`docs/multi-market-cutover.md` pointer, memory. Batch-2 contracts stay paused and inactive.
