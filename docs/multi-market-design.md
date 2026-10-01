# Multi-market — design doc (decisions LOCKED 2026-10-01)

*Written 2026-10-01, right after the batch-1 redeploy. Status: **D1–D6 decided 2026-10-01
(see §3 "Decision record"); phase 0 (spec) done, phases 1–4 not started.** Read with root `CLAUDE.md` (canonical spec) and
`docs/HANDOVER.md` (live state).*

## 1. Goal and non-goals

**Goal:** list several reference entities (corporate and sovereign), each its own market
— "Will [Entity] have a credit event in the next 12 months?" — on one Pari deployment.
Each market keeps today's economics unchanged: complete-set YES/NO, mirrored funding
index, seizure trigger `m ≤ 1.03 × f_next`, formulaic claim `P = min(owed, m×Q)`, the
carry-side fee, and all 10 hard invariants in CLAUDE.md, **per market**.

**Non-goals (still out):** permissionless listing / listing UI, LP vault, governance,
cross-market margin or netting, ERC-1155/CTF migration, an automated mark feed (marks
stay keeper-set by hand, now N of them), mobile.

**Spec change required:** CLAUDE.md lists "Multiple markets (MSTR only)" and
"MarketFactory" under *What NOT to Build in MVP*, and "MVP Scope — Single Market".
Those lines get rewritten as part of phase 0 (§5) once §3 is decided.

## 2. Where the code assumes one market today

| Layer | Single-market assumption | File(s) |
|---|---|---|
| CreditMarket | One market per contract (its own YES/NO, collateral, mark, indices, cap, mark bounds, roles). **This is the unit we replicate — no change needed.** | `contracts/src/CreditMarket.sol` |
| CLOBSettlement | `creditMarket`, `usdc`, `yesToken`, `noToken` are **immutables** read in the constructor; every settle calls that one market; EIP-712 domain is per contract | `CLOBSettlement.sol:47-50,103-109` |
| LiquidationEngine | `creditMarket` immutable | `LiquidationEngine.sol:35` |
| OracleRouter | `creditMarket` immutable; one credit event per router | `OracleRouter.sol:13` |
| InsuranceFund | Market-agnostic (USDC + `LIQUIDATOR_ROLE`) — **already shareable** by granting the role to several engines | `InsuranceFund.sol` |
| YES/NO tokens | Name/symbol hard-coded `"YES"`/`"NO"` — N markets would show N identical "YES" tokens in wallets/explorers | `YESToken.sol`, `NOToken.sol` |
| Deploy | `Deploy.s.sol` deploys one full set; `deployments/base-sepolia.json` is a flat single-market object | `contracts/script/`, `contracts/deployments/` |
| order-book-server | Redis keys are global: `orderbook:bids`, `orderbook:asks`, `orders:<id>`, `nonces:<maker>`; one `yesTokenAddress`/`noTokenAddress`/`creditMarketAddress` in config; price derivation + chain pre-filter key on that one YES/NO | `order-book-server/src/{orderbook,server,main,chain}.ts` |
| matching-engine | One book, one YES/NO pair, one settler `clobSettlement`/`creditMarket`; prune path hard-codes `orderbook:bids/asks` | `matching-engine/src/{engine,settler,main}.ts` |
| funding-keeper / liquidation-keeper / liquidator-bot | One `CREDIT_MARKET_ADDRESS` + `YES_TOKEN_ADDRESS` each. Holder index is **already** namespaced per YES token in Redis (`holder-index:<chain>:<yes>:*`) — reusable per market | `backend/keepers/*.ts` |
| Frontend | `MSTR_MARKET` constant; addresses from build-time `NEXT_PUBLIC_*` vars (one set); `/market/[id]` exists but `id` only feeds chart/book components; portfolio, liquidate, admin all single-market; entity text in several pages | `frontend/lib/{constants,contracts}.ts`, `app/**` |
| Ops | Railway env vars hold one address set; `uptime.yml` checks one CreditMarket's `lastFundingTime` | `docs/hosted-env-vars.md`, `.github/workflows/uptime.yml` |

## 3. Decisions (owner-approved 2026-10-01)

### Decision record

| # | Decision | Outcome |
|---|---|---|
| D1 | Contract topology | **A** — one contract set per market + on-chain `MarketRegistry`; entries immutable once registered (admin may only toggle `active`); MSTR batch-1 set registered as market #1, no redeploy |
| D2 | InsuranceFund | **Shared** — one fund, `LIQUIDATOR_ROLE` per LiquidationEngine; per-market draws attributed off-chain from USDC transfers fund → CreditMarket |
| D3 | CLOBSettlement | **Per market** — no contract change; shared CLOB is v2 |
| D4 | Ops wallets | **One** keeper / settler / liquidator wallet across markets; deployer = attester until Safe |
| D5 | Discovery | **Registry** holds slug, entity name, entity type, six addresses, `active`; title derived from entity name; long-form copy in a frontend file keyed by slug with generic fallback; one `NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS` |
| D6 | Launch markets | `mstr` MicroStrategy (corporate, live 23%); `crwv` CoreWeave (corporate, 10%); `try` Turkey / Republic of Turkey (sovereign, 2%). Corporate events: Bankruptcy, Failure to Pay. Sovereign events: Failure to Pay, Repudiation/Moratorium, Restructuring. Each: depositCap 50,000 USDC, setMark ≤ 5 pts / ≥ 1h, fee 50 bps 50/50. New tokens `YES-<TICKER>`/`NO-<TICKER>` (CRWV, TRY); MSTR keeps `YES`/`NO` |

The original options and rationale follow, kept for context.

### D1 — Contract topology  ★ the big one

- **A. One contract set per market + an on-chain `MarketRegistry` (recommended).**
  Each market = its own CreditMarket + YES + NO (+ per-market or shared CLOB, see D3),
  deployed by a forge script (`AddMarket.s.sol`) and recorded in a small admin-owned
  `MarketRegistry` (market id → addresses + metadata). The funding/liquidation logic —
  the part that just went through F1/F4, 151 tests, and a 9/9-mutation invariant suite —
  is **reused byte-for-byte**. Market isolation is structural: one market's collateral
  can never pay another's NO holders. **The live MSTR market becomes market #1 without a
  redeploy** (register the batch-1 addresses).
- **B. One "multi-market" CreditMarket keyed by `marketId`** (or ERC-1155). Every mapping
  gains a market dimension; a rewrite of the most security-sensitive contract, the
  invariant suite and most tests start over, and a bug can now leak collateral *across*
  markets. Not recommended for MVP.
- *Why not an on-chain factory that `new`s every contract?* Runtime size: the creation
  code of CreditMarket (10.9 KB) + CLOBSettlement (8.4 KB) + LiquidationEngine (3.0 KB) +
  OracleRouter + two tokens exceeds the 24 KB contract limit in one factory. Splitting
  into several factories (or clones, which don't fit immutables-heavy contracts) adds
  code for no MVP benefit — a script + registry gets the same result. Revisit only for
  permissionless listing (non-goal).

### D2 — InsuranceFund: shared or per market

- **Shared (recommended for MVP).** One fund, `LIQUIDATOR_ROLE` granted to each market's
  LiquidationEngine; every market's fee share flows in. No contract change. Bigger,
  smoother buffer. Cost: a stall in one market is paid from fees earned in others
  (cross-subsidy) — acceptable at testnet/MVP scale; the bot's job is to prevent stalls.
- **Per market.** Clean isolation, but N small funds — each needs seeding and can run dry
  independently (a tail-case claim reverts if its fund is short). Revisit before mainnet
  if markets differ a lot in risk.

### D3 — CLOBSettlement: per market or shared

- **Per market (recommended for MVP).** Deploy one CLOBSettlement per market exactly as
  today — **zero contract change**, per-market fee config for free, per-market EIP-712
  domain (an order signed for market A can never settle on market B). Cost: a user
  approves USDC once *per market* they trade; the settler/backends hold N CLOB addresses.
- **Shared, registry-aware.** Replace the four immutables with a `marketOf[token]`
  lookup (registry-set), require all of an order pair's tokens to belong to one market,
  route `settleFunding`/`markDebtCollected`/`claimable` to that market. One USDC approval
  for all markets — better UX — but it's a change to the second most sensitive contract,
  new invariants (cross-market token mixing must revert), and every market must grant
  `CLOB_ROLE` to the shared contract. Good v2 candidate once listings are frequent.

### D4 — Ops wallets

- **One keeper + one liquidator wallet across all markets (recommended).** Keeper gets
  `KEEPER_ROLE` on each CreditMarket; the bot claims anywhere from one USDC float (size
  it to the largest single claim across markets, not the sum). Attester = deployer per
  OracleRouter until the Safe ceremony. Per-market wallets only add key management.

### D5 — Market metadata and discovery

- **Registry holds addresses + minimal metadata** (slug, title, entity, ticker,
  credit-event types, active flag); the frontend reads the registry address from **one**
  `NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS` and discovers everything else on-chain — no more
  seven-address Vercel edit per redeploy, and adding a market needs no frontend rebuild.
  Long-form copy (entity description, reference CDS source) stays in a frontend file
  keyed by slug. Backends read the registry too (refresh periodically), replacing the
  per-service address env vars.

### D6 — Launch markets and initial marks

Owner call: which entities (suggest 3–5 for testnet, mixing corporate + sovereign, e.g.
MSTR plus a high-yield corporate and an EM sovereign), each one's initial mark (team-set
from a CDS spread, as MSTR's 23% was), deposit cap, and mark-step bounds. Token naming
per market (e.g. `YES-MSTR` / `NO-MSTR`) needs a small token constructor change — fine
for *new* markets; MSTR's existing tokens keep "YES"/"NO" unless redeployed (cosmetic).

## 4. Target architecture (assuming the recommendations)

```
MarketRegistry (admin) ──► market #1 MSTR: CreditMarket, YES, NO, CLOB, OracleRouter, LiquidationEngine
                      ├──► market #2 …:   CreditMarket, YES, NO, CLOB, OracleRouter, LiquidationEngine
                      └──► …
InsuranceFund (shared) ◄── LIQUIDATOR_ROLE for every LiquidationEngine; fee share from every CLOB
```

- **order-book-server:** one service, many books. Redis keys namespaced by market
  (`orderbook:<market>:bids`, `orders:<id>` stays global but the stored order carries its
  market). Routes: `GET /markets`, `GET /orderbook?market=<slug>` (keep the bare
  `/orderbook` → MSTR alias during migration), `POST /order` derives the market from the
  order's non-USDC token and rejects tokens not in the registry. Price derivation,
  NO-bid fee netting and the chain pre-filter run against *that* market's contracts.
  Rate limit stays per IP across markets.
- **matching-engine:** loops markets; settler picks the CLOB/CreditMarket per pair;
  prune paths use the namespaced keys. One settler wallet.
- **Keepers / liquidator-bot:** loop markets from the registry; one holder index per
  YES token (already supported); `/health` reports per market; uptime check iterates
  markets. One Railway service each — not one per market.
- **Frontend:** home = market list (title, mark as "x% chance", daily carry, volume);
  `/market/[slug]` resolves contracts from the registry; portfolio aggregates positions
  across markets (cost basis, equity, Epochs To Expire per market); `/liquidate` lists
  flagged positions across markets; `/admin` gets a market picker. Fee rate read per
  market's CLOB. UX naming rules unchanged (Upbet/Downbet, "x% chance", no "token").

## 5. Phased plan

| Phase | Work | Exit criteria |
|---|---|---|
| **0. Decide + spec** | Owner answers D1–D6; rewrite CLAUDE.md scope sections, contracts/CLAUDE.md "Do not build" | Spec merged |
| **1. Contracts** | `MarketRegistry.sol` (+ tests); token name/symbol constructor params; `AddMarket.s.sol` (deploy one market set, wire roles, register, grant IF role, post-broadcast assertions like `Deploy.s.sol`); `RegisterExisting.s.sol` for MSTR; deployments JSON → `{ registry, insuranceFund, markets: { mstr: {…}, … } }` | All 151 existing tests green unchanged; registry tests; **invariant suite run with ≥2 markets sharing the InsuranceFund** — new invariants: per-market collateral ≥ obligations, a claim in market A never moves market B's collateral, IF outflows ≤ Σ shortfalls |
| **2. Backends** | Registry reader shared module; order-book namespacing + market routing + `/markets`; engine loop; keepers + bot loops; per-market `/health`; Redis migration of live MSTR keys | Existing Vitest suites green; new multi-market tests; 2-market anvil smoke (trade, flag, claim, cure in both, no cross-talk) |
| **3. Frontend** | Market list, slug routing via registry, portfolio aggregation, liquidate/admin multi-market, per-market fee | Type-check; manual walkthrough on the anvil 2-market stack |
| **4. Sepolia rollout** | Deploy registry, register MSTR, `AddMarket` ×N, fan-out (Railway: registry address replaces per-contract vars; Vercel: one var), seed books, seed IF | Runbook rehearsed on a fork first (as batch 1); all phase-4 style checks per market |

Suggested execution: phase 1 and the registry-reader module first (everything else
depends on the registry ABI), then backends and frontend in parallel.

## 6. Migration — no MSTR redeploy needed (under D1-A + D3-per-market)

The batch-1 MSTR contracts are already a valid "market set". Migration = deploy
`MarketRegistry`, register MSTR's existing addresses, then add new markets. Live
positions, the resting book, holder indexes and the InsuranceFund all carry over. The
only Redis change is renaming the MSTR book keys into the namespaced scheme (or keep the
legacy keys as MSTR's namespace). If D3 goes shared-CLOB instead, MSTR needs a CLOB
redeploy + role rewire + order flush (like the 2026-07-12 fee redeploy) — another point
for per-market CLOBs now.

## 7. Risks and open questions

- **Ops load scales with N:** N marks set by hand, N books to seed, N credit-event
  watches. Mark-setting tooling (a small admin script/page that shows each market's mark
  vs a reference spread) may be worth adding in phase 3.
- **Correlated defaults:** with a shared IF, a crisis can stall several markets at once;
  size the liquidator float and IF for the largest *simultaneous* exposure you're willing
  to back. Document per-market deposit caps as the main limiter.
- **Credit-event determination** stays a manual multisig attestation per market; one
  market's settlement must not pause others (it doesn't — separate CreditMarkets).
- **USDC approvals per market** (D3-per-market) — acceptable friction; the TradePanel
  already handles an approve step.
- **Public RPC load:** keepers/bot polling N markets on `sepolia.base.org` multiplies
  `eth_call`/`getLogs` volume — batch with multicall; consider a paid RPC before mainnet.
- **Open:** sovereign "credit event" definitions differ from corporate (repudiation/
  moratorium, restructuring) — confirm which event types each launch market covers.
