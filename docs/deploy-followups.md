# Railway Backend Deploy — Follow-Ups (2026-07-07)

Companion to `docs/deploy-testnet.md` (the runbook). This doc is the incident record and
fix-plan for issues actually hit while standing up the four backend services on Railway
today. It does not restate the runbook's step-by-step instructions — read that first if
you're setting up a service from scratch. Terminology matches internal/code naming
(YES/NO, CreditMarket, etc.), same convention as the runbook.

---

## 1. FIXED, pending redeploy — keeper images crash-looped on missing `ts-node`

Both `backend/keepers/Dockerfile.funding-keeper` and `Dockerfile.liquidation-keeper` set
`ENV NODE_ENV=production` before `RUN npm ci`. Under npm 10 (the version in `node:20-slim`),
`NODE_ENV=production` makes `npm ci` default to `omit=dev`, dropping `ts-node` — a
`devDependency` that both entrypoints require *at runtime* via
`CMD ["node", "-r", "ts-node/register", "funding-keeper.ts"]` /
`liquidation-keeper.ts`. Result: container starts, immediately throws `Cannot find module
'ts-node/register'`, exits, and Railway restart-loops it.

**Fixed in commit `fa1e729`** (`fix(deploy): keeper images lose ts-node — force npm ci
--include=dev`): both Dockerfiles now run `RUN npm ci --include=dev`, which is immune to
the `NODE_ENV` ordering issue. Confirmed by reading both Dockerfiles post-fix — line 28 in
each is now `RUN npm ci --include=dev`.

`matching-engine` and `order-book-server` are **not** affected — both use a two-stage
Dockerfile build (`FROM node:20-slim AS builder` → `npm run build` (tsc) → runtime stage
`COPY --from=builder /app/dist ./dist`, `CMD ["node", "dist/main.js"]`). They never need
`ts-node` in the runtime image, and their runtime-stage `npm ci --omit=dev` is correct as
written.

**Action items:**
- [ ] Push `main` (through `fa1e729`) to GitHub.
- [ ] Redeploy `funding-keeper` and `liquidation-keeper` on Railway (Redeploy, not just a
      restart — the image needs to be rebuilt with the fixed Dockerfile).
- [ ] Confirm boot logs show `[keeper] started` (funding-keeper) and `[liq-keeper]
      started` (liquidation-keeper) — see item 4 below for the exact log lines and health
      checks to verify.

---

## 2. Railway service misconfiguration — order-book-server

Observed on the `order-book-server` Railway service:
- **Root Directory** was typo'd `backedn/order-book-server` (transposed letters) instead
  of `backend/order-book-server`.
- It also had `RAILWAY_DOCKERFILE_PATH` set to `Dockerfile.liquidation-keeper` (presumably
  copy-pasted from the liquidation-keeper service config) — deploy failed with "couldn't
  locate the dockerfile at path Dockerfile.liquidation-keeper", since that file only
  exists under `backend/keepers/`, and even the correctly-typo'd root directory
  (`backend/order-book-server`) has no such file — it just has a plain `Dockerfile`.

**Correct four-service config** (cross-checked against each service's actual Dockerfile
and `docs/deploy-testnet.md` §3):

| Service | Root Directory | Dockerfile override | Notes |
|---|---|---|---|
| `order-book-server` | `backend/order-book-server` | none (default `Dockerfile` auto-detected) | public networking; health check `GET /orderbook` (no `/health` route) |
| `matching-engine` | `backend/matching-engine` | none (default `Dockerfile`) | internal-only, no public domain; no HTTP server at all — disable HTTP health check |
| `funding-keeper` | `backend/keepers` | `RAILWAY_DOCKERFILE_PATH=Dockerfile.funding-keeper` | internal-only; health check `GET :3002/health` (or Railway's injected `$PORT` if that env var ends up used — see item 4) |
| `liquidation-keeper` | `backend/keepers` | `RAILWAY_DOCKERFILE_PATH=Dockerfile.liquidation-keeper` | public (frontend's `/liquidate` calls it directly); health check `GET :3003/health` |

**Known Railway quirk to watch for:** `RAILWAY_DOCKERFILE_PATH` has been reported
inconsistent about whether it's relative to the service's Root Directory or to the repo
root. If Railway can't find `Dockerfile.funding-keeper` with Root Directory =
`backend/keepers`, try the repo-root-relative form
`RAILWAY_DOCKERFILE_PATH=backend/keepers/Dockerfile.funding-keeper` instead (same for the
liquidation-keeper service). `docs/deploy-testnet.md`'s own ambiguities section already
flags that this interaction was never tested against a live Railway project before today
— now it has been, so update that doc once the correct form is confirmed working.

**Action items:**
- [ ] Fix `order-book-server`'s Root Directory to `backend/order-book-server` (no leading
      typo) and clear its Dockerfile-path override (should use the default `Dockerfile`).
- [ ] While auditing, re-verify Root Directory + Dockerfile override on all four services
      against the table above — the same copy-paste-from-another-service mistake could
      exist elsewhere and just not have surfaced yet.

---

## 3. Keeper fallback-to-JSON-file crash (check for this if crash persists after the ts-node fix)

Both keeper entrypoints resolve `CREDIT_MARKET_ADDRESS` (and, for liquidation-keeper,
`YES_TOKEN_ADDRESS`) from an env var first, falling back to reading
`contracts/deployments/base-sepolia.json` if the env var is unset:

- `backend/keepers/funding-keeper.ts`, `main()` (starts line 354): `KEEPER_PRIVATE_KEY`
  (line 355-356) and `BASE_SEPOLIA_RPC_URL` (line 358-359) each throw an explicit
  `Error('... env var is required')` if unset — these fail loud and clear. But
  `CREDIT_MARKET_ADDRESS` (lines 361-374) only throws that way if the env var is set; if
  it's unset, the code does `fs.readFileSync(path.join(__dirname, '..', '..', 'contracts',
  'deployments', 'base-sepolia.json'))` with **no try/catch** — an unset env var on a host
  where that file doesn't exist crashes with a raw `ENOENT`, not a friendly message.
- `backend/keepers/liquidation-keeper.ts`, `main()` (starts line 279): `BASE_SEPOLIA_RPC_URL`
  throws explicitly (line 280-281) if unset. `CREDIT_MARKET_ADDRESS` / `YES_TOKEN_ADDRESS`
  (lines 283-299) go through the same unguarded `fs.readFileSync` fallback if either is
  unset, before the (now largely unreachable, since the read itself would already have
  thrown) explicit `'... is required'` checks below it.

The resolved path is `backend/keepers/../../contracts/deployments/base-sepolia.json`, i.e.
`<repo root>/contracts/deployments/base-sepolia.json`. **Neither keeper Dockerfile copies
this file into the image** — both only `COPY package.json package-lock.json ./`,
`COPY tsconfig.json ./`, and `COPY <entrypoint>.ts ./`. So on Railway, if
`CREDIT_MARKET_ADDRESS` (and, for liquidation-keeper, `YES_TOKEN_ADDRESS`) are not set as
env vars, the container crashes on an `ENOENT` reading a file that structurally cannot
exist in that image — this looks identical to a crash-loop from the outside and could be
mistaken for the item 1 bug recurring if it isn't checked separately.

**Required env vars per service** (from `backend/keepers/.env.example` and
`docs/deploy-testnet.md` §3.3/§3.4 — not invented):

| Service | Required | Optional (has a default) |
|---|---|---|
| `funding-keeper` | `BASE_SEPOLIA_RPC_URL`, `KEEPER_PRIVATE_KEY`, `CREDIT_MARKET_ADDRESS` | `CHAIN_ID` (84532), `TRACKED_HOLDERS` (empty), `HEALTH_PORT` (3002) |
| `liquidation-keeper` | `BASE_SEPOLIA_RPC_URL`, `CREDIT_MARKET_ADDRESS`, `YES_TOKEN_ADDRESS` | `CHAIN_ID` (84532), `TRACKED_HOLDERS` (empty), `POLL_INTERVAL_MS` (30000), `PORT` (3003) |

**Action item:**
- [ ] If either keeper still fails to boot after the item-1 redeploy, check its Railway
      env vars against the table above first — an `ENOENT` on `base-sepolia.json` in the
      logs means a missing address env var, not a recurrence of the ts-node bug.

---

## 4. Post-redeploy verification checklist

- [ ] `funding-keeper`: `GET :3002/health` (or whatever `HEALTH_PORT` resolves to —
      code reads `process.env.HEALTH_PORT ?? '3002'`, `funding-keeper.ts` line 401).
      Route confirmed at line 334 (`GET /health`), server started at line 346.
- [ ] `liquidation-keeper`: `GET :3003/health` — but the code reads
      `process.env.PORT ?? '3003'` (`liquidation-keeper.ts` line 332). Railway
      auto-injects `PORT` into every service's environment; if that injected value differs
      from the `PORT=3003` set in `docs/deploy-testnet.md` §3.4, the process will bind to
      whatever `PORT` actually resolves to at runtime, not literally 3003 — check the
      actual listen log line (`[liq-keeper] HTTP on http://0.0.0.0:<port>`, line 272) or
      Railway's assigned public port before assuming :3003 is correct externally.
- [ ] `order-book-server`: **no `/health` route exists** (confirmed — only `GET
      /orderbook` and order mutation routes in `src/server.ts`). Use `GET /orderbook`
      (200 on an empty book) for the health check, or disable the HTTP check.
- [ ] `matching-engine`: **no HTTP server at all** — confirmed no `.listen()` call
      anywhere in `backend/matching-engine/src/`. Disable Railway's HTTP health check for
      this service entirely; rely on process/restart-on-crash.
- [ ] Startup log lines to look for: `[keeper] started` (funding-keeper, line 403),
      `[liq-keeper] started` (liquidation-keeper, line 334). Their absence after a
      redeploy means `main()` never reached the end — check for the item-3 `ENOENT` crash
      or another unset required env var first.

---

## 5. Still pending after Railway is green

- **Redis**: only the managed Redis plugin + service scaffolding exist so far; no data
  has been verified to persist across a restart yet.
- **Vercel frontend**: not deployed yet. When it is, note that
  `frontend/lib/wagmi.ts` (lines 6-23) **throws at config-creation time** — not just
  degrades WalletConnect — if `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is unset and
  `NODE_ENV=production` (which Vercel sets automatically on every build). This is
  stricter than "MetaMask still works without it": that's true in local dev (`NODE_ENV`
  isn't `production`, so the code falls back to a `'placeholder'` project ID with a
  `console.warn`), but a Vercel deploy with the var still unset will hard-fail the entire
  app at config creation, not just leave WalletConnect broken. Get a real project ID from
  https://cloud.walletconnect.com before the Vercel deploy, not after.
- **`TRACKED_HOLDERS`**: still empty/hand-maintained on both keepers. Real fix is Phase 2
  holder discovery from chain events (`docs/production-plan.md`, "Launch-blocking
  requirement #1" — indexing `Transfer`/`TokensMinted` events to replace the env list).
  Until that ships, any YES/Upbet holder not manually added to `TRACKED_HOLDERS` is
  invisible to both keepers and silently shifts tail risk onto the InsuranceFund.
- **No liquidity seeded yet** on the live Base Sepolia book. A market-maker seeding
  script exists — `scripts/demo/mm-sepolia-seed.ts` (commit `cecff84`): mints YES+NO from
  the deployer's USDC and rests two-sided quotes around the mark via the (local)
  order-book-server, reusing the demo `clob.ts` EIP-712 helpers, idempotent on
  approvals/mint. Point it at the deployed Railway `order-book-server` URL and run it
  once the four services above are confirmed healthy.

---

## Open questions for whoever runs the next Railway session

- Confirm which form of `RAILWAY_DOCKERFILE_PATH` actually worked for the two keeper
  services (Root-Directory-relative vs. repo-root-relative — see item 2) and record it in
  `docs/deploy-testnet.md` so this doesn't need re-discovering.
- Confirm the actual external port Railway exposes for `liquidation-keeper` given the
  `PORT` env var ambiguity in item 4, and update `docs/deploy-testnet.md` §3.4 if it's not
  literally 3003.
