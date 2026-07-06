# Base Sepolia Deployment Runbook (Phase 1)

Companion to `docs/production-plan.md` (Phase 1 scope) and root `CLAUDE.md`. This is a
step-by-step guide for the humans running the deploy — contracts (Foundry), Railway
(backend), and Vercel (frontend). Nothing in this doc has been executed; every command is
written from reading the actual scripts/code, not from memory of how similar stacks work.
Terminology used below matches internal/code naming (YES/NO, CreditMarket, etc.) — the
live UI never shows these names (see root `CLAUDE.md` "UX / Naming Conventions"); this is
an ops document, not user-facing copy.

---

## 0. Prerequisites

- Foundry installed (`forge`, `cast`) and `contracts/lib/` submodules initialized
  (`git submodule update --init --recursive` from repo root).
- A funded deployer EOA with Base Sepolia ETH (bridge/faucet — see §5).
- A Blockscout API key for Base Sepolia (used for verification; despite the env var name
  `ETHERSCAN_API_KEY`, `contracts/foundry.toml` points `[etherscan] base_sepolia` at
  `https://base-sepolia.blockscout.com/api`, not real Etherscan).
- Two more EOAs to generate (or reuse the deployer, not recommended — see §2):
  a **keeper** key (signs `accrueFunding()`/`flagClaimable()`/`setMark()` txs from
  `funding-keeper.ts`) and a **settler** key (signs `CLOBSettlement.verifyAndSettle()` txs
  from `matching-engine`'s settler). `cast wallet new` generates a fresh keypair for each.

---

## 1. Deploy contracts

From `contracts/`:

```bash
cd contracts
cp .env.example .env   # then fill in real values — never commit this file
# .env needs: BASE_SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY, ETHERSCAN_API_KEY
source .env
make deploy-sepolia
```

`make deploy-sepolia` runs:

```
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify --slow
```

`Deploy.s.sol` deploys, in order: `YESToken`, `NOToken`, `CreditMarket` (initial mark
hardcoded to `0.23e18` = 23% — the team's MSTR CDS reference price; edit the constant in
the script before deploying if that's stale), `CLOBSettlement`, `OracleRouter`,
`InsuranceFund`, `LiquidationEngine`. USDC address defaults to Base Sepolia's real Circle
USDC (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`) unless `USDC_ADDRESS` is set in the
environment (that override exists for local-fork testing — do not set it for a real
Sepolia deploy).

**Artifact written:** `contracts/deployments/base-sepolia.json` — chainId, deployer, all
seven contract addresses, `initialMark`. **This file currently holds a stale local Anvil
deployment (chainId 31337)** — `make deploy-sepolia` overwrites it with the real Sepolia
addresses (chainId 84532). Commit the new file once addresses are confirmed live; back up
the old one first if you want an anvil-testing snapshot for later.

The `--verify` flag on the `forge script` command attempts inline verification during
`Deploy.s.sol`'s broadcast, but only against whatever `[etherscan]` chain config
`--verify` resolves — confirm in the forge output that verification actually succeeded
per-contract; if any are missing, use the dedicated script next.

### 1a. Verification (if `--verify` missed anything, or for LiquidationEngine)

```bash
forge script script/VerifyContracts.s.sol --rpc-url base_sepolia
```

Reads `deployments/base-sepolia.json` and shells out to `forge verify-contract` (via
`vm.ffi`, requires `ffi = true` in `foundry.toml` — already set) for: `YESToken`,
`NOToken`, `CreditMarket`, `CLOBSettlement`, `OracleRouter`, `InsuranceFund`.

**Known gap: `VerifyContracts.s.sol` does NOT verify `LiquidationEngine`** — it's deployed
by `Deploy.s.sol` and present in the JSON (`.liquidationEngine`), but missing from the
verify script's list. Verify it manually if you want it readable on the block explorer:

```bash
forge verify-contract \
  $(cat deployments/base-sepolia.json | jq -r .liquidationEngine) \
  src/LiquidationEngine.sol:LiquidationEngine \
  --chain base-sepolia \
  --constructor-args $(cast abi-encode "constructor(address,address)" \
    $(cat deployments/base-sepolia.json | jq -r .creditMarket) \
    $(cat deployments/base-sepolia.json | jq -r .insuranceFund)) \
  --etherscan-api-key $ETHERSCAN_API_KEY
```

---

## 2. Post-deploy roles and wiring (read from `contracts/script/Deploy.s.sol` — be precise, this is not the full set an operator needs)

`Deploy.s.sol` grants automatically, inside the same broadcast:

| Grantee | Role | On |
|---|---|---|
| `CreditMarket` | `MINTER_ROLE`, `BURNER_ROLE` | `YESToken`, `NOToken` |
| `CLOBSettlement` | `CLOB_ROLE` | `YESToken`, `NOToken`, `CreditMarket` |
| `OracleRouter` | `ORACLE_ROLE` | `CreditMarket` |
| `LiquidationEngine` | `CLOB_ROLE` | `YESToken` |
| `LiquidationEngine` | `LIQUIDATOR_ROLE` | `CreditMarket`, `InsuranceFund` |
| deployer | `DEFAULT_ADMIN_ROLE` | `CreditMarket` (and each contract's own admin role via its own constructor) |

**What the script does NOT grant — these are manual and launch-blocking:**

1. **`KEEPER_ROLE` is never granted to anyone.** `funding-keeper.ts`'s
   `flagClaimable()`/`setMark()` calls (`onlyRole(KEEPER_ROLE)` in `CreditMarket.sol`)
   will revert until you grant it to the keeper EOA:
   ```bash
   cast send $CREDIT_MARKET_ADDRESS \
     "grantRole(bytes32,address)" \
     $(cast keccak "KEEPER_ROLE") \
     $KEEPER_ADDRESS \
     --rpc-url $BASE_SEPOLIA_RPC_URL \
     --private-key $DEPLOYER_PRIVATE_KEY
   ```
2. **`PAUSER_ROLE` is never granted to anyone**, including the deployer — `Deploy.s.sol`
   only grants `DEFAULT_ADMIN_ROLE` to the deployer, and holding `DEFAULT_ADMIN_ROLE` does
   NOT let you call an `onlyRole(PAUSER_ROLE)` function; it only lets you grant/revoke
   `PAUSER_ROLE` (its default admin role). Self-grant it to whichever wallet should be
   able to pause during a credit-event determination window (root `CLAUDE.md`: "Pausable
   on CreditMarket — PAUSER_ROLE halts market during determination window"):
   ```bash
   cast send $CREDIT_MARKET_ADDRESS \
     "grantRole(bytes32,address)" \
     $(cast keccak "PAUSER_ROLE") \
     $PAUSER_ADDRESS \
     --rpc-url $BASE_SEPOLIA_RPC_URL \
     --private-key $DEPLOYER_PRIVATE_KEY
   ```
3. **The settler EOA (`matching-engine`'s `SETTLER_PRIVATE_KEY`) needs NO role at all** —
   confirmed by reading `CLOBSettlement.verifyAndSettle` (`contracts/src/CLOBSettlement.sol`
   line 108): it's `external nonReentrant` with no `onlyRole` modifier, i.e. permissionless
   by design (anyone can relay a pair of validly signed orders). It only needs Base Sepolia
   ETH for gas.
4. **`liquidation-keeper.ts` needs no role either** — it's read-only (`GET /claimable`
   only reads `claimable`/`frozenFunding`/`fundingDebt`/`currentMark`/`motionPending`);
   `LiquidationEngine.claim()` is permissionless and called by third parties, not by the
   keeper process.
5. **No fee mechanism exists in these contracts** — root `CLAUDE.md`'s "What NOT to Build
   in MVP" explicitly excludes fee distribution; there is nothing to wire here despite
   what you might expect from a typical CLOB deploy checklist.

Fund the keeper and settler EOAs with a small amount of Base Sepolia ETH each (gas only —
Section 5 covers faucets) before starting the backend services.

---

## 3. Railway (backend)

Create one Railway project for this environment (e.g. "pari-sepolia"). Steps:

### 3.0 Redis
Add a Railway-managed Redis plugin to the project. Note its private connection host/port
(Railway exposes this as `${{Redis.RAILWAY_PRIVATE_DOMAIN}}` / `${{Redis.RAILWAY_TCP_PROXY_PORT}}`
template variables you can reference from each service's env vars, or read them off the
Redis plugin's "Connect" tab). For each service that needs Redis, set
`REDIS_URL=${{Redis.REDIS_URL}}` (Railway reference variable) — it carries the
required auth password that bare `REDIS_HOST`/`REDIS_PORT` cannot.

### 3.1 order-book-server
- New service → Deploy from GitHub repo → this monorepo.
- Root Directory: `backend/order-book-server` (Dockerfile auto-detected at that path).
- Env vars (see `backend/order-book-server/.env.example` for the full annotated list):
  `USDC_ADDRESS`, `YES_TOKEN_ADDRESS`, `NO_TOKEN_ADDRESS`, `CLOB_SETTLEMENT_ADDRESS`,
  `CREDIT_MARKET_ADDRESS` (all from `deployments/base-sepolia.json` after §1),
  `CHAIN_ID=84532`, `BASE_SEPOLIA_RPC_URL`, `REDIS_URL=${{Redis.REDIS_URL}}` (leave
  `PORT` unset — Railway injects it).
- Networking: **public** (frontend calls this directly via `NEXT_PUBLIC_ORDER_BOOK_URL`
  — see §4). Generate a Railway domain or attach a custom one.
- Health check: **no `/health` route exists on this service** (confirmed — only
  `GET /orderbook` and the order mutation routes in `src/server.ts`). Point Railway's
  health check at `GET /orderbook` (200 on an empty book is fine), or disable the
  HTTP health check and rely on Railway's default TCP/process check.

### 3.2 matching-engine
- New service, same repo. Root Directory = `backend/matching-engine`.
- Env vars (see `backend/matching-engine/.env.example`): `YES_TOKEN_ADDRESS`,
  `NO_TOKEN_ADDRESS`, `USDC_ADDRESS`, `CLOB_SETTLEMENT_ADDRESS`, `CREDIT_MARKET_ADDRESS`,
  `POLL_INTERVAL_MS=500`, `ORDER_BOOK_URL` (Railway
  **private** URL of the order-book-server service, e.g.
  `http://order-book-server.railway.internal:3001` — use Railway's private networking
  hostname, not the public domain), `SETTLER_PRIVATE_KEY`, `BASE_SEPOLIA_RPC_URL`,
  `REDIS_URL=${{Redis.REDIS_URL}}`. The three settler contract addresses MUST be set explicitly
  in hosted environments — the `contracts/deployments/base-sepolia.json` fallback in
  `createSettler()` is local-dev only and does not exist inside the container.
- Networking: **internal/private only** — this service exposes no HTTP server at all (it's
  a poller), so do not generate a public domain for it.
- Health check: none available (no HTTP server in this process — confirmed, no `.listen()`
  anywhere in `src/`). Disable Railway's HTTP health check for this service; rely on
  process/restart-on-crash behavior instead.
### 3.3 funding-keeper
- New service, same repo. Root Directory: `backend/keepers`.
- `RAILWAY_DOCKERFILE_PATH=Dockerfile.funding-keeper` (non-default filename).
- Env vars (see `backend/keepers/.env.example`): `BASE_SEPOLIA_RPC_URL`, `CHAIN_ID=84532`,
  `CREDIT_MARKET_ADDRESS`, `TRACKED_HOLDERS` (comma-separated — see "Known limitation"
  below), `KEEPER_PRIVATE_KEY`, `HEALTH_PORT=3002`.
- Networking: internal only (nothing else needs to reach it).
- Health check: `GET :3002/health` (confirmed route in `funding-keeper.ts`).
- **Known limitation, out of scope for this doc** (tracked in `docs/production-plan.md`
  Launch-blocking requirement #1): this keeper only watches the hand-maintained
  `TRACKED_HOLDERS` list — any YES/Upbet holder not on that list is invisible to it and
  never gets flagged, silently shifting tail risk onto the InsuranceFund. Keep the list
  current manually until holder indexing ships.

### 3.4 liquidation-keeper
- New service, same repo. Root Directory: `backend/keepers`.
- `RAILWAY_DOCKERFILE_PATH=Dockerfile.liquidation-keeper`.
- Env vars: `BASE_SEPOLIA_RPC_URL`, `CHAIN_ID=84532`, `CREDIT_MARKET_ADDRESS`,
  `YES_TOKEN_ADDRESS`, `TRACKED_HOLDERS` (same list as funding-keeper), `POLL_INTERVAL_MS=30000`,
  `PORT=3003`. No private key — read-only.
- Networking: **public** (frontend's `/liquidate` page calls this directly via
  `NEXT_PUBLIC_LIQUIDATION_KEEPER_URL` — see §4).
- Health check: `GET :3003/health` (confirmed route in `liquidation-keeper.ts`).

---

## Known gotchas found while preparing this (reported, not fixed)

- **(FIXED in Phase 1)** `createSettler()` in `src/settler.ts` used to do an un-try-caught
  `fs.readFileSync` of `contracts/deployments/base-sepolia.json` with no env override —
  it now takes `CLOB_SETTLEMENT_ADDRESS`/`CREDIT_MARKET_ADDRESS`/`USDC_ADDRESS` from env
  first and only falls back to the JSON (with a clear error) when one is missing. All
  services now configure addresses uniformly via env vars.
- **order-book-server and both keepers degrade gracefully** without the deployments file:
  `order-book-server/src/main.ts`'s `loadDeployments()` wraps the read in try/catch and
  returns `{}` on any failure; both keeper scripts only touch the file inside an
  `if (!envVarSet)` branch, so setting `CREDIT_MARKET_ADDRESS` (and `YES_TOKEN_ADDRESS`
  for keepers) via Railway env vars skips the file read entirely. These three services
  need no special build-context handling.
- **`backend/keepers/tsconfig.json`'s `include` is `["funding-keeper.ts"]` only** —
  `npm run build` (tsc) never compiles `liquidation-keeper.ts`, so there is no dist/
  entry point for it. Both keeper Dockerfiles run their `.ts` file directly via
  `node -r ts-node/register <file>.ts` instead (matching the existing `package.json`
  "start" script and `scripts/demo/demo-up.sh`), sidestepping the gap rather than fixing
  the tsconfig.
- **`VerifyContracts.s.sol` never verifies `LiquidationEngine`** — see §1a for the manual
  command.

---

## 4. Vercel (frontend)

Import `frontend/` as the project root (Vercel monorepo support: set "Root Directory" =
`frontend` in the project's Settings → General).

Env vars (all read via `process.env.NEXT_PUBLIC_*`, confirmed in `frontend/lib/wagmi.ts`,
`frontend/lib/contracts.ts`, `frontend/lib/constants.ts` — see
`frontend/.env.local.example` for the full annotated list):

| Var | Source |
|---|---|
| `NEXT_PUBLIC_CREDIT_MARKET_ADDRESS` | `deployments/base-sepolia.json` → `.creditMarket` |
| `NEXT_PUBLIC_YES_TOKEN_ADDRESS` | `.yesToken` |
| `NEXT_PUBLIC_NO_TOKEN_ADDRESS` | `.noToken` |
| `NEXT_PUBLIC_CLOB_SETTLEMENT_ADDRESS` | `.clobSettlement` |
| `NEXT_PUBLIC_ORACLE_ROUTER_ADDRESS` | `.oracleRouter` |
| `NEXT_PUBLIC_LIQUIDATION_ENGINE_ADDRESS` | `.liquidationEngine` |
| `NEXT_PUBLIC_USDC_ADDRESS` | `.usdc` (or omit — defaults to the same Circle Sepolia USDC) |
| `NEXT_PUBLIC_RPC_URL` | same `BASE_SEPOLIA_RPC_URL` used for contracts/backend |
| `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` | from https://cloud.walletconnect.com — **required in production**, `lib/wagmi.ts` throws at config-creation time if unset/empty when `NODE_ENV=production` (Vercel sets `NODE_ENV=production` automatically) |
| `NEXT_PUBLIC_ORDER_BOOK_URL` | the Railway **public** domain for order-book-server (§3.1), e.g. `https://order-book-server-production.up.railway.app` |
| `NEXT_PUBLIC_LIQUIDATION_KEEPER_URL` | the Railway **public** domain for liquidation-keeper (§3.4) |

No frontend env var points at matching-engine — it has no public API and the frontend
never talks to it directly (consistent with §3.2's internal-only networking).

Framework preset: Next.js (auto-detected). Build command / output default to
`next build` / `.next` — no override needed (`next.config.js`'s `distDir` override only
triggers if `NEXT_DIST_DIR` is set, which Vercel doesn't set by default).

---

## 5. Smoke checklist

1. **Faucets** (testnet, free):
   - Base Sepolia ETH: https://www.coinbase.com/faucets/base-ethereum-sepolia-faucet or
     the Superchain faucet (https://console.optimism.io/faucet) — fund deployer, keeper,
     settler EOAs, and at least one test wallet for the mint/trade flow.
   - Sepolia USDC: https://faucet.circle.com (select "Base Sepolia") — fund the test
     wallet used for `mint()`.
2. **Mint:** connect the funded test wallet on `/market/[id]`, approve USDC to
   `CreditMarket`, call `mint(usdcAmount)` — confirm YES ("Upbet") and NO ("Downbet")
   ERC-20 balances appear (auto-visible in MetaMask once each token contract is
   recognized; may need "Import tokens" once with the addresses from §4's table).
3. **Order → match:** place a resting limit order from one wallet (`POST /order` via the
   UI), a crossing order from a second funded wallet; confirm `matching-engine` logs a
   `[match]` line and (with the settler wired) a settlement tx hash; confirm both
   wallets' balances update on `/portfolio`.
4. **Portfolio:** confirm Cost Basis / Equity / P&L / Breakeven Mark / Epochs To Expire
   render correctly for the YES side, and that funding accrues over time (needs
   `funding-keeper` running and past at least one epoch — `epochLength` is set to
   `1 days` in `Deploy.s.sol`'s `CreditMarket` constructor call, so either wait a day on
   real Sepolia or use a shorter interval on a throwaway test deployment if you need a
   fast demo of accrual).
5. **Liquidation path (optional, needs a deliberately underfunded position):** confirm
   `GET /claimable` (liquidation-keeper) lists a flagged wallet after
   `funding-keeper` calls `flagClaimable`, and that `/liquidate` in the frontend shows a
   Claim button that calls `LiquidationEngine.claim(user)`.

---

## Ambiguities / decisions made while writing this doc

- Chose **two separate Dockerfiles** for the keepers package (`Dockerfile.funding-keeper`,
  `Dockerfile.liquidation-keeper`) over one Dockerfile with a Railway "Custom Start
  Command" override, so the correct entry point is baked into the image rather than
  depending on someone remembering to set a per-service override in the Railway
  dashboard.
- Railway's Root Directory vs. `RAILWAY_DOCKERFILE_PATH` interaction was confirmed against
  Railway's public docs (docs.railway.com/guides/monorepo, docs.railway.com/builds/dockerfiles)
  but not tested against a live Railway project (no account access per this task's
  constraints) — verify the exact dashboard field names/behavior before relying on this
  section, in case Railway's UI has changed.
- Assumed the keeper and settler EOAs should be distinct from the deployer and from each
  other (least-privilege), even though `docs/production-plan.md` files the "dedicated hot
  EOAs" work under Phase 3's key ceremony — doing it from day one on testnet costs
  nothing and avoids a key-rotation exercise later.
