# Pari (credit-prediction-dex) — Project Context for Claude Code

This root doc is the **canonical product/economics spec**. If code and this doc disagree,
treat it as a bug in the code. Current ops state, wallets, hosting and open work live in
`docs/HANDOVER.md`; per-directory stack notes in `contracts/`, `backend/`, `frontend/CLAUDE.md`.

## What We're Building

A fully-collateralized perpetual prediction market on corporate and sovereign credit default.
Users trade YES/NO tokens on:

> "Will [Entity] have a credit event in the next 12 months?"

The price of a YES token = the market's probability of a credit event in the next 12 months
(the carry rate is set so this holds exactly — see "Carry rate"). Position economics are a
zero-recovery perpetual CDS, structured and presented as a prediction market.

**Token model (Polymarket-style):** deposit USDC → receive ERC-20 YES + NO 1:1. They trade
on an off-chain CLOB with on-chain settlement. On a credit event YES redeems 1:1 for USDC,
NO for $0. (Custom ERC-20 rather than Gnosis CTF/ERC-1155: simpler, auto-visible in
wallets, same economics; CTF is a V2 option.)

## Current State (2026-11-18)

- **Base Sepolia (testnet) only — nothing on mainnet.** Batch-4 contracts (motion escrow,
  Pay carry for all, `MARK_ROLE`) live since 2026-11-18 under MarketRegistry
  `0x36a1507fef705E8760d40bD8c959F40d242e342a`; three
  markets (MSTR, CoreWeave, Turkey). Addresses: `contracts/deployments/base-sepolia/`. Older
  contract sets are paused + inactive (`deployments/base-sepolia/archive/`).
- Five backend services on Railway + frontend on Vercel, all in registry mode; pushes to
  `main` auto-deploy them. Hourly-scheduled uptime workflow.
- Tests: `cd contracts && forge test` (incl. stateful invariant suites);
  vitest in `backend/{order-book-server,matching-engine,keepers}`; multi-market anvil smoke
  `scripts/smoke/run-smoke.sh` (≈1 min). Frontend: type-check only. Counts: `docs/HANDOVER.md`.
- Mainnet blockers (Safe role ceremony, credit-event dress rehearsal, audit — deferred by
  the owner — legal read, unsafe deploy-script defaults): `docs/HANDOVER.md` "Open work".
- Redeploying: `docs/redeploy-guide.md` + the latest `docs/redeploy-batch*-runbook.md`. Any
  CreditMarket change means a full new contract set per market under a new registry.

---

## Key Decisions (Non-Negotiable)

| Decision | Value |
|---|---|
| Chain | Base (EVM); Base Sepolia until mainnet |
| Collateral | USDC only |
| Settlement | YES/NO ERC-20 — YES redeems 1:1 USDC on credit event, NO redeems $0 |
| Recovery rate | Zero — YES settles at $1.00, NO at $0.00 |
| Funding | `cumulativeFundingPerYES == cumFundingPerNO` always (complete-set invariant); settled in USDC on close/redeem/settle/liquidation |
| Seizure trigger | m ≤ 1.03 × f_next, evaluated one epoch ahead (3% buffer, cost-basis-independent) |
| Liquidation | Formulaic price = funding owed; YES TRANSFERS to the liquidator (never burned); NO untouched |
| Price primitive | 12-month default probability m = 1 − e^(−h) for hazard h |
| Carry rate | carry = h × (1 − m) = −(1 − m)·ln(1 − m) per year (`CreditMarket.carryRateFor`) |
| Liquidity | Polymarket-style off-chain CLOB, on-chain USDC settlement; team wallet seeds quotes |
| Trading fee | 50 bps × min(p, 1−p) × Q, ONLY on the carry-earning side (YES sells + NO buys); split 50/50 team wallet / InsuranceFund; admin-editable |
| Leverage / protocol token / LP vault | None — fully collateralized, no token, no vault |

---

## Markets (multi-market, admin-listed)

Each market is independent; **all 10 hard invariants hold per market**. Listing is
admin-only (forge script + `MarketRegistry`); no permissionless listing.

| Slug | Entity (UI name) | Type | Ticker | Credit events covered | Seed mark |
|---|---|---|---|---|---|
| `mstr` | MicroStrategy (MicroStrategy Incorporated) | corporate | MSTR | Bankruptcy, Failure to Pay | 23% |
| `crwv` | CoreWeave (CoreWeave, Inc.) | corporate | CRWV | Bankruptcy, Failure to Pay | 10% |
| `try` | Turkey (Republic of Turkey) | sovereign | TRY | Failure to Pay, Repudiation/Moratorium, Restructuring | 2% |

**Per-market config:** `depositCap` 50,000 USDC; `setMark` by the mark updater's own key
(`MARK_ROLE`, batch 4; separate from the flagging `KEEPER_ROLE`) ≤ 50 points per update,
≥ 10 min apart — a wide circuit breaker, not a speed limit (batch 3 live: KEEPER_ROLE, 5
points, 1h); admin `adminSetMark` bypasses; fee 50 bps, 50/50 team wallet / shared
InsuranceFund. **The mark must follow trades** (fills TWAP, depth-filtered mid fallback;
jumps allowed both ways) — the `keepers/mark-updater` service does this on batch 4 (it
dry-runs on batch 3, which has no `MARK_ROLE`); on the live batch-3 markets marks still move
only by admin `adminSetMark`, and carry, the seizure trigger and the claim cap all read that
mark. Seed marks are set manually per market from the entity's CDS spread
(`m = 1 − exp(−s/(1−R))`); current ones are placeholders. Credit-event types are display
copy + attestation runbook only — nothing on-chain encodes them (OracleRouter has a single
`confirmCreditEvent()`). **Credit-event policy:** the team multisig follows the ISDA DC — a
DC question on a listed entity ("Has a Bankruptcy Credit Event occurred with respect to …?",
from the All DC Requests list on cdsdeterminationscommittees.org) → open a motion
(`OracleRouter.openMotion()` / `setMotionPending(true)`; batch 4: it marks the EDD, escrows
carry accrued after it and blocks nothing) → DC "Yes" on a covered event →
`confirmCreditEvent()` (post-EDD carry void, refunded to its payers); DC "No"/declined →
`setMotionPending(false)` (escrow released). Each market's covered events are framed by the
team before listing; never name industry transaction types or settlement matrices in
anything public or in git. Design: `docs/design/motion-escrow-and-mark.md`. User copy:
`frontend/app/docs/credit-events/page.tsx`; ops: `docs/credit-event-runbook.md`. Keep listings well below m ≈ 63% (carry falls above it).

**Topology (decisions D1–D5, `docs/multi-market-design.md`):**
- **D1 — one contract set per market + on-chain `MarketRegistry`.** Each market = its own
  CreditMarket, YES, NO, CLOBSettlement, OracleRouter, LiquidationEngine, deployed by
  `AddMarket.s.sol`. One market's collateral can never pay another's holders. No on-chain
  factory. Registry entries are **immutable once registered** — the admin may only toggle
  `active`. Tokens are named `YES-<TICKER>` / `NO-<TICKER>`.
- **D2 — one shared InsuranceFund.** Its `LIQUIDATOR_ROLE` goes to every market's
  LiquidationEngine and every CLOB routes its fee share to it; each draw is a USDC transfer
  to that market's CreditMarket, so draws are attributable per market.
- **D3 — one CLOBSettlement per market.** Per-market EIP-712 domain (an order signed for
  market A can never settle on B), per-market fee config, per-market USDC approvals.
- **D4 — one keeper, one settler, one liquidator wallet across all markets.** Liquidator
  float ≥ the largest single claim across markets.
- **D5 — the registry is the discovery source of truth.** On-chain: slug, entity name/type,
  the six addresses, `active`. Services and the frontend read one registry address
  (`MARKET_REGISTRY_ADDRESS` / `NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS`); without it they fall
  back to legacy one-market `mstr` mode. Long-form copy lives in `frontend/lib/marketCopy.ts`
  with a corporate/sovereign fallback, so a new market renders without a rebuild.

---

## Architecture

### Smart contracts (`contracts/src/`)

```
CreditMarket.sol      — mints/burns YES+NO, holds USDC collateral, funding accrual/ledger,
                        seizure trigger, flag-lock/cure, collectDebt, pause
YESToken.sol          — ERC-20, minted by CreditMarket; transfers restricted (see below)
NOToken.sol           — ERC-20, minted by CreditMarket; transfers restricted
CLOBSettlement.sol    — EIP-712 orders, partial fills (operator-only), on-chain cancel,
                        trading fee, settles funding for both parties
OracleRouter.sol      — credit-event attestation (ORACLE_ROLE) → triggers settlement
InsuranceFund.sol     — shared USDC reserve; covers liquidation tail-case shortfalls;
                        timelocked admin withdrawals (unused in MVP — fund only receives)
LiquidationEngine.sol — formulaic claim of seizure-flagged YES positions; YES transfers
MarketRegistry.sol    — slug → per-market contract set + metadata; immutable, `active` toggle
```

Scripts: `AddMarket.s.sol` (one market against an existing registry + fund),
`DeployEmptyRegistry.s.sol` (fresh registry, used for batches 2/3), legacy `Deploy.s.sol`
(single set + InsuranceFund) + `DeployMarketRegistry.s.sol`. Details: `contracts/CLAUDE.md`.

**Contract standards:**
- Solidity 0.8.24, Foundry, OpenZeppelin v5 (`AccessControl`, `ReentrancyGuard`,
  `Pausable`) — plain contracts, no proxies/upgradeability. Solady `lnWad` for the carry rate.
- Roles — CreditMarket: `DEFAULT_ADMIN_ROLE`, `ORACLE_ROLE`, `KEEPER_ROLE`, `PAUSER_ROLE`,
  `CLOB_ROLE`, `LIQUIDATOR_ROLE`. YES/NO: `MINTER_ROLE`, `BURNER_ROLE`, `CLOB_ROLE`.
  CLOBSettlement: `OPERATOR_ROLE` (the only filler). InsuranceFund: `LIQUIDATOR_ROLE`.
  OracleRouter: `ORACLE_ROLE` (attester), `MOTION_ROLE` (may only open a motion; batch 4).
  CreditMarket `MARK_ROLE` (mark updater; batch 4).
- `ReentrancyGuard` on every function that moves USDC or YES/NO. **Pull-over-push** for all
  USDC payouts — never push to arbitrary addresses.
- **YES/NO transfers are restricted** via the OZ v5 `_update()` override: only `CLOB_ROLE`
  (CLOBSettlement, and LiquidationEngine's `forcedTransfer`) and CreditMarket may move
  tokens. Direct wallet-to-wallet transfers revert, so every movement passes a
  funding-sync path. Never loosen this.
- `Pausable` on CreditMarket (PAUSER_ROLE halts mint and redeem in an emergency; a credit
  event confirmation pauses for good. Pay carry (`cure`) works while paused).
- Emit events on every state change. CreditMarket: TokensMinted, TokensRedeemed,
  YESSettled, FundingAccrued, MarkUpdated, CreditEventTriggered, FlaggedClaimable,
  FundingSettled, PositionCured, MotionPendingSet, MotionOpened, MotionResolved,
  MotionRefundRecorded (+ config events). CLOBSettlement:
  OrderFilled, OrderCancelled, MinNonceUpdated, FeeCharged, FeeConfigUpdated.
  LiquidationEngine: Liquidated. OracleRouter: CreditEventConfirmed, MotionPendingSet.
  MarketRegistry: MarketRegistered, MarketActiveSet.
- **Decimals quirk:** YES/NO report `decimals() == 18`, but every amount is raw 6-decimal
  USDC scale. Never normalize by 1e18.

### Token model and core math

- **Mint** (`CreditMarket.mint`): N USDC → N YES + N NO (1:1 complete set; `currentMark` is
  the CLOB price of YES, not the mint ratio).
- **Redeem** (`redeem`, pre-settlement only): burn N YES + N NO → N USDC.
- **Credit event** (`settleYES`): YES burns at 1 USDC each; NO gets nothing.
- `YES.totalSupply() == NO.totalSupply()` ALWAYS.
- **CLOB price:** buying/selling YES at P USDC per token, 0 < P < 1; P is the
  market-implied probability of a credit event in the next 12 months.
- Funding is tracked by `cumulativeFundingPerYES` / `cumFundingPerNO` (monotonic indices)
  and per user `fundingSnapshot` / `snapNO` / `fundingDebt`; entry point
  `settleFunding(user)`. See "Funding Model".

### CLOB (off-chain matching, on-chain settlement)

```
User signs EIP-712 order → POST /order (order-book-server) → matching engine pairs orders
→ CLOBSettlement.fillOrders (OPERATOR_ROLE = the settler) verifies both signatures and
remaining sizes, settles funding for both parties, then atomically swaps tokens ↔ USDC.
```

**Order struct (EIP-712, wire format) — signatures are detached, not embedded:**
```solidity
struct Order {
    address maker;
    address tokenIn;      // USDC (buying) or YES/NO (selling)
    address tokenOut;     // YES/NO (buying) or USDC (selling)
    uint256 amountIn;
    uint256 minAmountOut; // encodes the limit price
    uint256 expiry;
    uint256 nonce;        // millisecond timestamp
}
```
`fillOrders(Order makerOrder, bytes makerSig, Order takerOrder, bytes takerSig, uint256 tokens)`,
selector `0x96c8e34a`. Off-chain callers must match this exact ABI shape (a past 8-field
encoding made every settlement revert). `fillOrders` rejects any pair that isn't one USDC
leg + THIS market's YES or NO (`MismatchedPair` / `InvalidTokenPair`); the order-book server,
settler and frontend also enforce it.

**Partial fills (`docs/partial-fills-plan.md`):**
- An order's size is in outcome tokens (a bid's `minAmountOut`, an ask's `amountIn`);
  `filled[hash]` tracks tokens filled, `spent[hash]` the USDC a buy order has paid (hard cap:
  its signed `amountIn`).
- **Price:** each fill runs at the MAKER's (earlier order's) limit, pro rata, rounded in the
  maker's favour — a YES seller's ceil(q × minAmountOut / amountIn); a NO seller's net limit
  grossed up by `minGrossForNet`; a maker buyer's ceil(q × amountIn / minAmountOut) — never
  above the buyer's pro-rata limit or unspent budget. The seller's pro-rata floor (gross for
  YES, net of fee for NO) must hold or the fill reverts `SlippageExceeded`; a fill that prices
  to 0 reverts `FillTooSmall`.
- **Cancel:** `cancelOrders(Order[])` (maker only; marks them fully filled) or
  `setMinNonce(n)` (retires every order with nonce < n; must increase) —
  `setMinNonce(Date.now())` cancels everything signed so far. `remaining(order)` = tokens
  still fillable (0 once expired/cancelled/spent/filled). `DELETE /order/:id` is off-chain
  only; the binding cancel is on-chain.
- **Minimum order:** 1 Upbet/Downbet (`MIN_ORDER_TOKENS` = 1_000_000, order-book-server +
  frontend); no on-chain minimum.

**Order removal policy (user-protection rule — never violate):** the platform removes a
user's resting order only (a) when it is filled or cancelled, or (b) for a published,
objective reason about THAT order or its maker's own state — expired, cancelled on-chain or
fully filled (`remaining() == 0`), maker's position flagged (`PositionFrozen`), a YES sale that
can't cover the maker's own carry debt (`FundingShortfall`), or legs that aren't {USDC, one
market's YES/NO}. Never because of another trader's order or a guess: an incompatibility
between two valid orders (`SlippageExceeded`, `FillTooSmall`) skips the pair, and an
ambiguous or failed chain read releases both orders for a retry.

### Trading fee (CLOBSettlement)

```
fee = feeBps × min(p, 1−p) × Q   — on-chain: feeBps × min(tradePrice, amount − tradePrice) / 10_000
      (Q tokens carry Q USDC of notional; tradePrice is the buyer's gross USDC leg)
```
- **Who pays:** ONLY the carry-earning side — the YES seller and the NO buyer. YES buys and
  NO sells are fee-free. Maker/taker is irrelevant.
- **Why min(p, 1−p):** "buy NO at 1−p" ≡ "mint + sell YES at p"; the min-side base makes both
  routes cost the same, so mint can't dodge the fee.
- **YES sale:** the fee is deducted from proceeds like the funding debit; the Option B
  safeguard covers it — `tradePrice < debtShare + fee` reverts `FundingShortfall` with the
  position unchanged.
- **NO buy:** the contract never pulls more than a signed `amountIn` (`spent` caps it across
  fills), so the buyer signs a GROSS amount (cost + fee), sized via the exact piecewise
  inversion `minGrossForNet`; the fee-free seller's pro-rata `minAmountOut` is checked
  against the NET amount.
- **Three implementations must stay in lockstep:** `CLOBSettlement.tradeFee` (source of
  truth), `backend/order-book-server/src/fee.ts`, `frontend/lib/feeMath.ts`. The RATE is
  read live from `CLOBSettlement.feeBps()` (60s refresh); `FEE_BPS` / `NEXT_PUBLIC_FEE_BPS`
  are fallbacks only, and the frontend refuses to sign NO buys until the live rate loads.
- **Routing:** `insuranceShareBps` to InsuranceFund, the rest to teamWallet. Admin-editable
  via `setFeeConfig` (DEFAULT_ADMIN_ROLE, `MAX_FEE_BPS` = 500); the constructor leaves the fee
  at 0 until configured. **Fees never touch CreditMarket collateral.**
- Off-chain, NO bids are stored at their NET price (the sorting/crossing basis).

### Backend services (`backend/`, details in `backend/CLAUDE.md`)

Every service serves all markets from one process via `MarketDirectory`
(`backend/shared/registry.ts`, copied into each service by `sync-registry.sh`; CI fails on
drift).

| Service | Role |
|---|---|
| `order-book-server` | REST: `GET /markets`, `GET /orderbook?market=`, `POST /order`, `DELETE /order/:id`, `POST /orders/sync`, `GET /health`. Derives the market from the order's token; rejects bad pairs, orders under the minimum, flagged makers (`PositionFrozen`) and un-fundable YES sells (`FundingShortfall` + `minSellProceeds`). Chain pre-filters fail open — the on-chain check is the backstop. Redis books `orderbook:<slug>:*`. Rate-limited per client IP. |
| `matching-engine` | Price-time priority per market; the earlier order is the maker; fill size = min of both remaining sizes. Settles via `fillOrders`, records `filled`. Revert handling follows the Order removal policy. `GET /health` (503 when the loop is stale). |
| `keepers/funding-keeper` | `accrueFunding()` every epoch on every market, then flags any position breaching the seizure trigger — during a motion too (batch 4), but never after a confirmed credit event, nor in a market named by the "DC Yes announced" switch `DC_YES_HOLD` (`keepers/credit-event-hold.ts`; also honoured by the liquidator-bot). Retries transient errors without double-sending; `[ALERT]` log on failure. |
| `keepers/liquidation-keeper` | `GET /claimable[?market=]` — flagged positions + formulaic price P, `motionPending`, and `frozen` only when `claim()` would revert (confirmed event; or an open motion on batch-3 contracts, detected by probing `motionId()`). Does not claim (claiming is permissionless). |
| `keepers/mark-updater` | Batch 4, `MARK_ROLE` key (`MARK_UPDATER_PRIVATE_KEY`): per market, TWAP of the YES-implied price of `OrderFilled` events (1h window, minimum fill size/volume), else the mid of the depth-filtered YES-implied book (NO orders mirrored at 1 − price), fills clamped into that book band; `setMark` when the move exceeds a 0.25-point deadband, stepping by the on-chain `maxMarkStep` once `minMarkInterval` has passed. Never after confirmation. Dry run without the role or with `MARK_DRY_RUN`. `[ALERT]` when no source for 6h or a repricing exceeds one step. `GET /health` (:3005). |
| `keepers/liquidator-bot` | Team liquidator of last resort: claims EVERY flagged position promptly, profitable or not (stalls cost the InsuranceFund) — simulates first, uses only `claim()`, alerts on a short float / short InsuranceFund / pending motion — then sells the Upbet on the CLOB (crosses bids down to mark − `SELL_MAX_DISCOUNT_BPS` (3%), else rests at the mark). |

Both keepers discover YES holders from `Transfer` events (`keepers/holder-index.ts`); the
holder set only grows, by design. There is no oracle service — credit events are attested
manually (deployer EOA today; a Safe before mainnet).

### Frontend (`frontend/`, Next.js 14 — details in `frontend/CLAUDE.md`)

Routes: `/` market list, `/market/[id]` (id = slug) trading, `/portfolio` (all markets), `/liquidate`,
`/admin` (team only: credit event, pause), `/docs/*` (user docs). Every component takes a
`market` object; TradePanel's EIP-712 domain AND token addresses come from that one object.
Key UX behaviour:
- **TradePanel** disables trading for a flagged wallet; shows the YES sale's minimum price
  to cover carry + fee and its pro-rata carry share; signs NO buys gross and says so; enforces
  the 1-Upbet minimum; order expiry uses chain time.
- **PositionCard** shows Cost Basis, Equity, P&L, Breakeven Mark and (YES) Epochs To Expire;
  every Upbet position gets **"Pay carry"** (approve → `cure()`; batch 4) and a health badge
  (alerts on-site only); a flagged position must pay to unlock (redeem disabled while flagged;
  `settleYES` stays enabled). During a motion: a banner, and Downbets show "pending carry,
  paid if the DC rules No". User docs say to close a position by SELLING what you hold;
  buying the other side doesn't close it (the Upbet side can still be flagged on its own
  carry) unless you then redeem the pair.
- **OpenOrders** — the wallet's resting orders with on-chain Cancel / "Cancel all in this
  market", then `POST /orders/sync`.
- Carry figures always read `currentCarryRate` on-chain — never derive carry from the mark.

---

## Funding Model (canonical spec)

One contract carries the liquidation mechanism (LiquidationEngine.sol); no buffer, no Dutch
auction, no non-linear mark.

**Design guardrail:** `YES.totalSupply() == NO.totalSupply()` ALWAYS. Never burn YES alone
to enforce a funding cap — it orphans NO tokens whose paired YES no longer exists, still
credited funding no one pays. Retire a YES position only by transferring it to someone who
keeps paying (a liquidator), never by burning it unilaterally.

### Carry rate

```
h     = −ln(1 − m)                 // hazard implied by a 12-month probability m
carry = h × (1 − m)                // = −(1 − m)·ln(1 − m), per year, per YES
cumulativeFundingPerYES += carry × Δt/365   // every accrual; carry recomputed only on setMark
```

Why `× (1 − m)`: an Upbet bought at m is m of the holder's own cash plus an unfunded CDS on
(1 − m) of notional sold by the NO side — on default the token jumps from m to $1, so only
1 − m is protected. Carry h × (1 − m) gives a YES held at a steady mark zero expected P&L
(constant hazard, zero rates), which is what makes "23¢ = 23% chance in the next 12 months"
exact. Bounds: m(1 − m) ≤ carry ≤ m; carry peaks at 1/e when m = 1 − 1/e (≈63%). **Carry is
NOT the mark:** the token's VALUE is still m (equity, the trigger's left side, the claim cap
m×Q, cost basis); only accrual uses carry. Derivation: `docs/carry-formula.md`.

### Display layer (per holder, UI only — does not move cash)

```
Cost Basis (c)         = entry mark
Equity (E)             = m − f_now               // f_now = owed(user)/Q: fundingDebt ledger
                                                 //   + live accrual since the snapshot
P&L                    = E − c = (m − c) − f_now
Breakeven Mark         = c + f_now
Epochs To Expire (YES) = floor( (m/1.03 − f_now) / Δf ),  Δf = carry(m) × Δt/365
```

YES-only (NO is never liquidated). Example at entry (c = m = 0.05, f_now = 0, daily epoch):
carry = 0.04873, Δf ≈ 0.0001335, ≈363 days. Runway at a steady mark = 365 × m / (1.03 ×
carry): ≈358 days at 2%, 363 at 5%, 373 at 10%, 404 at 23%. Views on CreditMarket: `equity`,
`pnl`, `breakevenMark`, `epochsToExpire`.

### Seizure trigger (solvency-based, cost-basis-independent)

```
f_now  = owed(user) / Q          // owed = fundingDebt + Q × (cumYES − snapshot), YES debit rounded up
f_next = f_now + carry(m) × Δt/365
Seize when:  m ≤ 1.03 × f_next   // 3% buffer, evaluated one epoch ahead
```

`CreditMarket.isSeizable(user)`. **`owed(user)` is the single definition of the YES-side
obligation** — the trigger, the claim price, cure and the display layer all use it, and it
MUST include the `fundingDebt` ledger: every CLOB trade (buyer included) moves accrued debit
into `fundingDebt` and resets the snapshot, so a snapshot-only f_now would let any trade
reset the liquidation clock (security finding F4).

The trigger keys on **equity remaining relative to token value**, never on P&L or cost
basis. A holder deep underwater on the mark but current on funding is left alone (negative
MTM is never a trigger — they may hold cheap protection that pays par on a jump-to-default).
Cost basis must NOT appear in the trigger: two holders with identical funding/mark exposure
but different entry prices must be equally liquidatable, or one gets a free option at the
other's (and NO's) expense. The 3% buffer doubles as the liquidator's profit margin.

**Flag semantics (a lock, not a freeze):** once flagged (`flagClaimable`, KEEPER_ROLE) the
position is fully locked — no `mint()`, `redeem()`, CLOB trade on either side (all revert
`PositionFrozen`), and it can't act as a liquidator. **Funding keeps accruing** — an
accounting freeze let the paired NO keep earning credit nobody paid for (finding F1). The
only exits: a liquidation claim, `cure()` (the holder pays the live `owed()` in cash net of
NO credit and keeps the YES), or `settleYES` after a credit event (auto-cures from the payout).

### Liquidation math (formulaic, no Dutch auction)

Priced at CLAIM time from live state — deterministic within the claiming block:

```
owed = owed(user); m = current mark.   Claim (anyone, first to call): P = min(owed, m × Q)

NORMAL CASE (owed ≤ m×Q — expected when claimed promptly):
  Liquidator pays P = owed → into collateral (NO made whole, untouched).
  YES TRANSFERS to the liquidator (NOT burned); its funding snapshot resets to now.
  Residual (m − P ≈ 0.03×m) is the liquidator's profit, NOT returned to the holder.

TAIL CASE (owed > m×Q — mark gap, keeper downtime, or a stalled claim):
  Liquidator pays P = m×Q → into collateral.
  InsuranceFund tops up (owed − m×Q) → into collateral, so NO is ALWAYS made whole.
```

**Stall economics:** the claimer's margin (`m×Q − owed`) starts at ≈3.2% of `m×Q` and
shrinks by one day of carry (≈0.24–0.27% of `m×Q`) per day unclaimed, so at a constant mark a
position crosses into the tail case ≈11–13 days after flagging (sooner on a falling mark);
from then on every day of stall costs the InsuranceFund one day of carry. Run a claiming
liquidator bot.

**Claim touches ONLY the YES side:** the holder's NO credit is not netted, paid or forfeited
— `snapNO` is untouched and pays out at their next settlement touchpoint. No USDC is pushed
to the original holder inside `claim()`. The liquidator is `settleFunding`'d first (its own
NO credit paid, YES debit recorded — finding F2).

**Not "sold at zero":** the YES still carries full value m. Paying zero would short NO the
funding already promised to it; `P = owed` settles that promise, and the liquidator keeps
only the buffer sliver — the same sliver a seller keeps on a CLOB sale.

### Funding settlement points (`settleFunding` + `fundingDebt` ledger)

Funding accrues as a number via the indices; **cash moves only at these points.**
`settleFunding(user)` nets accrued funding over the user's FULL YES/NO balances, folding in
any prior `fundingDebt` (`debit = fundingDebt + yesOwed` vs `noCredit`), and resets both
snapshots. A net credit pays out immediately from collateral; a net debit is **recorded in
`fundingDebt[user]`, never forgiven** — otherwise an uncollected debit would vanish when
snapshots advance and silently deplete collateral.

```
mint / redeem / settleYES: settleFunding(user); a debit folds against the payout
                           (zeroed on redeem/settleYES)
liquidation:               P = min(owed(user), m×Q) at claim time (see above)

CLOB sale — NO seller: settleFunding(seller) nets the full position; a credit is paid now,
  a debit is recorded in fundingDebt and NOT collected (doesn't block the trade).
  settleFunding(buyer) also runs — the buyer's own debit, if any, lands in fundingDebt.

CLOB sale — YES seller: settleFunding(seller) records the net debit D. PRO-RATA: the fill
  repays debtShare = D × tokens / YES held (rounded down; all of D for a whole-position sale).
  require tradePrice ≥ debtShare + fee — OPTION B SAFEGUARD: else REVERT FundingShortfall,
  position UNCHANGED, NOT routed to liquidation (still solvent, above the trigger).
  Seller receives tradePrice − debtShare − fee; CLOB calls collectDebt(seller, debtShare);
  D − debtShare stays on the ledger against the YES still held. settleFunding(buyer) runs too.
```

**Credit-event motion escrow (batch 4, `docs/design/motion-escrow-and-mark.md` §5):** while
a motion is open, accrual is split at the EDD index (`motionIndex`). The pre-EDD part settles
exactly as above. The post-EDD part nets within the address into escrowed credit
(`escrowOf`: Downbet side, never paid out during the motion) or post-EDD debt (counted in
`fundingDebt`/`owed()`, so liquidations stay live). Every collection takes ordinary debt
first; post-EDD carry paid in cash (Pay carry, YES-sale proceeds, redeem, a liquidator's P,
the InsuranceFund's top-up) is recorded as refundable to its payer. Records fold lazily at the
address's next `settleFunding` (public, callable for anyone): **DC No** → escrow paid, post-EDD
debt becomes ordinary, refunds lapse; **DC Yes** → escrow and post-EDD debt void, refunds paid.
Escrow stays with the address that earned it (a Downbet buyer gets none of the seller's).

A buyer's (or NO seller's) net debit is never collected at trade time — one party's debt
never blocks a third party's fill. **Worked examples:** NO sells at $95 with $25 credit →
nets $120. YES sells its whole position at $30 with $8 debit → nets $22, $8 collected. Sells
HALF at $15 with the same $8 debit → $4 collected, nets $11, $4 stays on the ledger. YES tries
to sell everything at $5 with $8 debit → REVERT FundingShortfall, unchanged, not liquidated.
The shortfall case needs BOTH thin equity AND a thin bid side.

**Off-chain pre-filter (UX only):** `POST /order` rejects a flagged maker → `400
PositionFrozen`, and a YES sell whose `minAmountOut` can't cover ceil(D × amountIn /
yesBalance) + fee, with D = `fundingDebt(maker) − previewFunding(maker, fullYesBalance,
true)` clamped at 0 → `400 FundingShortfall` + `minSellProceeds`. **`previewFunding` does not
include `fundingDebt` — don't "simplify" this.** Chain reads fail open; the contract is the
backstop.

### Critical invariants (enforce in code AND tests)

```
1. Cost basis is NEVER part of the seizure trigger. Trigger keys only on equity vs mark.
2. Negative MTM is NEVER a liquidation trigger by itself — only equity-vs-mark matters.
3. YES tokens are NEVER burned in liquidation — only TRANSFERRED. Complete-set invariant
   (YES.totalSupply() == NO.totalSupply()) must hold before and after every liquidation.
4. NO holders are ALWAYS made whole on a liquidation — P = owed in the normal case,
   topped up by InsuranceFund in the tail case. NO is never haircut, and collateral always
   backs every outstanding pair (no accounting freeze may break this — F1).
5. A credit-event motion NEVER blocks trading, flagging, claims or cure — it marks the EDD.
   Carry accrued after the motion opened is escrowed per address and resolves with it:
   released on a DC "No", void and refunded to whoever paid it on a DC "Yes". Once a credit
   event is confirmed, flagging and claims revert FOREVER (`flagClaimable` and
   `clearLiquidatedPosition` revert `CreditEventAlreadyConfirmed` — on-chain, not by
   procedure; a flagged holder exits via settleYES). Never seize a paying Upbet.
6. Liquidation claims are permissionless and first-come — no single liquidator is
   load-bearing. (Known MVP limitation: first-valid-tx-wins has MEV/front-run exposure;
   acceptable for MVP, revisit with private relay if it becomes a problem.)
7. EVERY settlement path (mint, redeem, settleYES, CLOB sale, liquidation) nets accrued
   funding per-user via `settleFunding`, over the user's full YES/NO balances, folding in
   any prior `fundingDebt`. A net credit is paid out in cash immediately; a net debit is
   NEVER forgiven just because snapshots advance — it persists in the `fundingDebt` ledger
   until collected at the holder's next redeem/settleYES/YES-sale proceeds/liquidation.
8. A YES sale (fill) that would clear BELOW its share of the seller's net debit plus the
   fee — debtShare = (fundingDebt + yesOwed − noCredit) × tokens sold / YES held, all of
   it for a whole-position sale — REVERTS and leaves the position completely unchanged.
   It is NEVER force-liquidated by a failed sale — the position is still above the seizure
   trigger and solvent. Liquidation is reached only by the trigger, never by a sale attempt.
9. A net funding debit recorded in `fundingDebt` is NEVER erased without the equivalent
   USDC landing in (or staying in) collateral — snapshots may advance, but debt persists
   until collected (a partial YES sale collects its share; the rest stays recorded).
   Rounding always favours collateral: a YES debit rounds UP, a NO credit DOWN
   (`CreditMarket._yesDebit`).
10. A flagged (claimable) position is fully locked — no mint, redeem, CLOB trade on
    either side, or acting as a liquidator — while its funding keeps accruing (owed() is
    non-decreasing while flagged). The only exits are claim(), cure(), or
    post-credit-event settleYES. Liquidation itself touches ONLY the YES side: the
    holder's NO-side credit survives a claim untouched. (owed() may drop when a DC Yes
    voids post-EDD debt, and by ≤ 1 wei when a motion closes — bucket rounding.)
11. Motion escrow is conserved: at every point during an open motion, collateral covers
    BOTH resolutions — DC "No" (pairs + all accrued Downbet credit incl. escrow, net of all
    recorded and live Upbet debt) and DC "Yes" (every Upbet at $1 + pre-EDD credit net of
    pre-EDD debt + every refund owed to post-EDD payers). After a confirmed event the Yes
    world must hold (`contracts/test/invariant/EscrowMath.sol`).
```

Tests encode these (incl. the stateful invariant suites in `contracts/test/invariant/`); if a
change fights the tests, the change is wrong. Past findings F1–F4 and their fixes:
`docs/security/invariant-findings-2026-09-26.md`.

### Residual modelling assumptions (disclosed, not fixed)

A perpetual prices one flat hazard; idle collateral earns nothing (at ~4% rates prices lean
slightly — yield-bearing collateral is a v2 topic); carry falls above m ≈ 63%.

---

## Roadmap — Funding Model v2 (NOT building now)

Build only after the current model validates PMF and the no-buffer tradeoff (tighter, more
frequent liquidations) proves to be a real UX problem:
- Per-wallet prepaid USDC buffer (runway before liquidation) and a Dutch-auction discount
  ramp instead of the fixed formulaic price.
- Shared registry-aware CLOBSettlement; Gnosis CTF tokens.
- Explicitly NOT building: a fee-only top-up for FundingShortfall-blocked YES sales (the
  blocked band is ≤ fee-width and the escape is one price tick). (`prepayFunding()` is no
  longer on the roadmap: batch 4 opens `cure()` — "Pay carry" — to every holder.)

---

## Tech Stack

| Layer | Tech |
|---|---|
| Contracts | Solidity 0.8.24, Foundry, OpenZeppelin v5, Solady (`lnWad`) |
| Frontend | Next.js 14 (App Router), TypeScript, wagmi v2, viem, RainbowKit, Tailwind, TradingView Lightweight Charts |
| Backend | Node.js 20, TypeScript, Fastify, Redis, viem |
| Indexing | Direct RPC + event polling (no subgraph) |
| Testing | Foundry (contracts), Vitest (backend) |
| Hosting | Railway (backend), Vercel (frontend); Base Sepolia → Base mainnet |

---

## UX / Naming Conventions

**Product name:** Pari ("Pari — Tradable Credit For All"). Brand: tokens in
`frontend/styles/pari/` (the brand-guidelines doc is local-only, never in git) (Direction A "Analyst" for
nav/landing/portfolio, Direction B "Trader" for market/orderbook/liquidate).

**Never use in UI:** hazard rate, bps, basis points, protection buyer/seller, notional,
token, YES/NO (internal names only — code, ABIs and API fields keep yes/no).

**Always use in UI:**
- "Upbet" / "Downbet" (Upbet = YES = long default risk, pays carry; Downbet = NO = earns
  carry). Colors: Upbet `--color-danger`, Downbet `--color-teal`; positive P&L
  `--color-success`.
- "X% chance" (of a credit event in the next 12 months — never "annual probability").
- "Daily carry" (not funding rate).
- Market title: "Will [Entity] have a credit event in the next 12 months?"
- Price: "23.4% chance"; "Upbet costs 23.4¢ per $1 / Downbet costs 76.6¢ per $1".
- "Your position: $500 Upbet @ 23.4% entry".

---

## What NOT to Build in MVP

```
❌ Gnosis CTF / ERC-1155            ❌ LP vault / LPToken (team wallet is liquidity)
❌ On-chain MarketFactory           ❌ Permissionless listing / market listing UI
❌ Cross-market margin or netting   ❌ Shared multi-market CLOBSettlement (v2)
❌ ISDA oracle relayer (multisig)   ❌ USDC bond module for credit-event disputes
❌ Subgraph / The Graph             ❌ Fee distributor (fees route directly at settlement)
❌ Referral system / governance     ❌ InsuranceFund withdrawal flow (fund only receives)
❌ Mobile optimization              ❌ Wallet-to-wallet YES/NO transfers
❌ Protocol token, leverage
```

---

## Reference Links

- OpenZeppelin v5: https://docs.openzeppelin.com/contracts/5.x/
- Foundry book: https://book.getfoundry.sh/
- Solady FixedPointMathLib: https://github.com/Vectorized/solady
- wagmi v2 signTypedData: https://wagmi.sh/react/api/hooks/useSignTypedData
- Base docs: https://docs.base.org
- EIP-712: https://eips.ethereum.org/EIPS/eip-712
- Polymarket CLOB (reference): https://github.com/Polymarket/clob-client
- Everlasting options (White & Zhou) — funding model basis
