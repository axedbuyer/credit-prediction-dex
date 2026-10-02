# Backend Context

Parent spec: see root CLAUDE.md

## Stack
Node.js 20, TypeScript, Fastify, Redis, viem, node-cron

## Services
order-book-server/    — REST API for orders (Fastify + Redis), many markets
matching-engine/      — price-time priority CLOB matcher + on-chain settler, many markets
keepers/              — funding accrual cron job

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
- `GET /health` — all legacy top-level fields (`fee` = mstr's) plus `registry` (directory status) and
  `markets: { [slug]: { fee: { bps, source } } }`.
- Rate limit stays per client IP across all markets.
- Redis keys: `orderbook:<slug>:bids|asks`, `nonces:<slug>:<maker>` (on-chain `usedNonces` is per
  CLOBSettlement), `orders:<id>` global. Readers treat a missing `market` as `mstr`.
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
- Settler: one wallet for all markets; each pair goes to its market's `CLOBSettlement`. Revert
  handling (FundingShortfall / PositionFrozen / SlippageExceeded / NonceUsed) is unchanged but reads
  `claimable()` / `usedNonces()` on that market's contracts and prunes from that market's keys.
- **Defense in depth (CLOBSettlement does not validate order tokens):** before any gas estimate the
  settler requires both orders to be exactly {USDC, that market's YES or NO}, on the SAME outcome
  token, opposite sides, same market; otherwise it prunes both WITHOUT submitting and logs loudly.
  An order whose market is unknown to the settler's directory is released, not pruned.
- Optional `CHAIN_ID` (default 84532) for a local anvil node.

### Env vars added
`MARKET_REGISTRY_ADDRESS`, `REGISTRY_REFRESH_MS` (both services); `CHAIN_ID` (matching-engine);
`LEGACY_SWEEP_MS` (order-book-server).

## Do not build
Subgraph, The Graph integration, fee distributor
