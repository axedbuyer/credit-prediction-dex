# Pari — Tradable Credit For All

A fully-collateralized perpetual prediction market on corporate credit default
probability, built on Base. The MVP market asks a single question:

> **"Will MicroStrategy have a credit event in the next 12 months?"**

Users deposit USDC and mint YES/NO ERC-20 "complete sets" 1:1, trade them on a
Polymarket-style off-chain CLOB with atomic on-chain settlement, and the market price of
YES is the crowd's implied annual default probability. Positions are economically
equivalent to a zero-recovery perpetual CDS, presented as a prediction market. (The
product UI calls YES/NO "Upbet"/"Downbet" — see `CLAUDE.md` for the full naming
convention. This README uses the internal YES/NO names, which is also what the code,
ABIs, and API fields use.)

- **Complete sets:** depositing `N` USDC mints `N` YES + `N` NO; redeeming an equal
  YES+NO pair returns `N` USDC (pre-settlement). `YES.totalSupply() == NO.totalSupply()`
  always.
- **Settlement:** on a confirmed credit event, YES redeems $1 each (full notional, zero
  recovery); NO redeems $0.
- **Funding/carry:** YES holders pay ongoing funding to NO holders (like a CDS premium),
  tracked via on-chain cumulative-index accounting (`cumulativeFundingPerYES` /
  `cumFundingPerNO`) and a persistent per-user `fundingDebt` ledger so debts are never
  silently forgiven.
- **Liquidation:** a solvency-based seizure trigger (`m ≤ 1.03 × f_next`, evaluated one
  epoch ahead — cost-basis-independent) flags underfunded YES positions. Claiming is
  formulaic (no Dutch auction): the YES token *transfers* to the liquidator (never
  burned), NO is always made whole (InsuranceFund tops up the rare tail case).
- **No leverage, no protocol token, no LP vault** in the MVP — fully collateralized,
  team wallet seeds liquidity.

The full funding/liquidation model (display-layer math, freeze semantics, worked
examples, and the 10 hard invariants) is specified canonically in the root
[`CLAUDE.md`](./CLAUDE.md) — this README only summarizes it.

## Status

- 87 Foundry contract tests, 79 off-chain (Vitest) tests across the three backend
  services, plus a manual 12/12 end-to-end anvil smoke script covering the full
  mint → trade → funding → freeze/cure → liquidation → credit-event lifecycle.
- **Live on Base Sepolia** (chain ID `84532`) as of 2026-07-06 — all 7 contracts
  deployed and verified. See [`contracts/deployments/base-sepolia.json`](./contracts/deployments/base-sepolia.json)
  for the current address record and [`docs/deploy-testnet.md`](./docs/deploy-testnet.md)
  for the full deploy/hosting runbook (contracts, Railway backend, Vercel frontend).
- Not yet on Base mainnet. See [Roadmap](#roadmap-status) below.

## Architecture

```
                     ┌─────────────────────────┐
   wallet (user) ───▶│   Frontend (Next.js 14) │
                     │  /market /portfolio      │
                     │  /liquidate /admin       │
                     └───────────┬─────────────┘
                                 │ REST (poll)         EIP-712 signed orders
                 ┌───────────────┼──────────────────────────┐
                 ▼               ▼                          ▼
        ┌─────────────────┐ ┌──────────────────┐   (direct tx: mint/redeem/
        │ order-book-server│ │ matching-engine  │    cure/claim/settleYES)
        │  REST, Redis     │◀│ price-time match │
        │  pre-filters     │ │ submits matched   │
        │  frozen/short-   │ │ pairs on-chain    │
        │  fall orders     │ └────────┬─────────┘
        └──────────────────┘          │ verifyAndSettle(...)
                                      ▼
   ┌──────────────────────────────────────────────────────────────┐
   │                      On-chain (Base / Base Sepolia)           │
   │                                                                │
   │  CreditMarket.sol  ── mint/redeem/settleYES, funding ledger,   │
   │                       seizure trigger (isSeizable), freeze/cure│
   │  YESToken / NOToken.sol ── ERC-20, CLOB_ROLE-restricted xfers  │
   │  CLOBSettlement.sol ── verifies EIP-712 orders, atomic swap    │
   │                        + funding settlement                   │
   │  OracleRouter.sol   ── credit-event attestation → settlement   │
   │  LiquidationEngine.sol ── formulaic claim(); YES transfers,    │
   │                           never burned                        │
   │  InsuranceFund.sol  ── USDC reserve, tail-case top-up          │
   └──────────────────────────────────────────────────────────────┘
                 ▲                              ▲
                 │ accrueFunding / flagClaimable │ GET /claimable
        ┌─────────────────┐            ┌──────────────────────┐
        │ funding-keeper   │            │ liquidation-keeper    │
        │ (KEEPER_ROLE)    │            │ (read-only, permission│
        │ cron every epoch │            │ -less claim by anyone)│
        └─────────────────┘            └──────────────────────┘
```

`oracle-monitor` is a placeholder service for an eventual ISDA Determinations Committee
scraper; credit events are attested manually via a multisig in the MVP.

## Repo layout

```
contracts/    Foundry project (Solidity 0.8.24, OpenZeppelin v5). Contracts in src/,
              tests in test/, deploy scripts in script/, deployed addresses in
              deployments/. See contracts/CLAUDE.md.
backend/
  order-book-server/  Fastify REST API + Redis order book, on-chain pre-filter (viem)
  matching-engine/    price-time-priority matcher, submits settlement on-chain
  keepers/            funding-keeper (accrual + flagging cron) and
                      liquidation-keeper (read-only /claimable API)
              See backend/CLAUDE.md.
frontend/     Next.js 14 App Router, wagmi v2 + viem + RainbowKit, Tailwind,
              TradingView Lightweight Charts. See frontend/CLAUDE.md.
scripts/demo/ One-command local demo stack (anvil fork, seeded order book, scripted
              "beats" for trade/cure/claim/credit-event) — see docs/demo-runbook.md.
docs/         Deploy runbook, production/mainnet plan.
```

Each of `contracts/`, `backend/`, `frontend/` has its own `CLAUDE.md` with
directory-specific stack notes; the root `CLAUDE.md` is the canonical product/economics
spec (funding model, invariants, UX naming conventions).

## Getting started

### Prerequisites

- [Foundry](https://book.getfoundry.sh/) (`forge`, `cast`, `anvil`) — not npm-installed;
  see the [Foundry installation guide](https://book.getfoundry.sh/getting-started/installation).
- Node.js 20+
- Redis (for `order-book-server`; a system install or `redis-server --port <port>` for a
  scratch instance)

There is no root `package.json` / workspace tool — each of `contracts/`,
`backend/order-book-server/`, `backend/matching-engine/`, `backend/keepers/`, and
`frontend/` is installed and run independently.

### Install & build

```bash
# Contracts
cd contracts
git submodule update --init --recursive   # openzeppelin-contracts, forge-std
forge build

# Each backend service (repeat for order-book-server, matching-engine, keepers)
cd backend/order-book-server && npm install
cd backend/matching-engine    && npm install
cd backend/keepers            && npm install

# Frontend
cd frontend && npm install
```

### Test

```bash
cd contracts && forge test -vvv        # 87 tests
cd backend/order-book-server && npm test
cd backend/matching-engine    && npm test
cd backend/keepers            && npm test    # covers both funding- and liquidation-keeper
cd frontend && npm run type-check            # no Vitest suite here; CI runs tsc --noEmit
```

CI (`.github/workflows/ci.yml`) runs `forge test`, all three backend `npm test` jobs, and
the frontend type-check on every push/PR to `main`.

### Run the full stack locally (manual, against a Base Sepolia fork)

See [`Run MVP locally.txt`](./Run%20MVP%20locally.txt) for the exact commands: `anvil
--fork-url $BASE_SEPOLIA_RPC_URL`, `forge script script/DeployLocal.s.sol`, then
`order-book-server`, `matching-engine`, `keepers`, and `frontend` each in their own
terminal via `npm run dev`. `.env.example` files under `contracts/` and each `backend/*`
service document the required variables; `frontend/.env.local.example` covers the
frontend's `NEXT_PUBLIC_*` vars.

### One-command demo stack

`scripts/demo/` spins up an isolated anvil chain (non-default ports, e.g. `:8547`),
deploys fresh contracts, seeds a realistic order book, price history, a resting position,
a distressed (near-liquidation) position, and an already-flagged position, then starts
all backend services and the frontend on `http://localhost:3010`:

```bash
cd scripts/demo
./demo-up.sh      # ~1-2 minutes; prints all addresses + demo wallet keys
./warp.sh 3       # advance chain time N days, accrue funding, auto-flag if triggered
./demo-down.sh    # tear down, restore tracked files touched by the demo
```

Full walkthrough (what to click, in what order) is in
[`docs/demo-runbook.md`](./docs/demo-runbook.md).

## Deployment

Base Sepolia is live — see [`docs/deploy-testnet.md`](./docs/deploy-testnet.md) for the
complete runbook (contract deploy + role wiring, Railway backend services, Vercel
frontend, smoke checklist) and
[`contracts/deployments/base-sepolia.json`](./contracts/deployments/base-sepolia.json)
for the current contract addresses. Do not hand-edit that file outside of a deploy
script run.

## Roadmap / status

- **Now:** Base Sepolia testnet, feature-complete MVP, no external audit yet, hosting
  (Railway/Vercel) not yet stood up, `TRACKED_HOLDERS` keeper list is hand-maintained
  (holder auto-discovery is a known launch-blocking gap — see
  [`docs/production-plan.md`](./docs/production-plan.md)).
- **Next (Phase 1–3, see `docs/production-plan.md`):** holder discovery from chain
  events, a Safe-based role ceremony off the raw deployer EOA, a Foundry stateful
  invariant suite + Slither + external audit, mainnet plumbing, and a full credit-event
  dress rehearsal on Sepolia.
- **Funding Model v2 (future, not building now):** a per-wallet prepaid USDC buffer for
  liquidation runway, a Dutch-auction discount ramp instead of the current fixed
  formulaic claim price, and a non-linear token mark for correct convexity above ~10%
  hazard rates. Build only after the current (buffer-less) model validates PMF. See the
  "Funding Model v2" section of the root `CLAUDE.md`.

## What's explicitly not in MVP

Gnosis CTF/ERC-1155 (custom ERC-20 YES/NO instead), multiple markets, an LP vault,
`MarketFactory`, an ISDA oracle relayer (multisig only), a USDC bond module for credit
event disputes, a subgraph, fee distribution, referrals, governance, insurance fund
withdrawals, a market-listing UI, mobile optimization, and direct wallet-to-wallet
YES/NO transfers. Full list in the root [`CLAUDE.md`](./CLAUDE.md#what-not-to-build-in-mvp).
