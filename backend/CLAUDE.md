# Backend Context

Parent spec: see root CLAUDE.md

## Stack
Node.js 20, TypeScript, Fastify, Redis, viem, node-cron (keepers)

## Services
order-book-server/    — REST API for orders (Fastify + Redis), many markets
matching-engine/      — price-time priority CLOB matcher + on-chain settler, many markets
keepers/              — funding-keeper.ts (accrual + seizure flagging), liquidation-keeper.ts
                        (GET /claimable), liquidator-bot.ts (+ clob-seller.ts: claims and
                        resells flagged positions), holder-index.ts (YES holder discovery),
                        mark-updater.ts (batch 4: moves each mark to follow trading),
                        credit-event-hold.ts (the DC_YES_HOLD switch)
shared/               — canonical registry.ts (copied into each service by sync-registry.sh)

## Multi-market (order-book-server + matching-engine)

Both services read a `MarketDirectory` (`src/registry.ts`, an identical copy per service of
`backend/shared/registry.ts` — edit the canonical file, run `backend/shared/sync-registry.sh`;
CI fails on drift).

- **Registry mode**: `MARKET_REGISTRY_ADDRESS` set (needs `BASE_SEPOLIA_RPC_URL`). Markets come from
  `MarketRegistry.allMarkets()`, refreshed every `REGISTRY_REFRESH_MS` (default 60000; a failed
  refresh keeps the last good list). New markets are picked up with no redeploy.
- **Legacy mode**: `MARKET_REGISTRY_ADDRESS` unset. Exactly one market, `mstr`, built from the
  single-set env vars (`YES_TOKEN_ADDRESS`, `NO_TOKEN_ADDRESS`, `CREDIT_MARKET_ADDRESS`,
  `CLOB_SETTLEMENT_ADDRESS`) — behaves exactly as before multi-market.

### order-book-server
- `GET /markets` → `{ mode, markets: [{ slug, entityName, entityType, active, creditMarket, yesToken,
  noToken, clobSettlement, oracleRouter, liquidationEngine, startBlock }] }` (never rate-limited).
- `GET /orderbook?market=<slug>` → `{ bids, asks }` for that market; no param = `mstr` (back-compat);
  unknown slug → `404 UnknownMarket`.
- `POST /order` — body unchanged. The market is DERIVED from the order's non-USDC token
  (`directory.byAddress`), never trusted from the client. Checked before signature/chain work:
  exactly one leg USDC and the other that market's YES/NO else `400 InvalidTokenPair`; token in no
  market → `400 UnknownMarket`; market deactivated → `400 MarketInactive`. The EIP-712 signature is
  verified against THAT market's `clobSettlement` domain; price derivation (NO-bid fee netting),
  fee rate (live `CLOBSettlement.feeBps()` per market, own refresh) and the chain pre-filter all use
  that market's contracts. Response: `{ orderId, market }`; stored order JSON carries `market`.
- `DELETE /order/:id` — unchanged API; verified against the stored order's market domain.
  Off-chain only — the binding cancel is on-chain (`cancelOrders` / `setMinNonce`).
- `POST /order` rejects orders under `MIN_ORDER_TOKENS` (default 1_000_000 = 1 Upbet/Downbet;
  bid size = `minAmountOut`, ask size = `amountIn`) with `400 {error:'BelowMinOrderSize',
  minOrderTokens}`. The YES-sell FundingShortfall pre-filter is pro-rata: required =
  ceil(D × amountIn / yesBalance) (all of D when selling the whole balance) + fee.
- `POST /orders/sync {market, maker}` — re-reads `CLOBSettlement.remaining()` for each of that
  maker's orders in the market and deletes those at 0 (cancelled / setMinNonce'd / spent /
  filled on-chain). No signature: removal follows objective chain state only; a failed read
  removes nothing (`{removed, unreadable}`); 503 without chain reads.
- Stored orders carry `filled` (outcome tokens filled so far, written by the matching engine);
  remaining = size − filled. Fully filled orders are deleted.
- `GET /health` — all legacy top-level fields (`fee` = mstr's) plus `registry` (directory status) and
  `markets: { [slug]: { fee: { bps, source } } }`.
- Rate limit stays per client IP across all markets.
- Redis keys: `orderbook:<slug>:bids|asks`, `nonces:<slug>:<maker>` (an order is unique per
  maker + nonce on each CLOBSettlement), `orders:<id>` global. Readers treat a missing `market` as `mstr`.
- Legacy-key SWEEP (`src/migration.ts`): on boot and every `LEGACY_SWEEP_MS` (default 30000; 0
  disables) moves legacy `orderbook:bids|asks` ids into `orderbook:mstr:*`, stamps `market:'mstr'`
  on the order JSON, and UNIONs `nonces:<maker>` into `nonces:mstr:<maker>`. It is recurring because
  Railway overlaps old and new deployments: the old instance keeps writing legacy keys for a while
  after the new one starts, and a one-shot migration would strand those orders. Idempotent and
  crash-safe, `SET NX EX` lock for replicas, safe with a running matching-engine. A no-op sweep is
  a single EXISTS (nonce SCAN only on boot and every 10th tick) and writes nothing; a sweep that
  moves anything logs `swept legacy keys: N order(s)...`. `migrations:multimarket-v1` is only an
  informational marker now. Cutover rollout: just deploy; watch Railway logs for the sweep lines
  during the overlap window, and they stop once the old instance is gone.

### matching-engine
- Each poll fetches `GET /orderbook?market=<slug>` for every ACTIVE market and matches each book
  independently (price-time priority unchanged). Orders from different markets are never crossed.
  Batch 3 partial fills: `matched` is emitted as (maker, taker, tokens) — the EARLIER order is the
  maker, tokens = min of both `remainingTokens()` (size − filled); one fill per order per cycle.
- Settler: one wallet for all markets (it must hold each CLOB's `OPERATOR_ROLE`); each fill goes
  to its market's `CLOBSettlement.fillOrders`. On success `filled` is written back
  (`OrderRemover.setFilled`, Redis `SET … XX`) or the order is removed once full. Revert handling
  (reads on that market's contracts, prunes from that market's keys): FundingShortfall /
  PositionFrozen prune ONLY the order whose own state caused the revert; FillExceedsRemaining /
  OrderInvalidated / OrderExpired / InvalidOrder read `remaining()` — 0 prunes, otherwise `filled`
  is resynced; SlippageExceeded / FillTooSmall never prune (`engine.markIncompatible`, 10-min TTL,
  both released); a failed or ambiguous chain read releases both for retry. Root CLAUDE.md "Order
  removal policy".
- **Defense in depth** (since batch 3 `fillOrders` also rejects bad pairs on-chain): before any gas estimate the
  settler requires both orders to be exactly {USDC, that market's YES or NO}, on the SAME outcome
  token, opposite sides, same market; otherwise it prunes both WITHOUT submitting and logs loudly.
  An order whose market is unknown to the settler's directory is released, not pruned.
- Optional `CHAIN_ID` (default 84532) for a local anvil node.

### keepers — batch 4 (motion escrow, trade-following mark)
- A motion blocks nothing: funding-keeper flags and liquidator-bot claims during it (the bot
  logs an `[ALERT]` when it has claims in a market with a motion open). Both stop for good
  once `creditEventConfirmed()` (the contracts revert too).
- `DC_YES_HOLD` (funding-keeper + liquidator-bot): comma-separated slugs, or `*`. Set it on
  both services the moment the DC announces Yes on a covered event, before the confirm tx
  lands; Railway redeploys them (~1–2 min) and neither flags or claims at boot. Shown as
  `dcYesHold` on `/health`. Remove after confirmation.
- `/claimable` positions carry `motionPending`; `frozen` means `claim()` would revert.
- `mark-updater.ts` (Dockerfile.mark-updater, own Railway service, `HEALTH_PORT` 3005):
  `MARK_UPDATER_PRIVATE_KEY` (holds `MARK_ROLE`; never the keeper key), `ORDER_BOOK_URL`,
  registry env as the other keepers. Tuning: `MARK_POLL_MS` (60000),
  `MARK_TWAP_WINDOW_SEC` (3600), `MARK_MIN_FILLS` (2), `MARK_MIN_FILL_TOKENS` (1),
  `MARK_MIN_FILL_VOLUME` (50), `MARK_BOOK_MIN_DEPTH` (100 tokens per side),
  `MARK_BOOK_MAX_SPREAD` (0.10), `MARK_DEADBAND` (0.0025), `MARK_MIN`/`MARK_MAX`
  (0.001 / 0.95), `MARK_STALE_ALERT_SEC` (21600), `MARK_DRY_RUN`, `MARK_MIN_ETH`,
  `BLOCK_TIME_SEC` (2), `LOG_CHUNK_BLOCKS` (200 — sepolia.base.org caps `eth_getLogs` at 200 blocks). Without the key or the role it computes,
  logs and serves `/health` but sends nothing (so it is safe against batch 3).

### Env vars added
`MARKET_REGISTRY_ADDRESS`, `REGISTRY_REFRESH_MS` (both services); `CHAIN_ID` (matching-engine);
`LEGACY_SWEEP_MS`, `MIN_ORDER_TOKENS` (order-book-server).

## Do not build
Subgraph, The Graph integration, fee distributor
