# Engineering Handover — Pari / credit-prediction-dex

*Written 2026-07-07, at the point of handing the project to the next engineer. This doc
captures state and tribal knowledge that is NOT derivable from the code or the other
docs. Read it alongside — not instead of — the canonical references below.*

## Read these first, in this order

1. **Root `CLAUDE.md`** — the canonical product/economics spec: token model, funding
   model, seizure trigger, liquidation math, the 10 hard invariants, UX naming rules
   (YES/NO are internal names; the UI says Upbet/Downbet — never leak internal terms
   into UI copy). If code and this spec disagree, treat it as a bug in the code.
2. **`README.md`** — architecture diagram, repo layout, per-workspace setup/test.
3. **`docs/deploy-testnet.md`** — the testnet deploy runbook (contracts → Railway →
   Vercel). Partially executed; see "Where deployment actually stands" below.
4. **`docs/deploy-followups.md`** — issues hit during the Railway deploy + fix plan.
5. **`docs/production-plan.md`** — the phased path to mainnet (holder discovery, role
   ceremony, invariant suite/audit, dress rehearsal).
6. Per-directory `CLAUDE.md` in `contracts/`, `backend/`, `frontend/` — stack notes.

## State at handover

- **Contracts: live on Base Sepolia** (chainId 84532) since 2026-07-06, all 7 deployed
  and Basescan-verified. Addresses: `contracts/deployments/base-sepolia.json` (tracked;
  do not hand-edit). Initial mark set to 23%.
- **Tests: green.** 87 Foundry tests (`cd contracts && forge test`), 79 Vitest tests
  across the three backend services. Frontend has no test suite — CI type-checks only.
- **Backend hosting: in flight, not green.** A Railway project exists with a managed
  Redis plugin and the four services scaffolded. The keeper services were crash-looping
  (root cause found and fixed in commit `fa1e729` — see `docs/deploy-followups.md`);
  order-book-server had misconfigured Root Directory / Dockerfile path settings. As of
  handover the fix is committed locally but Railway had not yet rebuilt from it.
- **Frontend hosting: not started.** Vercel deploy is runbook §4, untouched.
- **No liquidity seeded yet.** `scripts/demo/mm-sepolia-seed.ts` (commit `cecff84`)
  mints from the deployer's USDC and rests two-sided quotes via the order-book-server —
  it needs faucet USDC on the deployer and a running order-book-server to point at.
- **Audit: deliberately deferred** by the project owner. Not forgotten.

## Ops wallets and secrets

Keys live only in gitignored `.env` files (`.gitignore` now ignores all `.env*` except
`*.example` — this was tightened 2026-07-07 after backup copies nearly got committed).

| Wallet | Address | Key location | Roles |
|---|---|---|---|
| Deployer | `0x0D0917e418bc99Ecbfbd1Eb25a98d09CeFB580f1` | `contracts/.env` | DEFAULT_ADMIN, PAUSER |
| Keeper | `0x63F98358246D5860A5b4c85fBB7936494F4FeC54` | `backend/keepers/.env` | KEEPER_ROLE |
| Settler | `0x1a4A3796189a6aAB0E0D7fFFA111B5e90e3d98b9` | `backend/matching-engine/.env` | (none needed) |

RPC is public `https://sepolia.base.org`. Each wallet holds only dust ETH (~0.00015);
top up before heavy tx activity. Everything runs off raw EOAs — moving admin to a Safe
is a production-plan phase, not done.

**Gotcha:** `Deploy.s.sol` does NOT grant `KEEPER_ROLE`/`PAUSER_ROLE` — they were
granted manually post-deploy (commands in the runbook). A fresh deploy needs the same
manual grants or the keepers revert.

## Non-obvious semantics (each of these cost real debugging time)

- **YES/NO tokens report `decimals() == 18` but every amount in the system is raw
  6-decimal USDC scale.** Never add them as MetaMask custom tokens (display is off by
  1e12); never normalize by 1e18 in new code. All order/balance math is 6-dec.
- **`previewFunding` is NOT freeze-aware and does NOT fold in `fundingDebt`.** The
  order-book-server's min-sell check computes
  `fundingDebt(maker) − previewFunding(maker, fullYesBalance, true)` clamped at 0; the
  frontend's cure-cost estimate is built from `frozenFunding`/`fundingDebt`/`snapNO`
  directly. Do not "simplify" either back to a bare `previewFunding` call.
- **`CLOBSettlement.verifyAndSettle` takes `(Order, bytes, Order, bytes)` with a
  7-field Order and detached signatures — selector `0x538df8d8`.** The original backend
  encoded 8-field tuples with embedded sigs and every real settlement reverted; this
  was fixed in the v1b1 catch-up. Any new off-chain caller must match the 7-field shape.
- **`backend/keepers/tsconfig.json` only compiles `funding-keeper.ts`** — there is no
  `dist/` entry point for liquidation-keeper. Both keepers therefore run their `.ts`
  directly via `node -r ts-node/register`, which makes **ts-node a runtime dependency
  despite being a devDependency** (this is what crash-looped Railway; Dockerfiles now
  `npm ci --include=dev`).
- **order-book-server and matching-engine do NOT load dotenv.** Locally you must
  export env vars before launch (or use a wrapper); in Railway they come from service
  variables. The keepers historically ran locally with `node --env-file`.
- **`contracts/deployments/base-sepolia.json` is also an env-var fallback** read at
  startup by keepers and settler — but the file is not copied into the Docker images,
  so hosted services MUST set address env vars explicitly or they crash on boot.
- **PriceChart derives mark history from consecutive `FundingAccrued` events**
  (mark = ΔcumYES × 365d/Δt) plus a live `currentMark` tail — `setMark` emits no event,
  and `TokensMinted` is 2-arg (an older 4-arg chart ABI silently matched nothing).
- **TradePanel order expiry uses CHAIN time (`getBlock`), not wall clock** — required
  because demo chains are time-warped. Keep it that way.
- **The economics invariants in root `CLAUDE.md` are load-bearing.** In particular:
  never burn YES outside `redeem`/`settleYES` (complete-set invariant), never let cost
  basis into the seizure trigger, never erase `fundingDebt` without USDC moving. Tests
  encode these; if a change fights the tests, the change is wrong.

## Local dev environment quirks (this machine, WSL2)

- Foundry binaries are not on PATH: `~/.foundry/bin/forge|anvil|cast`.
- The local stack now runs against **Base Sepolia** on standard ports (frontend 3000,
  order-book 3001, keeper health 3002, liquidation-keeper 3003, system redis 6379).
  For throwaway stacks use fresh ports (anvil 8547, scratch redis 6380, etc.).
- `npm run build` in `frontend/` takes >5 min under WSL2; run long timeouts. Two
  `next dev` processes sharing one `.next` corrupt each other — the demo stack isolates
  via `NEXT_DIST_DIR=.next-demo`.
- Stale background processes from old sessions can linger (`ps aux | grep tsx` before
  trusting demo ports); beware `pkill -f` patterns matching your own process.
- The BD demo stack (`scripts/demo/demo-up.sh`, runbook `docs/demo-runbook.md`) is
  self-contained on ports 8547/3010–3013/6380 and safe to run alongside everything.

## Immediate next steps (in rough priority order)

1. Push `main` and redeploy the two keeper services on Railway; work through
   `docs/deploy-followups.md` until all four services are green.
2. Vercel frontend deploy (runbook §4). Get a real WalletConnect project ID FIRST:
   `frontend/lib/wagmi.ts` throws at config creation when
   `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` is unset and `NODE_ENV=production` (Vercel
   sets that automatically), hard-failing the whole app — the `'placeholder'` fallback
   only exists in local dev.
3. Seed liquidity: faucet USDC to the deployer, run `scripts/demo/mm-sepolia-seed.ts`
   against the hosted order-book-server.
4. Set `TRACKED_HOLDERS` on both keepers as real holders appear (hand-maintained list —
   the keepers only watch addresses they're told about; automatic holder discovery from
   chain events is the top production-plan gap and is launch-blocking for mainnet).
5. Then the production plan proper: Safe role ceremony, invariant/fuzz suite + audit,
   credit-event dress rehearsal on Sepolia.
