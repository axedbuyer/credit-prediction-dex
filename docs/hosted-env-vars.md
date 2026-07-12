# Hosted env vars — Railway + Vercel (Base Sepolia, post fee-redeploy 2026-07-12)

Single source of truth for what each hosted service needs, with the CURRENT addresses
(fee-aware CLOBSettlement `0xC317…cB8e` — the pre-fee `0x94f0…84c2` is dead, role-less).
Companion to `docs/deploy-testnet.md` §3–4 (service topology) and
`docs/deploy-followups.md` (incident fixes). Secrets are marked — pull them from the
local gitignored `.env` files, never from this doc.

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
```
Leave `PORT` unset (Railway injects it). No Dockerfile override. Health check:
`GET /orderbook` (no /health route).

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
TRACKED_HOLDERS=0x92fFF5dd1D0Fdb2cC03a4389fd1dF6361C4f477b,0x0D0917e418bc99Ecbfbd1Eb25a98d09CeFB580f1
HEALTH_PORT=3002
```
Health check `GET :3002/health`. (No CLOB address needed — unaffected by the redeploy.)

## Railway — liquidation-keeper (root dir `backend/keepers`, public)

```
RAILWAY_DOCKERFILE_PATH=Dockerfile.liquidation-keeper
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
CHAIN_ID=84532
CREDIT_MARKET_ADDRESS=0x26C3d2E6C29e8E414A4424aa9c9AFa5eFF15F51b
YES_TOKEN_ADDRESS=0x0228cf2f1BD7F11D07fA3c190F495171D35C85be
TRACKED_HOLDERS=0x92fFF5dd1D0Fdb2cC03a4389fd1dF6361C4f477b,0x0D0917e418bc99Ecbfbd1Eb25a98d09CeFB580f1
POLL_INTERVAL_MS=30000
PORT=3003
```
Health check `GET :3003/health`. Read-only, no private key. NOTE: the process binds
`process.env.PORT` and Railway injects its own PORT — check the actual listen log line.

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
builds without them but the market page can't load a book).
