# Pari: MVP → Production — Minimum Incremental Build Plan

Status: approved for scope 2026-07-06. **Phase 1 is done** (2026-09-25); **Phase 2 is done
except the items still unticked below**; Phase 3 is half done (both contract guard-rails, the
invariant suite and the F1/F2/F4 fixes shipped in the 2026-10-01 batch-1 redeploy — the Safe
role ceremony, audit and legal read are open); Phase 4 not started. Items marked ✅ are
shipped. Last reviewed 2026-10-13.
Decisions locked: external audit (booked early, no budget cap set) · Railway hosting for
Phase 1 · `setMark` max-Δ bound and `depositCap` contract changes are in scope.

## Where we are

*Originally written 2026-07-06, when nothing had touched a real network. Current state
(2026-10-13):* **three markets are live on Base Sepolia** — MSTR (the batch-1 contract set,
redeployed 2026-10-01 with the unified `owed()` fix, `depositCap` and bounded `setMark`),
CoreWeave and Turkey (added 2026-10-03 via `AddMarket.s.sol` + `MarketRegistry`
`0xdF1A…5720`); all 22 contract addresses are verified on Blockscout. Five backend
services run on Railway in registry mode (order-book-server, matching-engine,
funding-keeper, liquidation-keeper, liquidator-bot), the frontend is live on Vercel in
registry mode, books are seeded, CI runs forge + vitest + frontend type-check on every
PR, and an hourly GitHub Actions uptime monitor covers every service plus hot-wallet gas.
See `docs/HANDOVER.md`. Still true: every `DEFAULT_ADMIN_ROLE`, `PAUSER_ROLE` and
OracleRouter attester role sits on the raw deployer EOA (requirement 2 — the biggest
open launch blocker we can build ourselves).

The one genuine correctness gap called out here originally — keepers only watching a
hand-maintained `TRACKED_HOLDERS` list — is closed: both keepers now discover YES holders
from `Transfer` events (requirement 1 below).

## Launch-blocking requirements

1. ✅ **Holder discovery from chain events** (2026-09-26, `backend/keepers/holder-index.ts`)
   — keepers must index YES holders from
   `Transfer`/`TokensMinted` events (startup backfill + live polling), replacing
   `TRACKED_HOLDERS`. Correctness, not polish.
2. **Key & role ceremony** — deploy a Safe (2-of-3). New `TransferRoles.s.sol` moves
   `DEFAULT_ADMIN_ROLE` on all seven contracts, `ORACLE_ROLE` (credit-event
   attestation), and `PAUSER_ROLE` to the Safe. Keeper and settler get dedicated
   low-balance hot EOAs holding only their operational role. Deployer renounces
   everything.
3. **Security gate** — Foundry **stateful invariant suite** encoding the 10 root-CLAUDE.md
   invariants (✅ built + mutation-tested 2026-09-26; found F1, a real collateral leak
   that must be fixed before mainnet — `docs/security/invariant-findings-2026-09-26.md`),
   Slither clean (✅ first pass
   2026-09-26: 0 real High/Medium — `docs/security/slither-2026-09-26.md`), and an **external
   audit** (see Phase 3). ✅ F1/F2/F4 fixed (unified `owed()`) and deployed in the 2026-10-01
   batch-1 redeploy; the suite now runs per market (2-market invariant suite, 201 forge tests).
   Audit: **deliberately deferred by the owner** — not booked yet. `depositCap` stays in regardless — audited code still launches
   capped; the cap rises with track record.
4. **Credit-event dress rehearsal on Base Sepolia** — full lifecycle on the public
   testnet with the real Safe flow: motion → pause → attest → settle, plus a live
   liquidation flag/cure/claim. (Testnet uses free faucet ETH + Circle faucet USDC —
   zero real-money exposure.)

## Phases

### Phase 1 — Real testnet (~1 week)

- ✅ Deploy to Base Sepolia with the existing `Deploy.s.sol` + `VerifyContracts.s.sol`
  (ready as-is); replace the stale Anvil `deployments/base-sepolia.json` with the real
  record.
- ✅ **Backend on Railway**: managed Redis (persistence on), order-book-server,
  matching-engine, funding-keeper + liquidation-keeper as services deployed from the
  repo; keeper `/health` endpoints wired to a free uptime monitor with alerting
  (`.github/workflows/uptime.yml` — hourly GitHub Actions check, failed-run email is the
  alert; funding-keeper is internal, so it is checked via on-chain `lastFundingTime`
  staleness; holder discovery via liquidation-keeper's `holderIndex.lastError`).
  (Chosen over a VPS for ramp speed — ~$10–20/mo; Fly.io is the equivalent alternative;
  a VPS migration later is cheap if cost ever matters.)
- ✅ Frontend to Vercel with a real WalletConnect project ID; make the `'placeholder'`
  fallback in `lib/wagmi.ts` fail loudly instead of silently shipping broken config.
- ✅ `.env.example` for every backend service and the frontend.
- ✅ GitHub Actions CI: `forge test`, vitest (both backend packages), `tsc --noEmit`
  (frontend) on every PR.
- **Book the audit slot** — *deferred by the owner, not booked (2026-10-13)* (lead time 2–6 weeks; ballpark $20–50k for seven small
  contracts at boutique firms; Cantina/Spearbit/Sherlock-style competitive review is the
  alternative channel).

### Phase 2 — Production hardening (~1–2 weeks, parallel with Phase 3)

- ✅ Holder indexing (requirement 1).
- ✅ Graceful shutdown on all services (drain in-flight settlement before exit;
  2026-09-26 — plus `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=30`).
- `/health` on order-book-server ✅ (checks Redis) and matching-engine (still none — it
  has no HTTP server; keepers already have one).
- Retry-and-alert wrapper on funding-keeper (today one RPC hiccup silently skips an
  epoch cycle's accrual — seizure checks now run even when accrual fails, 2026-09-26).
- ✅ **Liquidator of last resort** (not in the original plan): `backend/keepers/liquidator-bot.ts`
  claims every flagged position promptly and resells via the CLOB; live on Railway since
  2026-09-29 (multi-market since 2026-10-03), own hot wallet `0x941A…9661`. ✅ 2026-10-13:
  public read-only `/health` + hourly uptime check (claim loop freshness, USDC-float and
  InsuranceFund shortfall alerts) and a hot-wallet gas check for keeper/settler/liquidator.
- ✅ **Multi-market** (not in the original plan): MSTR + CoreWeave + Turkey, one contract
  set per market + `MarketRegistry`; cutover complete 2026-10-03 (`docs/multi-market-cutover.md`).
- ✅ Rate limiting on `POST /order` (+ `DELETE /order/:id`, per client IP,
  `@fastify/rate-limit`); ✅ CORS origin from env instead of `*` (`CORS_ORIGINS` on
  order-book-server and liquidation-keeper).
- Mainnet plumbing: viem `base` chain object in settler/keepers, `deployments/base.json`
  naming convention, foundry.toml `[rpc_endpoints]`/`[etherscan]` `base` entries,
  `deploy-mainnet` Makefile target with a chain-id guard and mainnet USDC constant,
  frontend 8453 entries in `lib/contracts.ts` / `lib/wagmi.ts` / `lib/constants.ts`.
- **Deliberately skipped**: structured logging/metrics stack, subgraph, private relay
  for liquidation MEV (documented-acceptable MVP limitation).

### Phase 3 — Security & governance (~1–2 weeks build + audit lead time)

- Requirements 2 and 3 (role ceremony, invariant suite, Slither, audit).
- ✅ **`setMark` bound** (contract change, batch-1 2026-10-01: ≤ 5 points per update, ≥ 1h
  apart, plus an admin override): on-chain max-Δ-per-update so a compromised
  keeper key can't teleport the mark; document the off-chain policy (TWAP of CLOB mid).
- ✅ **`depositCap`** (contract change, batch-1 2026-10-01): admin-settable cap enforced in
  `CreditMarket.mint`; 50,000 USDC per market.
- Size and fund the InsuranceFund (it backstops tail-case liquidations).
- **Legal/regulatory read (external, start day one)**: the product is economically a
  CDS on a named US corporate — CFTC swap-definition exposure needs a real opinion
  before mainnet.

### Phase 4 — Mainnet launch (~1 week)

- Deploy + verify via the hardened pipeline; run the role ceremony. Gate: the dress
  rehearsal (requirement 4) must be signed off on Sepolia first — **not yet done**; it
  depends on the Safe from requirement 2.
- Seed liquidity: simple two-sided quoting bot for the team wallet (adapt the demo
  market-maker) — without it there is no market.
- Write the two missing runbooks: deploy/rollback, and incident response (keeper down,
  Redis loss, pause procedure, credit-event procedure, key rotation).
- Launch under the deposit cap; raise as audit + track record allow.

## Execution notes

- Rough total: **4–6 weeks of build**; audit lead time overlaps Phases 2–3 if booked in
  Phase 1.
- Procedural workstreams (`.env.example`s, CI workflow, hosting config, runbook drafts,
  invariant-test scaffolding) are delegated to Sonnet subagents; correctness-sensitive
  work (holder indexing, role-transfer script, `setMark` bound, `depositCap`) stays with
  the lead session.
