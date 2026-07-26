# Engineering Handover — Pari / credit-prediction-dex

*Written 2026-07-07, updated 2026-07-19, at the point of handing the project to the next
engineer. This doc captures state and tribal knowledge that is NOT derivable from the code
or the other docs. Read it alongside — not instead of — the canonical references below.*

## Read these first, in this order

1. **Root `CLAUDE.md`** — the canonical product/economics spec: token model, funding
   model, seizure trigger, liquidation math, the 10 hard invariants, trading fee, UX
   naming rules (YES/NO are internal names; the UI says Upbet/Downbet — never leak
   internal terms into UI copy). If code and this spec disagree, treat it as a bug in
   the code.
2. **`README.md`** — architecture diagram, repo layout, per-workspace setup/test.
3. **`docs/deploy-testnet.md`** — the testnet deploy runbook (contracts → Railway →
   Vercel). Both hosting legs are now live — see "State at handover" below.
4. **`docs/deploy-followups.md`** — issues hit during the initial Railway deploy + fix
   plan (all resolved; kept as an incident record).
5. **`docs/hosted-env-vars.md`** — current source of truth for every Railway/Vercel env
   var, including the post-fee-redeploy contract addresses.
6. **`docs/production-plan.md`** — the phased path to mainnet (holder discovery, role
   ceremony, invariant suite/audit, dress rehearsal).
7. Per-directory `CLAUDE.md` in `contracts/`, `backend/`, `frontend/` — stack notes.

## State at handover

- **Contracts: live on Base Sepolia** (chainId 84532) since 2026-07-06, all 7 deployed
  and Basescan-verified. Addresses: `contracts/deployments/base-sepolia.json` (tracked;
  do not hand-edit). Initial mark set to 23%.
- **Trading fee shipped 2026-07-11** (commit `9f5223e`): 50 bps × min(p, 1−p) × Q,
  charged only on the carry-earning side (YES sells + NO buys), split 50/50 team
  wallet/InsuranceFund, admin-editable via `CLOBSettlement.setFeeConfig`
  (`MAX_FEE_BPS = 500`). This required a **new CLOBSettlement deployment** — see
  "Non-obvious semantics" below for the redeploy gotchas. Fee-aware CLOBSettlement went
  live on Base Sepolia 2026-07-12 (commit `141c4d3`,
  `script/RedeployCLOBSettlement.s.sol`) at `0xC31702C1C2c41FcCb57446E0fda5091412bccB8e`;
  the pre-fee address `0x94f0D62B1749C627f1669Ef2d757b096825A84c2` is now role-less and
  dead. Fee config live on-chain: 50 bps, `insuranceShareBps` 5000 (50/50), team wallet =
  deployer. Current addresses for every contract: `docs/hosted-env-vars.md`.
- **Tests: green.** 98 Foundry tests (`cd contracts && forge test`), 55 Vitest tests
  across the three backend services, plus a 20/20 anvil fee smoke test. Frontend has no
  test suite — CI type-checks only.
- **Backend hosting: GREEN since ~2026-07-16.** Railway project "exciting-embrace"
  (ID `01235b60-cb1d-491c-8e60-4ab307ed5a33`, environment "production"), GitHub-connected
  to `axedbuyer/credit-prediction-dex` — all four services rebuild automatically on push
  to `main`. All services Online: `order-book-server` (public,
  https://order-book-server-production-9bb6.up.railway.app, health = `GET /orderbook`),
  `matching-engine` (internal, settler wired), `funding-keeper` (internal,
  `RAILWAY_DOCKERFILE_PATH=Dockerfile.funding-keeper`), `liquidation-keeper` (public,
  https://liquidation-keeper-production.up.railway.app,
  `RAILWAY_DOCKERFILE_PATH=Dockerfile.liquidation-keeper`), plus managed Redis. CORS is
  `*` on both public services. A dead scaffold service named "credit-prediction-dex"
  inside the project, and a separate stray scaffold project "fortunate-warmth", were both
  deleted 2026-07-19 — if either name resurfaces in a screenshot or old note, it's gone.
  Railway CLI on this machine is authenticated via `railway login` (session auth — an API
  token approach failed) and the repo dir is railway-linked to
  `exciting-embrace/production`. Env-var source of truth: `docs/hosted-env-vars.md`.
- **Frontend hosting: LIVE on Vercel since 2026-07-19.**
  https://credit-prediction-dex.vercel.app — project "credit-prediction-dex"
  (`prj_36XAv69jCZ9ggcn7TmKBfEe4PJgW`, team `team_XxmRZcymUCsKZVReO7HQkYAj`), git-linked
  to the repo with `rootDirectory=frontend`, framework `nextjs`; pushes to `main`
  auto-deploy production, no token needed for ordinary code deploys. All 12 env vars from
  `docs/hosted-env-vars.md` are set, including a real
  `NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID` (the old "get a WalletConnect ID first" blocker
  is resolved) and the two Railway public URLs. Project setup itself was done via the
  Vercel REST API with a user-supplied token used inline only (not stored; may since be
  revoked) — any future env-var changes go through the Vercel dashboard or a fresh token.
  The Vercel CLI was never installed on this machine — WSL2 DNS flakiness broke
  `npm install -g`.
- **Liquidity seeded 2026-07-19** on the hosted book via
  `scripts/demo/mm-sepolia-seed.ts` run against the Railway order-book URL: deployer as
  maker, 7 resting quotes around the 23% mark (YES bids 20¢/22¢, asks 24¢/26¢; NO bid
  75¢, asks 77¢/79¢; 4 tokens per level). The script's NO-bid fee bug (it was signing a
  net rather than gross `amountIn`) was fixed in commit `b1a2e08`; the one live
  mis-priced bid from before the fix was cancelled and re-rested correctly.
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

**GitHub pushes from this machine:** no stored credentials. The user supplies a PAT used
inline per-push; the GitHub MCP API is the fallback if that's unavailable.

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
- **A `forge script` DRY RUN of a redeploy script still writes
  `contracts/deployments/base-sepolia.json`.** `RedeployCLOBSettlement.s.sol`'s dry run
  rewrote the deployments file with the new CLOBSettlement address *before* the real
  broadcast ran; because both runs used the same nonce, the subsequent broadcast then
  read "old address" back as its own about-to-be-deployed address and self-revoked the
  roles it had just granted itself — recovered with six manual `cast send` role txs. The
  script now guards `oldClob != newClob` before revoking.
  Treat any redeploy script the same way: don't trust the deployments JSON as "old" state
  until you've confirmed no dry run touched it first.
- **The CLOBSettlement EIP-712 domain is per-contract-address**, so redeploying
  CLOBSettlement (as the 2026-07-12 fee redeploy did) invalidates every resting
  order/nonce signed against the old address. Any Redis-held orders from before a
  CLOBSettlement redeploy must be flushed — they'll fail signature verification
  silently-looking (the server won't know why fills stop matching) rather than loudly.
- **Three fee-math implementations must stay in lockstep, plus two env vars:**
  `CLOBSettlement.tradeFee` (Solidity, source of truth), `backend/order-book-server/src/fee.ts`,
  and `frontend/lib/feeMath.ts` all implement the same fee formula (the two TS mirrors
  additionally carry the `minGrossForNet` inversion, which has no on-chain counterpart).
  `FEE_BPS` (backend) and `NEXT_PUBLIC_FEE_BPS` (frontend) must mirror the chain's live
  `feeBps` — overstating skips marginal crosses, understating causes `SlippageExceeded`
  reverts. There is no single source these three read from at runtime; a fee-bps change
  on-chain means updating all three by hand.
- **NO buys sign a GROSS fee-inclusive `amountIn`, not net.** The contract can only pull
  exactly the signed `amountIn`, so the buyer's order must already include the fee
  (computed via the `minGrossForNet` piecewise inversion); a NO bid signed at its net
  intended price rests below where the trader actually meant it to rest. This bit the
  original `scripts/demo/mm-sepolia-seed.ts` (fixed in commit `b1a2e08`) — check any new
  order-signing code for the same mistake.
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

Railway green-up, the Vercel deploy, and liquidity seeding are all done (see "State at
handover" above) — removed from this list.

1. Keep `TRACKED_HOLDERS` current on both keepers as real holders appear (still
   hand-maintained — the keepers only watch addresses they're told about). Phase 2
   holder discovery from chain events is the real fix and is launch-blocking for
   mainnet (`docs/production-plan.md`, "Launch-blocking requirement #1").
2. The production plan proper: Safe role ceremony (admin/keeper roles currently sit on
   raw EOAs — see "Ops wallets and secrets" above), invariant/fuzz suite + audit (audit
   still deliberately deferred by the owner, not forgotten), credit-event dress
   rehearsal on Sepolia.
3. Optional ops polish (log aggregation, alerting, etc. — nothing blocking).

For redeploying contracts or services after a code change, use `docs/redeploy-guide.md`
— it captures the dry-run and EIP-712 domain-invalidation gotchas above in runbook form.
