# Engineering Handover — Pari / credit-prediction-dex

*Last updated 2026-11-17. This doc holds current state, ops knowledge and open work that
are NOT derivable from the code. The product/economics spec — including the 10 hard
invariants — is the root `CLAUDE.md`; if code and that spec disagree, treat it as a bug.*

## Read these first

1. **Root `CLAUDE.md`** — product, economics, invariants, architecture, UI naming rules.
2. **`README.md`** — architecture diagram, repo layout, per-workspace setup/test.
3. **`docs/hosted-env-vars.md`** — every Railway/Vercel env var and the current addresses.
4. **`docs/redeploy-guide.md`** + the latest batch runbook (`docs/redeploy-batch3-runbook.md`)
   — how to redeploy contracts/services, with the gotchas below in runbook form.
5. **`docs/production-plan.md`** — the phased path to mainnet.
6. Per-directory `CLAUDE.md` in `contracts/`, `backend/`, `frontend/` — stack notes.

Historical records (read only when you need the background): `deploy-testnet.md`,
`deploy-followups.md`, `redeploy-batch{1,2}-runbook.md`, `multi-market-{design,cutover,local-rehearsal}.md`,
`partial-fills-plan.md`, `carry-formula.md`, `security/` (Slither triage, invariant findings
F1–F4 — all fixed).

## Current state

### Contracts — Base Sepolia (chainId 84532), batch 3, live since 2026-10-17

MarketRegistry **`0xA7bcc124aF821388886012B905Ba8cF4B79469b1`** (start block 48217498).
One full contract set per market; the InsuranceFund `0x1a0dB241…403b` is shared.

| Slug | CreditMarket | Seed mark |
|---|---|---|
| `mstr` | `0x89e54F5e5C996174D9d2e52dbf90589b2f355d3A` | 23% |
| `crwv` | `0xB6bc5e9FA166520536453FD667B79Fb705ca09b5` | 10% |
| `try` | `0xdD1202B077b9B89253006610F80DAD23B9fDf76e` | 2% |

- Full address sets: `contracts/deployments/base-sepolia/{core.json,markets/*.json}`
  (written by the deploy scripts — do not hand-edit). Every older contract set is paused and
  inactive, archived under `deployments/base-sepolia/archive/`.
- Per market: `depositCap` 50,000 USDC, keeper `setMark` ≤ 5 points per update and ≥ 1h
  apart (admin `adminSetMark` bypasses), fee 50 bps split 50/50 team wallet / InsuranceFund.
- Seed marks are placeholders until the owner supplies CDS-implied marks
  (`m = 1 − exp(−s/(1−R))`).
- **Nothing updates the marks automatically.** The keeper wallet holds `KEEPER_ROLE`, but
  no service calls `setMark`; marks move only by owner `adminSetMark`. Carry, the seizure
  trigger and the claim cap all run off that static mark (open work item 3).
- All 19 batch-3 contracts (+ the shared InsuranceFund) are source-verified on Blockscout
  (2026-11-17). Recipe for the next batch: `forge verify-contract <addr> src/<F>.sol:<C>
  --chain-id 84532 --verifier blockscout --verifier-url https://base-sepolia.blockscout.com/api
  --constructor-args $(cast abi-encode …)`, args from the CREATE tx `arguments` in
  `contracts/broadcast/<script>/84532/run-*.json`; one contract at a time, 20–45s apart.
  The Etherscan key in `contracts/.env` is rejected. Check status via
  `/api/v2/smart-contracts/<addr>` `is_verified` with curl (forge's poll is rate-limited;
  Python's default user agent gets 403).

Deploy history, for orientation: 2026-07-06 first deploy → 07-12 fee-aware CLOB → 10-01
batch 1 (unified `owed()` fix for F1/F2/F4, deposit cap, bounded `setMark`) → 10-03 multi-market
(registry, CoreWeave + Turkey) → 10-15 batch 2 (carry = −(1−m)·ln(1−m)) → 10-17 batch 3
(partial fills, on-chain cancel, pro-rata carry debt, 1-Upbet minimum). Each batch was a
full redeploy under a new registry, because CreditMarket changed.

### Hosting — all green

- **Railway** project "exciting-embrace" (`01235b60-cb1d-491c-8e60-4ab307ed5a33`,
  environment "production"), GitHub-connected: **every push to `main` redeploys all
  services** — merging a PR is a testnet deploy. Services (all in registry mode) + managed Redis:

  | Service | Public read-only URL |
  |---|---|
  | order-book-server | https://order-book-server-production-9bb6.up.railway.app (`/health`, `/orderbook`, …) |
  | matching-engine | https://matching-engine-production-f04c.up.railway.app/health |
  | liquidation-keeper | https://liquidation-keeper-production.up.railway.app (`/health`, `/claimable`) |
  | liquidator-bot | https://liquidator-bot-production-1939.up.railway.app/health |
  | funding-keeper | internal only — liveness = on-chain `lastFundingTime` |

  Keepers use `RAILWAY_DOCKERFILE_PATH=Dockerfile.<service>`. The liquidator bot logs only
  when it claims — use `/health`, not its logs, for liveness.
- **Vercel**: https://credit-prediction-dex.vercel.app — project `prj_36XAv69jCZ9ggcn7TmKBfEe4PJgW`
  (team `team_XxmRZcymUCsKZVReO7HQkYAj`), `rootDirectory=frontend`, pushes to `main`
  auto-deploy. Env vars per `docs/hosted-env-vars.md` (incl. `NEXT_PUBLIC_LOGS_RPC_URL`
  = publicnode, because `sepolia.base.org` caps `eth_getLogs` at 200 blocks).
- **Uptime**: `.github/workflows/uptime.yml` — scheduled hourly (GitHub actually fires it
  ~4–5×/day) plus manual dispatch. It checks every `/health` above (incl. the matching-engine
  loop and `settlerWired`, and the holder-index error), the frontend, funding-keeper
  staleness via `lastFundingTime`, the liquidator float vs the InsuranceFund, and hot-wallet
  gas. A failed run's GitHub email is the alert. 232 runs, 0 failures as of 2026-11-17.
  Update the address/URL constants at the top of the workflow after any redeploy.
- **Liquidity**: the deployer quotes resting ladders on each book via
  `scripts/demo/mm-sepolia-seed.ts --market <slug>` (re-seeded after every batch).

### Tests and CI

`.github/workflows/ci.yml` runs on every PR and push to `main`: `forge test` (233 tests,
incl. single- and 2-market stateful invariant suites), vitest for order-book-server (131),
matching-engine (94) and keepers (243), and a frontend type-check (the frontend has no test
suite). Local end-to-end: `scripts/smoke/run-smoke.sh` (multi-market anvil smoke, 12/12,
≈1 min). Counts as of PR #17 (2026-10-16).

## Ops wallets and access

Keys live only in gitignored `.env` files (`.gitignore` ignores every `.env*` except
`*.example`). Everything runs off raw EOAs — moving admin to a Safe is open work (below).

| Wallet | Address | Key location | Roles | Balance 2026-11-17 |
|---|---|---|---|---|
| Deployer | `0x0D0917e418bc99Ecbfbd1Eb25a98d09CeFB580f1` | `contracts/.env` | DEFAULT_ADMIN everywhere, PAUSER, OracleRouter attester, team wallet | 0.00116 ETH, 17.9 USDC |
| Keeper | `0x63F98358246D5860A5b4c85fBB7936494F4FeC54` | `backend/keepers/.env` | KEEPER_ROLE | 0.00249 ETH |
| Settler | `0x1a4A3796189a6aAB0E0D7fFFA111B5e90e3d98b9` | `backend/matching-engine/.env` | CLOBSettlement OPERATOR_ROLE (only it can fill) | 0.00714 ETH (topped up 2026-11-17) |
| Liquidator | `0x941A8B4707ccC1f9811DE3fFE7937dFe22e59661` | Railway `liquidator-bot` var only | none (`claim()` is permissionless) | 0.0015 ETH, 30 USDC float |
| Test taker | `0x3fB5c914c574eefbe32b3a8AA882cdc13Dfe2c0C` | `contracts/.env` `TEST_TAKER_PRIVATE_KEY` | none — used by `sepolia-test-trade.ts` / `sepolia-cancel-check.ts`; ignore it as a holder | — |

InsuranceFund holds 2.0 USDC. The uptime workflow fails when keeper < 0.0005, settler <
0.0001 or liquidator < 0.0002 ETH. A fill costs ≈2e-6 ETH; an accrual less. RPC is public
`https://sepolia.base.org` (it can lag a block behind a receipt — re-read before trusting
`remaining()` right after a tx).

`Deploy.s.sol` / `AddMarket.s.sol` grant KEEPER, PAUSER, attester and OPERATOR roles
themselves and assert every grant after broadcast — no manual post-deploy grants.

**Access from this machine (WSL2):**
- **GitHub**: fetch and push work (re-verified 2026-11-17: `git ls-remote` + an
  authenticated `git push --dry-run`), via a fine-grained repo-scoped PAT in
  `credential.helper store`. The GitHub MCP server has its own PAT (PR create/read works).
  `gh` is not installed. Never force-push `main`; merging stays the owner's call.
- **Railway CLI**: session auth (`railway login`), repo dir linked to
  `exciting-embrace/production`. `railway variable delete` does not redeploy (`--set` does).
  `railway ssh` is unavailable (no SSH key registered).
- **Vercel**: no CLI (WSL DNS broke `npm install -g`); env changes go through the dashboard.
- **Claude Code's auto-mode classifier blocks** `forge script --broadcast`, `railway variable
  set`, hosted-Redis flushes and Railway domain changes — the owner runs those as `!`
  commands. Seed scripts, test trades and read-only `cast` calls are allowed. Network
  commands need the sandbox disabled.

## Non-obvious semantics (each cost real debugging time)

- **Spec-level gotchas live in root `CLAUDE.md`** — re-read them before touching signing or
  settlement code: the 18-vs-6 decimals quirk, the exact `fillOrders` ABI shape (an 8-field
  tuple once made every settlement revert), `previewFunding` excluding `fundingDebt`, the
  three fee-math copies that must change together, and NO buys signing a GROSS `amountIn`
  (the original seed script got this wrong).
- **The EIP-712 domain is per CLOBSettlement address.** Any CLOB redeploy invalidates every
  resting order: flush the hosted Redis order keys, or orders fail signature checks with no
  obvious error.
- **Nonces are millisecond timestamps** so `setMinNonce(Date.now())` cancels everything
  signed so far; TradePanel order *expiry* uses chain time (`getBlock`), because demo chains
  are time-warped.
- **forge-script gotchas:** a DRY RUN of the old redeploy scripts rewrote the deployments
  JSON (the new scripts write `deployments/<net>/…` only under `--broadcast`); and ANY
  broadcast on chain 84532 — including local anvil/fork rehearsals — overwrites
  `contracts/broadcast/<script>/84532/run-latest.json`. Back up `contracts/broadcast` before
  rehearsing.
- **Keepers run `.ts` directly via `node -r ts-node/register`**, so ts-node is a runtime
  dependency despite being a devDependency (Dockerfiles `npm ci --include=dev`).
- **order-book-server and matching-engine do NOT load dotenv** — export env vars locally;
  Railway injects them. Hosted services must set every address/registry var explicitly
  (the deployments JSON is not in the Docker images).
- **Holder discovery** (`backend/keepers/holder-index.ts`) indexes YES `Transfer` recipients
  from each market's registry `startBlock` (NOT `registeredAt`; legacy mode needs
  `HOLDER_INDEX_FROM_BLOCK` — never scan from genesis). The set only grows (a missing holder
  is the dangerous failure, so there is deliberately no pruning). State lives in Redis
  (`holder-index:<chainId>:<yes token>:*`); the cursor only moves forward, each sync re-scans
  64 blocks for reorg safety, and `HOLDER_INDEX_CHUNK_SIZE=200` matches the public RPC's
  `eth_getLogs` cap. `refresh()` never blocks a keeper cycle on the initial backfill (a failed
  backfill retries every 30s); both keepers' `/health` report `holderIndex`.
- **funding-keeper's cycle has two independent phases** — accrue, then seizure-check every
  holder; the check runs even if the accrual failed (against the stored index, since
  `isSeizable` excludes funding pending since `lastFundingTime`). `/health` `lastRunAt` means
  last SUCCESSFUL accrual. order-book-server `/health` shows `fee.source: env-fallback` when
  the live fee read fails.
- **order-book-server rate-limits mutations per client IP** and needs `TRUST_PROXY=2` on
  Railway (two proxy hops — measured; see `docs/hosted-env-vars.md`).
- **All services drain on SIGTERM** within `SHUTDOWN_TIMEOUT_MS` (25s) inside Railway's
  `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30` — keep that ordering. Railway briefly OVERLAPS old
  and new deployments, so a pair can be re-submitted while the old process is still
  settling it; the chain rejects the replay (`FillExceedsRemaining` / `OrderInvalidated`) and the
  settler re-reads `remaining()` to prune at 0 or resync `filled` — never a blind delete.
- **Multi-market plumbing:** `backend/shared/registry.ts` is the ONE registry reader; each
  service holds an identical copy (per-service Docker contexts) — edit the canonical file and
  run `backend/shared/sync-registry.sh`; CI fails on drift. No `MARKET_REGISTRY_ADDRESS` =
  legacy one-market `mstr` mode. The order-book legacy-key migration is a recurring sweep
  because of the Railway overlap. Since batch 3 `fillOrders` itself rejects any pair that isn't
  {USDC, this market's YES/NO} (`MismatchedPair` / `InvalidTokenPair`); the order-book server,
  settler and frontend keep their own checks as defence in depth.
- **PriceChart draws the mark from `MarkUpdated` events** (a stepped line; timestamps from the
  same-block `FundingAccrued`) plus a live `currentMark` tail. Its log queries go to
  `NEXT_PUBLIC_LOGS_RPC_URL` because of the 200-block `eth_getLogs` cap.

## Local dev environment (this machine, WSL2)

- Foundry is not on PATH: `~/.foundry/bin/forge|anvil|cast`. `jq` and `gh` are not installed.
- Standard ports run against Base Sepolia (frontend 3000, order-book 3001, keeper health
  3002/3003, redis 6379). Throwaway stacks use fresh ports (anvil 8547, redis 6380…); the
  BD demo stack (`scripts/demo/demo-up.sh`, `docs/demo-runbook.md`) is self-contained on
  8547/3010–3013/6380.
- `npm run build` in `frontend/` takes >5 min; two `next dev` processes sharing one `.next`
  corrupt each other (isolate with `NEXT_DIST_DIR`).
- Stale background processes can linger across sessions (`ps aux | grep tsx`); a `pkill -f`
  pattern can match your own shell.

## Open work, in priority order

1. **Safe role ceremony** (production-plan requirement 2 — the largest launch blocker we can
   build ourselves). Nothing written yet: deploy a 2-of-3 Safe; write `TransferRoles.s.sol`
   to move `DEFAULT_ADMIN_ROLE` on every per-market contract + MarketRegistry +
   InsuranceFund, the OracleRouter attester role and `PAUSER_ROLE` to the Safe; keeper and
   settler keep only their operational role on dedicated hot EOAs; the deployer renounces
   everything. Fold in the deploy-script fix below.
2. **Credit-event dress rehearsal on Sepolia** (requirement 4) — motion → pause → attest →
   settle, plus a live flag → cure and flag → claim, run through the Safe. Gate for mainnet.
3. **Mark updater** — no service moves the mark (see "Current state"). The BD deck (v4)
   tells investors the keeper updates it from the market. Either build it (e.g. funding-keeper
   pushes a TWAP of the CLOB mid via `setMark`, inside the on-chain ≤ 5-point / ≥ 1h bound —
   the policy production-plan Phase 3 already names) or change the deck copy. Land it before
   the audit so the audit covers it.
4. **Credit-event motion + post-event liquidation bug** — gate for the dress rehearsal.
   Found 2026-11-18: on batch 3 nobody can open a motion (only the OracleRouter holds
   CreditMarket `ORACLE_ROLE`; the router forwards only `confirmCreditEvent`), AND
   confirmation alone does not block flag/claim — a liquidator could seize an Upbet about to
   pay $1 at the stale mark (proof-of-concept test: ~951 USDC net per 1,000 Upbets).
   Fixed in code (branch `fix/post-event-liquidation-guard`: on-chain post-event guards,
   `OracleRouter.setMotionPending`, keeper/bot skips, `/admin` motion control); deploys as
   **batch 4** (`docs/redeploy-batch4-runbook.md`). Until then, batch-3 stop-gap (OWNER):
   `forge script script/GrantMotionRole.s.sol --broadcast` (simulated OK 2026-11-18) and follow
   `docs/credit-event-runbook.md` §7. Also confirm each launch name has ISDA DC coverage —
   the deck claims it.
5. **Audit** (deliberately deferred by the owner — not forgotten) and an external
   **legal/regulatory read** (economically a CDS on named entities — CFTC swap exposure).
6. **InsuranceFund sizing** — it holds 2 USDC and backstops every market's tail-case claims.
7. **Runbooks** for mainnet: deploy/rollback and incident response (keeper down, Redis
   loss, pause, credit event, key rotation).

### Before any Base MAINNET deploy (owner: "not in a rush")

Mainnet *plumbing* exists (`CHAIN_ID=8453`, `RPC_URL`, `NEXT_PUBLIC_CHAIN_ID`, `make
deploy-mainnet` with a chain-id + `CONFIRM_MAINNET=yes` guard, mainnet USDC pinned in
`Deploy.s.sol`) but has never run against 8453.

- **Unsafe ops-address defaults** — `Deploy.s.sol:104-108` and `MarketScriptBase.sol:83-87`
  (used by `AddMarket.s.sol`): `KEEPER_ADDRESS` falls back to the **Sepolia keeper EOA**
  (key in local `.env` files), `OPERATOR_ADDRESS` to the Sepolia settler, and
  `PAUSER_ADDRESS` / `ORACLE_ATTESTER_ADDRESS` / `TEAM_WALLET` to the deployer EOA. Make all
  five REQUIRED on chain 8453, the way USDC is pinned.
- **`make deploy-mainnet` runs `Deploy.s.sol`** (one market + InsuranceFund, the batch-1
  shape). The multi-market path is `Deploy.s.sol` → `DeployMarketRegistry.s.sol` →
  `AddMarket.s.sol` per extra market; decide the mainnet sequence and script it.
- Fresh mainnet hot wallets (keeper, settler, liquidator) — never reuse testnet keys.
- Pick a mainnet RPC provider; fork-rehearse the full deploy sequence on a Base mainnet
  fork (`anvil --fork-url $BASE_RPC_URL`) before broadcasting.
- Gates: Safe ceremony, dress rehearsal, audit + legal read (items 1, 2 and 5 above); a
  two-sided quoting bot for the team wallet (adapt `mm-sepolia-seed.ts`).

## BD deck and presentation material

The GitHub repo is **public**, so investor decks, brand guidelines, design handoffs and any
other presentation material stay **outside git** (`.gitignore`: `Pari BD Deck*.html`,
`Pari Brand Guidelines*.html`, `*.zip`, `*.pptx`, `*.key`). Local copies sit in the repo root
(backup: `~/pari-local-backup/`); the current deck is `Pari BD Deck v4.html` (November 2026).

History purge done 2026-11-18 (git filter-repo + force-push of every branch): `Pari BD Deck
v2.html`, `Pari Brand Guidelines.html` and `Pari design2dev handoff.zip` are gone from all
branches, and every commit SHA before that date changed. GitHub's read-only `refs/pull/1–20/head`
still point at the old commits (e.g. `2fe49c3`), so the files stay reachable by direct SHA
link until GitHub Support purges them. The deck's mark-updater claim is still unbacked (open
work item 3).
