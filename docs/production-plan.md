# Pari: MVP → Production — Minimum Incremental Build Plan

Status: **approved for scope, not yet in execution** (2026-07-06).
Decisions locked: external audit (booked early, no budget cap set) · Railway hosting for
Phase 1 · `setMark` max-Δ bound and `depositCap` contract changes are in scope.

## Where we are

The product is feature-complete and locally demoable (87 contract tests, 40 backend
tests, one-command demo stack), but it has **never touched a real network** —
`contracts/deployments/base-sepolia.json` currently holds Anvil addresses
(chainId 31337). There is no CI, no hosting config, no monitoring, and no mainnet
configuration anywhere (foundry.toml, viem chains, wagmi, and the frontend address map
are Sepolia-only). Every `DEFAULT_ADMIN_ROLE` sits on the raw deployer EOA.

One genuine correctness gap: the funding/liquidation keepers only watch a
hand-maintained `TRACKED_HOLDERS` env list — a YES (Upbet) holder not on the list never
gets flagged for liquidation, silently shifting tail risk onto the InsuranceFund.

## Launch-blocking requirements

1. **Holder discovery from chain events** — keepers must index YES holders from
   `Transfer`/`TokensMinted` events (startup backfill + live polling), replacing
   `TRACKED_HOLDERS`. Correctness, not polish.
2. **Key & role ceremony** — deploy a Safe (2-of-3). New `TransferRoles.s.sol` moves
   `DEFAULT_ADMIN_ROLE` on all seven contracts, `ORACLE_ROLE` (credit-event
   attestation), and `PAUSER_ROLE` to the Safe. Keeper and settler get dedicated
   low-balance hot EOAs holding only their operational role. Deployer renounces
   everything.
3. **Security gate** — Foundry **stateful invariant suite** encoding the 10 root-CLAUDE.md
   invariants (only parametrized fuzz exists today), Slither clean, and an **external
   audit** (see Phase 3). `depositCap` stays in regardless — audited code still launches
   capped; the cap rises with track record.
4. **Credit-event dress rehearsal on Base Sepolia** — full lifecycle on the public
   testnet with the real Safe flow: motion → pause → attest → settle, plus a live
   liquidation flag/cure/claim. (Testnet uses free faucet ETH + Circle faucet USDC —
   zero real-money exposure.)

## Phases

### Phase 1 — Real testnet (~1 week)

- Deploy to Base Sepolia with the existing `Deploy.s.sol` + `VerifyContracts.s.sol`
  (ready as-is); replace the stale Anvil `deployments/base-sepolia.json` with the real
  record.
- **Backend on Railway**: managed Redis (persistence on), order-book-server,
  matching-engine, funding-keeper + liquidation-keeper as services deployed from the
  repo; keeper `/health` endpoints wired to a free uptime monitor with alerting.
  (Chosen over a VPS for ramp speed — ~$10–20/mo; Fly.io is the equivalent alternative;
  a VPS migration later is cheap if cost ever matters.)
- Frontend to Vercel with a real WalletConnect project ID; make the `'placeholder'`
  fallback in `lib/wagmi.ts` fail loudly instead of silently shipping broken config.
- `.env.example` for every backend service and the frontend.
- GitHub Actions CI: `forge test`, vitest (both backend packages), `tsc --noEmit`
  (frontend) on every PR.
- **Book the audit slot now** (lead time 2–6 weeks; ballpark $20–50k for seven small
  contracts at boutique firms; Cantina/Spearbit/Sherlock-style competitive review is the
  alternative channel).

### Phase 2 — Production hardening (~1–2 weeks, parallel with Phase 3)

- Holder indexing (requirement 1).
- Graceful shutdown on all services (drain in-flight settlement before exit).
- `/health` on order-book-server and matching-engine (keepers already have one).
- Retry-and-alert wrapper on funding-keeper (today one RPC hiccup silently skips an
  epoch cycle).
- Rate limiting on `POST /order`; CORS origin from env instead of `*`.
- Mainnet plumbing: viem `base` chain object in settler/keepers, `deployments/base.json`
  naming convention, foundry.toml `[rpc_endpoints]`/`[etherscan]` `base` entries,
  `deploy-mainnet` Makefile target with a chain-id guard and mainnet USDC constant,
  frontend 8453 entries in `lib/contracts.ts` / `lib/wagmi.ts` / `lib/constants.ts`.
- **Deliberately skipped**: structured logging/metrics stack, subgraph, private relay
  for liquidation MEV (documented-acceptable MVP limitation).

### Phase 3 — Security & governance (~1–2 weeks build + audit lead time)

- Requirements 2 and 3 (role ceremony, invariant suite, Slither, audit).
- **`setMark` bound** (contract change): on-chain max-Δ-per-update so a compromised
  keeper key can't teleport the mark; document the off-chain policy (TWAP of CLOB mid).
- **`depositCap`** (contract change): admin-settable cap enforced in
  `CreditMarket.mint`, launch value ~$25–50k TVL.
- Size and fund the InsuranceFund (it backstops tail-case liquidations).
- **Legal/regulatory read (external, start day one)**: the product is economically a
  CDS on a named US corporate — CFTC swap-definition exposure needs a real opinion
  before mainnet.

### Phase 4 — Mainnet launch (~1 week)

- Deploy + verify via the hardened pipeline; run the role ceremony; dress rehearsal
  sign-off (requirement 4) already done on Sepolia.
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
