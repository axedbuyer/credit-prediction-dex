# Hosted env vars — Railway + Vercel (Base Sepolia, post batch-1 redeploy 2026-10-01)

Single source of truth for what each hosted service needs, with the CURRENT addresses —
the full batch-1 redeploy of 2026-10-01 (`docs/redeploy-batch1-runbook.md`; deploy start
block 47528136). The 2026-07 contracts (CreditMarket `0x26C3…F51b`, CLOB `0xC317…cB8e`)
are paused and empty.
Companion to `docs/deploy-testnet.md` §3–4 (service topology) and
`docs/deploy-followups.md` (incident fixes). Secrets are marked — pull them from the
local gitignored `.env` files, never from this doc.

## Multi-market (built 2026-10-02, cutover PENDING — `docs/multi-market-cutover.md`)

Until stage C of the cutover, nothing below changes: every service runs in **legacy mode**
(one market, `mstr`, from the single-set address vars on this page). New vars:

| Var | Services | Meaning |
|---|---|---|
| `MARKET_REGISTRY_ADDRESS` | all five Railway services | Set → registry mode: markets from `MarketRegistry.allMarkets()`; the single-set address vars (`CREDIT_MARKET_ADDRESS`, `YES/NO_TOKEN_ADDRESS`, `CLOB_SETTLEMENT_ADDRESS`, `LIQUIDATION_ENGINE_ADDRESS`, `HOLDER_INDEX_FROM_BLOCK`, `TRACKED_HOLDERS`) are then ignored. `USDC_ADDRESS` stays required on order-book-server + matching-engine; liquidator-bot falls back to the registry's `usdc()` / `insuranceFund()`. |
| `REGISTRY_REFRESH_MS` | all five | Registry re-read interval, default 60000 (new markets need no redeploy). |
| `LEGACY_SWEEP_MS` | order-book-server | Legacy Redis-key sweep interval, default 30000 (0 disables the timer; boot still sweeps). |
| `CHAIN_ID` | matching-engine | Optional, default 84532 (only for local anvil). |
| `NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS` | Vercel | Set → frontend discovers markets on-chain; the `NEXT_PUBLIC_*_ADDRESS` market vars are then ignored (`NEXT_PUBLIC_USDC_ADDRESS` still used). |

**MarketRegistry: `0xdF1A5141310140edF6fDaE3cd339FD042dF15720`** (deployed 2026-10-03, stage B;
`contracts/deployments/base-sepolia/core.json`). Markets: `mstr` (batch-1 set), `crwv`
CreditMarket `0xA895a7d71f3CF6e9Ac9e6e00B86eaccc4C6F8dC0`, `try` CreditMarket
`0x3F72DA6652C4a14984a6B94BA9EB1a2782ff40Ae` — full address sets in
`contracts/deployments/base-sepolia/markets/<slug>.json`. **Set as `MARKET_REGISTRY_ADDRESS` on all
five Railway services 2026-10-03 (stage C) — they now run in registry mode;** the old
single-set address vars are still present (ignored) so rollback = delete this one var +
redeploy. Vercel `NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS`: set by the owner via the dashboard.

## Every Railway service

```
RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30
```
All four services shut down gracefully on SIGTERM (stop taking new work, let in-flight
work finish, bounded by `SHUTDOWN_TIMEOUT_MS`, default 25000). Railway sends SIGTERM to
the old deployment once the new one is live and SIGKILLs it after the draining window —
keep the window (30s) longer than `SHUTDOWN_TIMEOUT_MS`, or draining is cut short. Set on
all four services 2026-09-26.

## Shared addresses (chainId 84532)

| Key | Value |
|---|---|
| USDC_ADDRESS | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` |
| YES_TOKEN_ADDRESS | `0x9ED5A4c6B1B5334645Ec47e7ce087e281fcEC59D` |
| NO_TOKEN_ADDRESS | `0xFcFf6488677A852D724B7659649176115D5f296e` |
| CLOB_SETTLEMENT_ADDRESS | `0x8048d8CC6A8e4d0101bDD9B9251c39a65E47FA25` |
| CREDIT_MARKET_ADDRESS | `0xe8D0448Fb825875AE2CEFfEdA561Ea98508F8369` |
| ORACLE_ROUTER (frontend only) | `0xb125C4E351134c444d7c142E7bb98Cb4b72d2226` |
| LIQUIDATION_ENGINE (frontend only) | `0xd041293744b255952d760aF3594714c61697cc9E` |

## Railway — order-book-server (root dir `backend/order-book-server`, public)

```
USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
YES_TOKEN_ADDRESS=0x9ED5A4c6B1B5334645Ec47e7ce087e281fcEC59D
NO_TOKEN_ADDRESS=0xFcFf6488677A852D724B7659649176115D5f296e
CLOB_SETTLEMENT_ADDRESS=0x8048d8CC6A8e4d0101bDD9B9251c39a65E47FA25
CREDIT_MARKET_ADDRESS=0xe8D0448Fb825875AE2CEFfEdA561Ea98508F8369
CHAIN_ID=84532
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
FEE_BPS=50
REDIS_URL=${{Redis.REDIS_URL}}
CORS_ORIGINS=https://credit-prediction-dex.vercel.app,http://localhost:3000
TRUST_PROXY=2
```
Leave `PORT` unset (Railway injects it). No Dockerfile override. Health check:
`GET /health` (200 when Redis answers PING, 503 otherwise; never touches the RPC).
`FEE_BPS` is only a fallback: the live fee rate is read from `CLOBSettlement.feeBps()` and
refreshed every 60s (`FEE_REFRESH_MS`). `GET /health` → `fee.source` should say `chain`;
`env-fallback` means the RPC read failed. `CORS_ORIGINS` is an exact-match allow-list; unset/empty/`*` means wildcard `*`. Vercel
preview URLs are NOT covered — add them (or unset the var) if you test previews against
the hosted backend.

**Rate limiting:** `POST /order` + `DELETE /order/:id` share one bucket per client IP,
`ORDER_RATE_LIMIT_MAX` (default 60) per `ORDER_RATE_LIMIT_WINDOW_MS` (default 60000);
`ORDER_RATE_LIMIT_MAX=0` disables it. Reads, `/health` and preflights are never limited.
`TRUST_PROXY=2` makes the limiter key on the real client IP. A wrong value fails
silently, so it was **measured** on 2026-09-26 rather than assumed. The limiter's
`x-ratelimit-remaining` header reveals which bucket a request landed in; invalid
`POST /order` bodies are rejected with 400 but still count:
- `TRUST_PROXY=1` → remaining jumped around (58, 59, 58, 59…) for one client: it keyed
  on the right-most `X-Forwarded-For` entry, a per-request Railway edge-node address.
- `TRUST_PROXY=2` → strictly decreasing for one client, and a spoofed
  `X-Forwarded-For` doesn't escape the bucket.
- `TRUST_PROXY=3` → same as 2, which shows Railway's edge DISCARDS any client-sent
  `X-Forwarded-For` — the header arrives as `<client>, <edge node>`.
So 2 = the client IP. (Railway's HTTP log `srcIp` matched our public IP.) Not yet done:
a check from a second network (e.g. a phone hotspot) that it gets its own fresh bucket.
That would rule out a stable shared hop in front of the edge. Re-run this check after
any hosting change: probe with ~10 plain requests plus a few spoofed ones, and read the
`x-ratelimit-remaining` sequence.

## Railway — matching-engine (root dir `backend/matching-engine`, internal-only)

```
YES_TOKEN_ADDRESS=0x9ED5A4c6B1B5334645Ec47e7ce087e281fcEC59D
NO_TOKEN_ADDRESS=0xFcFf6488677A852D724B7659649176115D5f296e
USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
CLOB_SETTLEMENT_ADDRESS=0x8048d8CC6A8e4d0101bDD9B9251c39a65E47FA25
CREDIT_MARKET_ADDRESS=0xe8D0448Fb825875AE2CEFfEdA561Ea98508F8369
POLL_INTERVAL_MS=500
ORDER_BOOK_URL=http://<order-book-server private domain>:<port>   # Railway private networking
SETTLER_PRIVATE_KEY=<SECRET — backend/matching-engine/.env>
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
REDIS_URL=${{Redis.REDIS_URL}}
```
No public domain, no HTTP health check (no server in this process).

## Railway — funding-keeper (root dir `backend/keepers`, internal-only)

```
RAILWAY_DOCKERFILE_PATH=Dockerfile.funding-keeper
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
CHAIN_ID=84532
CREDIT_MARKET_ADDRESS=0xe8D0448Fb825875AE2CEFfEdA561Ea98508F8369
KEEPER_PRIVATE_KEY=<SECRET — backend/keepers/.env>
YES_TOKEN_ADDRESS=0x9ED5A4c6B1B5334645Ec47e7ce087e281fcEC59D
HOLDER_INDEX_FROM_BLOCK=47528136
REDIS_URL=${{Redis.REDIS_URL}}
HEALTH_PORT=3002
```
Health check `GET :3002/health` (includes `holderIndex` discovery status). (No CLOB
address needed.)

**Holder discovery (both keepers):** holders are discovered from YES `Transfer` events
(`backend/keepers/holder-index.ts`). `HOLDER_INDEX_FROM_BLOCK` is REQUIRED — the YES
token deploy block (47528136 on Base Sepolia, the batch-1 deploy); the keepers refuse to boot without it.
`REDIS_URL` (Railway reference to the managed Redis) persists the scan cursor + holder
set under `holder-index:84532:<yes token>:*`, shared by both keepers, so only the first
boot pays the full backfill (one `eth_getLogs` call per 1,000 blocks since the deploy
block — the public RPC's cap per call). `TRACKED_HOLDERS` (optional extra seed addresses) is no longer
set — removed from both services 2026-09-26. Optional tuning: `HOLDER_INDEX_CHUNK_SIZE` (1000), `HOLDER_INDEX_CONCURRENCY`
(4).

## Railway — liquidation-keeper (root dir `backend/keepers`, public)

```
RAILWAY_DOCKERFILE_PATH=Dockerfile.liquidation-keeper
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
CHAIN_ID=84532
CREDIT_MARKET_ADDRESS=0xe8D0448Fb825875AE2CEFfEdA561Ea98508F8369
YES_TOKEN_ADDRESS=0x9ED5A4c6B1B5334645Ec47e7ce087e281fcEC59D
HOLDER_INDEX_FROM_BLOCK=47528136
REDIS_URL=${{Redis.REDIS_URL}}
POLL_INTERVAL_MS=30000
PORT=3003
CORS_ORIGINS=https://credit-prediction-dex.vercel.app,http://localhost:3000
```
Health check `GET :3003/health`. Read-only, no private key. NOTE: the process binds
`process.env.PORT` and Railway injects its own PORT — check the actual listen log line.

## Railway — liquidator-bot (root dir `backend/keepers`, internal-only) — live since 2026-09-29

```
RAILWAY_DOCKERFILE_PATH=Dockerfile.liquidator-bot
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
CHAIN_ID=84532
LIQUIDATOR_PRIVATE_KEY=<SECRET — wallet 0x941A8B4707ccC1f9811DE3fFE7937dFe22e59661>
CREDIT_MARKET_ADDRESS=0xe8D0448Fb825875AE2CEFfEdA561Ea98508F8369
YES_TOKEN_ADDRESS=0x9ED5A4c6B1B5334645Ec47e7ce087e281fcEC59D
USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
LIQUIDATION_ENGINE_ADDRESS=0xd041293744b255952d760aF3594714c61697cc9E
INSURANCE_FUND_ADDRESS=0x1a0dB241CE7D0fd3b0C22cd45285a41D185B403b
CLOB_SETTLEMENT_ADDRESS=0x8048d8CC6A8e4d0101bDD9B9251c39a65E47FA25
ORDER_BOOK_URL=http://<order-book-server private domain>:<port>
HOLDER_INDEX_FROM_BLOCK=47528136
REDIS_URL=${{Redis.REDIS_URL}}
POLL_INTERVAL_MS=30000
RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30
```
Root Directory must be `backend/keepers` (Settings → Source; the CLI's
`environment edit … source.rootDirectory` only sticks once a source is connected).
Optional: `AUTO_SELL` (true), `SELL_MAX_DISCOUNT_BPS` (300), `SELL_ORDER_TTL_SEC` (86400),
`HEALTH_PORT` (3004). The wallet needs Base Sepolia ETH for gas and a USDC float ≥ the
largest position it may claim (a claim costs ≤ m×Q); `/health` → `skippedByReason`
shows `insufficientFloat` / `insuranceFundShortfall` when it can't claim. Update the
contract addresses here after any CreditMarket-family redeploy.

## Vercel — frontend (root dir `frontend`)

```
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=<from frontend/.env.local — required, build throws without it>
NEXT_PUBLIC_RPC_URL=https://sepolia.base.org
NEXT_PUBLIC_CREDIT_MARKET_ADDRESS=0xe8D0448Fb825875AE2CEFfEdA561Ea98508F8369
NEXT_PUBLIC_YES_TOKEN_ADDRESS=0x9ED5A4c6B1B5334645Ec47e7ce087e281fcEC59D
NEXT_PUBLIC_NO_TOKEN_ADDRESS=0xFcFf6488677A852D724B7659649176115D5f296e
NEXT_PUBLIC_CLOB_SETTLEMENT_ADDRESS=0x8048d8CC6A8e4d0101bDD9B9251c39a65E47FA25
NEXT_PUBLIC_ORACLE_ROUTER_ADDRESS=0xb125C4E351134c444d7c142E7bb98Cb4b72d2226
NEXT_PUBLIC_LIQUIDATION_ENGINE_ADDRESS=0xd041293744b255952d760aF3594714c61697cc9E
NEXT_PUBLIC_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
NEXT_PUBLIC_FEE_BPS=50
NEXT_PUBLIC_ORDER_BOOK_URL=https://<order-book-server Railway PUBLIC domain>
NEXT_PUBLIC_LIQUIDATION_KEEPER_URL=https://<liquidation-keeper Railway PUBLIC domain>
```
The two Railway public domains must exist before the Vercel deploy is useful (the app
builds without them but the market page can't load a book). `NEXT_PUBLIC_FEE_BPS` is only the preview
fallback while the live on-chain fee rate loads; Downbet buys can't be signed until it has.
