# Hosted env vars — Railway + Vercel (Base Sepolia, post fee-redeploy 2026-07-12)

Single source of truth for what each hosted service needs, with the CURRENT addresses
(fee-aware CLOBSettlement `0xC317…cB8e` — the pre-fee `0x94f0…84c2` is dead, role-less).
Companion to `docs/deploy-testnet.md` §3–4 (service topology) and
`docs/deploy-followups.md` (incident fixes). Secrets are marked — pull them from the
local gitignored `.env` files, never from this doc.

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
| YES_TOKEN_ADDRESS | `0x0228cf2f1BD7F11D07fA3c190F495171D35C85be` |
| NO_TOKEN_ADDRESS | `0xB6Ca19E4590E28214902c18d37351238170E3D76` |
| CLOB_SETTLEMENT_ADDRESS | `0xC31702C1C2c41FcCb57446E0fda5091412bccB8e` |
| CREDIT_MARKET_ADDRESS | `0x26C3d2E6C29e8E414A4424aa9c9AFa5eFF15F51b` |
| ORACLE_ROUTER (frontend only) | `0xDB8aD9aBF47870f1117382E22b764E90C862C8Bc` |
| LIQUIDATION_ENGINE (frontend only) | `0x16Be3ac2f3d76f95a86BE961b2fE5B8EFB53c6B5` |

## Railway — order-book-server (root dir `backend/order-book-server`, public)

```
USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
YES_TOKEN_ADDRESS=0x0228cf2f1BD7F11D07fA3c190F495171D35C85be
NO_TOKEN_ADDRESS=0xB6Ca19E4590E28214902c18d37351238170E3D76
CLOB_SETTLEMENT_ADDRESS=0xC31702C1C2c41FcCb57446E0fda5091412bccB8e
CREDIT_MARKET_ADDRESS=0x26C3d2E6C29e8E414A4424aa9c9AFa5eFF15F51b
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
YES_TOKEN_ADDRESS=0x0228cf2f1BD7F11D07fA3c190F495171D35C85be
NO_TOKEN_ADDRESS=0xB6Ca19E4590E28214902c18d37351238170E3D76
USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
CLOB_SETTLEMENT_ADDRESS=0xC31702C1C2c41FcCb57446E0fda5091412bccB8e
CREDIT_MARKET_ADDRESS=0x26C3d2E6C29e8E414A4424aa9c9AFa5eFF15F51b
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
CREDIT_MARKET_ADDRESS=0x26C3d2E6C29e8E414A4424aa9c9AFa5eFF15F51b
KEEPER_PRIVATE_KEY=<SECRET — backend/keepers/.env>
YES_TOKEN_ADDRESS=0x0228cf2f1BD7F11D07fA3c190F495171D35C85be
HOLDER_INDEX_FROM_BLOCK=43766743
REDIS_URL=${{Redis.REDIS_URL}}
HEALTH_PORT=3002
```
Health check `GET :3002/health` (includes `holderIndex` discovery status). (No CLOB
address needed — unaffected by the redeploy.)

**Holder discovery (both keepers):** holders are discovered from YES `Transfer` events
(`backend/keepers/holder-index.ts`). `HOLDER_INDEX_FROM_BLOCK` is REQUIRED — the YES
token deploy block (43766743 on Base Sepolia); the keepers refuse to boot without it.
`REDIS_URL` (Railway reference to the managed Redis) persists the scan cursor + holder
set under `holder-index:84532:<yes token>:*`, shared by both keepers, so only the first
boot pays the full backfill (~3.5k `eth_getLogs` calls on the public RPC, which caps a
call at 1,000 blocks). `TRACKED_HOLDERS` (optional extra seed addresses) is no longer
set — removed from both services 2026-09-26. Optional tuning: `HOLDER_INDEX_CHUNK_SIZE` (1000), `HOLDER_INDEX_CONCURRENCY`
(4).

## Railway — liquidation-keeper (root dir `backend/keepers`, public)

```
RAILWAY_DOCKERFILE_PATH=Dockerfile.liquidation-keeper
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
CHAIN_ID=84532
CREDIT_MARKET_ADDRESS=0x26C3d2E6C29e8E414A4424aa9c9AFa5eFF15F51b
YES_TOKEN_ADDRESS=0x0228cf2f1BD7F11D07fA3c190F495171D35C85be
HOLDER_INDEX_FROM_BLOCK=43766743
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
CREDIT_MARKET_ADDRESS=0x26C3d2E6C29e8E414A4424aa9c9AFa5eFF15F51b
YES_TOKEN_ADDRESS=0x0228cf2f1BD7F11D07fA3c190F495171D35C85be
USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
LIQUIDATION_ENGINE_ADDRESS=0x16Be3ac2f3d76f95a86BE961b2fE5B8EFB53c6B5
INSURANCE_FUND_ADDRESS=0xEDbBF8ffF57198bc44897A519088FE5AcD828aB1
CLOB_SETTLEMENT_ADDRESS=0xC31702C1C2c41FcCb57446E0fda5091412bccB8e
ORDER_BOOK_URL=http://<order-book-server private domain>:<port>
HOLDER_INDEX_FROM_BLOCK=43766743
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
contract addresses here after the CreditMarket-family redeploy.

## Vercel — frontend (root dir `frontend`)

```
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=<from frontend/.env.local — required, build throws without it>
NEXT_PUBLIC_RPC_URL=https://sepolia.base.org
NEXT_PUBLIC_CREDIT_MARKET_ADDRESS=0x26C3d2E6C29e8E414A4424aa9c9AFa5eFF15F51b
NEXT_PUBLIC_YES_TOKEN_ADDRESS=0x0228cf2f1BD7F11D07fA3c190F495171D35C85be
NEXT_PUBLIC_NO_TOKEN_ADDRESS=0xB6Ca19E4590E28214902c18d37351238170E3D76
NEXT_PUBLIC_CLOB_SETTLEMENT_ADDRESS=0xC31702C1C2c41FcCb57446E0fda5091412bccB8e
NEXT_PUBLIC_ORACLE_ROUTER_ADDRESS=0xDB8aD9aBF47870f1117382E22b764E90C862C8Bc
NEXT_PUBLIC_LIQUIDATION_ENGINE_ADDRESS=0x16Be3ac2f3d76f95a86BE961b2fE5B8EFB53c6B5
NEXT_PUBLIC_USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e
NEXT_PUBLIC_FEE_BPS=50
NEXT_PUBLIC_ORDER_BOOK_URL=https://<order-book-server Railway PUBLIC domain>
NEXT_PUBLIC_LIQUIDATION_KEEPER_URL=https://<liquidation-keeper Railway PUBLIC domain>
```
The two Railway public domains must exist before the Vercel deploy is useful (the app
builds without them but the market page can't load a book). `NEXT_PUBLIC_FEE_BPS` is only the preview
fallback while the live on-chain fee rate loads; Downbet buys can't be signed until it has.
