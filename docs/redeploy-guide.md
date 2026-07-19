# Redeploy Guide — Base Sepolia

*How to ship a code change to the live testnet stack. Assumes you've read
`docs/HANDOVER.md` (state, wallets, non-obvious semantics). This doc is deliberately
thin — it routes you to the right procedure by change type and calls out the fan-out
steps people forget. It does not restate `docs/deploy-testnet.md` (from-scratch runbook),
`docs/hosted-env-vars.md` (env source of truth), or `docs/deploy-followups.md` (incident
record) — read those when a step below points at them.*

## Hosted topology (current)

- **Railway** project `exciting-embrace`, env `production`, GitHub-connected to
  `axedbuyer/credit-prediction-dex`. **Any push to `main` rebuilds all four services.**
  - `order-book-server` — public, `https://order-book-server-production-9bb6.up.railway.app`,
    root `backend/order-book-server`, default Dockerfile, health `GET /orderbook`.
  - `matching-engine` — internal only, root `backend/matching-engine`, no HTTP server.
  - `funding-keeper` — internal only, root `backend/keepers`,
    `RAILWAY_DOCKERFILE_PATH=Dockerfile.funding-keeper`, health `:3002/health`.
  - `liquidation-keeper` — public, `https://liquidation-keeper-production.up.railway.app`,
    root `backend/keepers`, `RAILWAY_DOCKERFILE_PATH=Dockerfile.liquidation-keeper`,
    health `/health`.
  - Managed Redis (`REDIS_URL` via `${{Redis.REDIS_URL}}`).
  - CLI is authenticated and the repo dir is linked: `railway status`,
    `railway variables --set KEY=VAL --service <name> --skip-deploys` (legacy spelling;
    `railway variable set KEY=VAL --skip-deploys` is the current form — both work on
    CLI v5.26), `railway redeploy --service <name>` (all verified working).
- **Vercel** project `credit-prediction-dex` → `https://credit-prediction-dex.vercel.app`,
  git-linked, `rootDirectory=frontend`. **Push to `main` auto-deploys production.**
  `NEXT_PUBLIC_*` vars are baked at **build time** — changing one in the dashboard does
  nothing until you trigger a redeploy. No Vercel CLI on this machine; env changes go
  through the dashboard (or REST API with a fresh token).
- **GitHub**: no stored push credentials on this machine — the repo owner supplies a PAT
  per push (used inline), or fall back to the GitHub MCP API.

---

## 1. Frontend-only change

1. Build locally first — `npm run build` under `frontend/` takes **>5 min on WSL2**, budget
   for it, don't cancel early.
2. Push to `main` → Vercel auto-builds and deploys.
3. If an env var changed (new address, new flag, etc.):
   - Update `docs/hosted-env-vars.md` (source of truth).
   - Update the var in the Vercel project settings.
   - Trigger a redeploy — build-time baking means the old value ships otherwise.
4. If the change touches fee math, remember `frontend/lib/feeMath.ts` is one of **three**
   mirrored implementations (see "Fee math" note below) — don't edit it in isolation.

## 2. Backend-only change (order-book-server / matching-engine / keepers)

1. Run the service's Vitest suite before pushing.
2. Push to `main` → Railway rebuilds **all four services** (there's no per-service
   trigger from a plain push).
3. If an env var changed: update `docs/hosted-env-vars.md`, then
   `railway variables --set KEY=VAL --service <name> --skip-deploys`, then
   `railway redeploy --service <name>`.
4. Watch for:
   - Keepers run their `.ts` entrypoints via `ts-node` **at runtime** — their
     Dockerfiles need `npm ci --include=dev`. Do not "optimize" that away; it crash-loops
     the container (see `docs/deploy-followups.md` §1).
   - `order-book-server` and `matching-engine` do **not** load dotenv — only Railway
     service vars reach them, a local `.env` change alone does nothing on Railway.
   - `FEE_BPS` on `order-book-server` must equal the on-chain `feeBps`. Overstating it
     skips marginal crosses; understating it causes `SlippageExceeded` reverts.
   - The `contracts/deployments/base-sepolia.json` fallback file is **not** copied into
     any Docker image — address env vars (`CREDIT_MARKET_ADDRESS`, `YES_TOKEN_ADDRESS`,
     etc.) are mandatory on Railway, not optional-with-a-local-fallback there.

## 3. Contract change

This is the delicate one — pick the sub-case that matches.

### 3a. New CLOBSettlement (constructor/logic change)

The case `contracts/script/RedeployCLOBSettlement.s.sol` already exercises. Steps:

1. `cd contracts && forge test` — must be green first.
2. Broadcast the redeploy script (deployer key in `contracts/.env`;
   `ETHERSCAN_API_KEY=blockscout` works for verification). The script, in one broadcast:
   - deploys the new `CLOBSettlement`,
   - grants `CLOB_ROLE` on YES/NO/CreditMarket to it,
   - revokes `CLOB_ROLE` from the old CLOB address read out of the deployments JSON
     (guarded by `oldClobAddr != _newClob`),
   - calls `setFeeConfig(...)`,
   - rewrites `contracts/deployments/base-sepolia.json`.
3. **Known footgun:** a forge **dry run** already rewrites the deployments JSON. If you
   dry-run then broadcast, the broadcast reads `oldClobAddr == newClobAddr` (same deployer
   nonce) and the guard silently skips the revoke — the old CLOB keeps `CLOB_ROLE`. Run
   `git checkout contracts/deployments/base-sepolia.json` between a dry run and a real
   broadcast.
4. Fan out (all required — a partial rollout leaves services pointed at a dead contract):
   1. Update `docs/hosted-env-vars.md` with the new address.
   2. Update `CLOB_SETTLEMENT_ADDRESS` on `order-book-server` + `matching-engine` Railway
      vars, and `NEXT_PUBLIC_CLOB_SETTLEMENT_ADDRESS` on Vercel.
   3. Update local gitignored `.env`s: `backend/matching-engine/.env`,
      `backend/order-book-server/.env`, `frontend/.env.local`.
   4. **Flush the hosted Redis order/nonce keys**, not just local. The EIP-712 domain is
      per-contract — every resting order/nonce signed against the old address is dead and
      will never settle; leaving them in Redis just wastes matching-engine cycles trying.
   5. Makers must re-approve the new contract as USDC/YES/NO spender.
      `scripts/demo/mm-sepolia-seed.ts` re-approves the deployer idempotently — run it for
      that wallet at minimum.
   6. Commit the updated `contracts/deployments/base-sepolia.json` + push — this triggers
      the Railway/Vercel rebuilds that pick up the new address.
   7. Re-seed the book:
      ```
      cd scripts/demo
      set -a && . ../../contracts/.env && set +a
      ORDER_BOOK_URL=https://order-book-server-production-9bb6.up.railway.app npx tsx mm-sepolia-seed.ts
      ```
   8. Verify: `/orderbook` shows quotes, a test trade settles end-to-end, Blockscout shows
      the new contract verified.

### 3b. Redeploying a different single contract

No ready-made script exists. Model a new `script/Redeploy<X>.s.sol` on
`RedeployCLOBSettlement.s.sol`. Before writing it, map exactly which roles/wiring that
contract carries — check `Deploy.s.sol` and `docs/deploy-testnet.md`. Remember
`Deploy.s.sol` does **not** grant `KEEPER_ROLE` / `PAUSER_ROLE` — those are manual grants
you'll need to replicate.

Changing **CreditMarket** is not a single-contract redeploy — YES/NO tokens, CLOBSettlement,
OracleRouter, and LiquidationEngine all reference it by address at construction. Treat any
CreditMarket change as a full fresh deploy (3c).

### 3c. Full fresh deploy

Follow `docs/deploy-testnet.md` end to end. Nothing in this doc substitutes for it.

---

## Fan-out cheat-sheet

| Change type | deployments JSON | hosted-env-vars.md | Railway vars | Vercel vars | local `.env`s | Redis flush | re-approve | re-seed |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| Frontend-only, no env change | | | | | | | | |
| Frontend-only, env change | | ✅ | | ✅ | | | | |
| Backend-only, no env change | | | | | | | | |
| Backend-only, env change | | ✅ | ✅ | | | | | |
| New CLOBSettlement (3a) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Other single-contract redeploy (3b) | ✅ | ✅ | as needed | as needed | as needed | if address changed | if approvals changed | if book depends on it |
| Full fresh deploy (3c) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

---

## Standing gotchas, any change type

- **Fee math has three mirrored implementations**: `CLOBSettlement.tradeFee` (Solidity),
  `order-book-server/src/fee.ts`, `frontend/lib/feeMath.ts`. Any change to fee logic must
  land in all three in lockstep, or the fee-free-side/gross-vs-net checks between
  contract, order book, and UI disagree and trades start reverting or mis-pricing.
- **`TRACKED_HOLDERS`** on both `funding-keeper` and `liquidation-keeper` is a
  hand-maintained env list, not derived from chain state. Extend it on both services
  whenever a new YES/Upbet holder shows up, or that holder is invisible to both keepers
  and its tail risk silently lands on the InsuranceFund.
