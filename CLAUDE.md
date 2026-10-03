# Credit Prediction DEX — Project Context for Claude Code

## What We're Building

A fully-collateralized perpetual prediction market on corporate and sovereign credit default
probability. Users trade YES/NO tokens on the question:

> "Will [Entity] have a credit event in the next 12 months?"

The price of a YES token = implied annual default probability (%) = hazard rate.
Position economics are equivalent to a zero-recovery perpetual CDS, structured and
presented as a prediction market.

**Token model (Polymarket-style):** users deposit USDC and receive ERC-20 YES + NO tokens
1:1 with their deposit. These tokens trade on the CLOB. On credit event: YES redeems 1:1
for USDC, NO redeems at $0.

Note: Polymarket uses Gnosis CTF (ERC-1155). We use custom ERC-20 for MVP — simpler to
build, better wallet visibility (auto-appears in MetaMask), same economic model. Migrate to
CTF in V2 if needed.

**Funding model (mirrored index + formulaic liquidation):** see the "Funding Model" section
below for the full spec — display layer, seizure trigger, and LiquidationEngine.sol's
formulaic (no Dutch auction) claim price.

**Status:** base MVP + funding model + off-chain services + trading fees are built and
tested — 151 contract tests (incl. a stateful invariant suite), 319 off-chain tests, verified end-to-end with a 12/12 anvil
smoke test (plus a 20/20 fee smoke). Target network is Base Sepolia (testnet) ahead of
Base mainnet. All seven contracts were freshly redeployed to Base Sepolia on 2026-10-01
(batch 1, `docs/redeploy-batch1-runbook.md`): the unified `owed()` fix, a 50,000 USDC
`depositCap`, bounded keeper `setMark`, fee 50 bps 50/50 — addresses in
`contracts/deployments/base-sepolia.json`. **Multi-market (MSTR, CoreWeave, Turkey) is built
and tested on branch `feat/multi-market-contracts` (2026-10-02) — registry + CoreWeave + Turkey contracts DEPLOYED to Base Sepolia 2026-10-03
(registry `0xdF1A5141310140edF6fDaE3cd339FD042dF15720`, `contracts/deployments/base-sepolia/`)
but services NOT yet switched to registry mode (cutover stage C) —
201 contract tests (incl. a 2-market invariant suite), 397 off-chain tests, 11/11
multi-market anvil smoke (`scripts/smoke/run-smoke.sh`, ~1 min) —
contracts, backends and frontend all run in a legacy single-market (`mstr`) mode until
`MARKET_REGISTRY_ADDRESS` / `NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS` are set; rollout runbook
`docs/multi-market-cutover.md`.

---

## Key Decisions (Non-Negotiable)

| Decision | Value |
|---|---|
| Chain (MVP) | Base (EVM standard) |
| Collateral | USDC only |
| Settlement | YES/NO ERC-20 tokens — YES redeems 1:1 USDC on credit event, NO redeems $0 |
| Recovery rate | Zero — YES settles at $1.00 on credit event, NO at $0.00 |
| Funding | cumFundingPerYES == cumFundingPerNO always (complete-set invariant); settled in USDC on close/redeem/settle/liquidation |
| Seizure trigger | m ≤ 1.03 × f_next, evaluated one epoch ahead (3% buffer, cost-basis-independent) |
| Liquidation | Formulaic price = funding owed; YES token TRANSFERS to liquidator (never burned); NO untouched |
| Price primitive | Hazard rate displayed as annual default probability (%) |
| Liquidity mechanism | Polymarket-style off-chain CLOB, on-chain USDC settlement |
| Trading fee | 50 bps × min(p, 1−p) × Q, charged ONLY on the carry-earning side (YES sells + NO buys); YES buys + NO sells are fee-free; split 50/50 team wallet / InsuranceFund, admin-editable via CLOBSettlement.setFeeConfig |
| Protocol token | None |
| Leverage | None — fully collateralized |
| LP vault | None in MVP — team wallet seeds initial liquidity |

---

## MVP Scope — Launch Markets (multi-market, admin-listed)

Several reference entities, each its own independent market — "Will [Entity] have a credit
event in the next 12 months?" — on one Pari deployment. Every market keeps the economics in
this doc unchanged, and **all 10 hard invariants hold per market**. Design + phased plan:
`docs/multi-market-design.md` (decisions D1–D6 locked 2026-10-01). Listing is admin-only
(forge script + `MarketRegistry`); permissionless listing stays out.

| Slug | Entity (UI name) | Type | Ticker | Credit events covered | Initial mark |
|---|---|---|---|---|---|
| `mstr` | MicroStrategy (MicroStrategy Incorporated) | corporate | MSTR | Bankruptcy, Failure to Pay | 23% (live, batch-1 contracts = market #1) |
| `crwv` | CoreWeave (CoreWeave, Inc.) | corporate | CRWV | Bankruptcy, Failure to Pay | 10% |
| `try` | Turkey (Republic of Turkey) | sovereign | TRY | Failure to Pay, Repudiation/Moratorium, Restructuring | 2% |

**Per-market config (launch):** `depositCap` 50,000 USDC; keeper `setMark` bounds ≤ 5 points
per update, ≥ 1h apart; trading fee 50 bps, 50/50 team wallet / shared InsuranceFund.
**Network:** Base Sepolia (testnet), then Base mainnet.
**Initial seed price:** set manually by the team per market (reference the entity's CDS
spread from TradFi sources). Credit-event types are display copy + attestation runbook
only — nothing on-chain encodes them (OracleRouter has a single `confirmCreditEvent()`).

### Multi-market topology (locked decisions, 2026-10-01)

- **D1 — one contract set per market + on-chain `MarketRegistry`.** Each market = its own
  CreditMarket, YES, NO, CLOBSettlement, OracleRouter, LiquidationEngine, deployed by
  `AddMarket.s.sol`. CreditMarket logic is reused unchanged; one market's collateral can
  never pay another's holders. No on-chain factory (creation-code size). Registry entries
  are **immutable once registered** — the admin may only toggle `active`. MSTR's batch-1
  addresses are registered as market #1 with no redeploy.
- **D2 — one shared InsuranceFund.** Its `LIQUIDATOR_ROLE` is granted to every market's
  LiquidationEngine and every CLOB routes its fee share to it. Each draw is a USDC transfer
  fund → that market's CreditMarket, so per-market draws are attributable off-chain.
- **D3 — one CLOBSettlement per market.** Per-market EIP-712 domain (an order signed for
  market A can never settle on B) and per-market fee config; users approve USDC per market.
  A shared registry-aware CLOB is a v2 candidate.
- **D4 — one keeper, one settler, one liquidator wallet across all markets**; deployer is
  attester on every OracleRouter until the Safe ceremony. Liquidator float ≥ the largest
  single claim across markets.
- **D5 — the registry is the discovery source of truth.** On-chain: slug, entity name,
  entity type, the six contract addresses, `active`. The frontend reads one
  `NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS`; backends read and periodically refresh the
  registry instead of per-contract address env vars. Long-form copy (description, CDS
  reference, credit-event wording) lives in a frontend file keyed by slug, with a generic
  fallback so a new market renders without a rebuild.
- **Token naming:** new markets' tokens are `YES-<TICKER>` / `NO-<TICKER>`; MSTR's batch-1
  tokens keep `YES` / `NO` (cosmetic).

---

## Architecture

Per-directory `CLAUDE.md` files exist in `contracts/`, `backend/`, `frontend/` with
directory-specific stack notes; this root doc is the canonical product/economics spec.

### Smart Contracts (`contracts/src/`)

```
CreditMarket.sol      — mints/burns YES+NO, holds USDC collateral, funding accrual/ledger,
                        seizure trigger, flag-lock/cure, pause
YESToken.sol          — ERC-20, minted by CreditMarket; transfer restricted to CLOB_ROLE
NOToken.sol           — ERC-20, minted by CreditMarket; transfer restricted to CLOB_ROLE
CLOBSettlement.sol    — validates EIP-712 orders, atomically swaps tokens ↔ USDC, settles
                        funding for both parties
OracleRouter.sol      — receives credit event attestations, triggers settlement
InsuranceFund.sol     — USDC reserve, timelock-gated withdrawals, covers liquidation
                        tail-case shortfalls
LiquidationEngine.sol — formulaic claim of seizure-flagged YES positions (no Dutch
                        auction); YES token transfers, never burned
MarketRegistry.sol    — (multi-market) admin-owned slug → market contract set
                        + minimal metadata; entries immutable, `active` toggle only
```

One full set of the per-market contracts above (all but InsuranceFund, which is shared)
exists per market — see "Multi-market topology" above.

**Not needed in MVP:** MarketFactory.sol (markets are added by forge script + registry), LiquidityVault.sol
(team wallet is liquidity), ISDARelayer.sol (multisig oracle only), BondModule.sol (no
permissionless listing), FundingBuffer.sol (v2 only).

### Token Model

Minting is 1:1 complete-set: depositing N USDC mints N YES + N NO (`CreditMarket.mint`) —
`currentMark` is the CLOB price of YES, not the mint ratio. Redeeming burns an equal YES+NO
pair for 1 USDC each (`CreditMarket.redeem`, pre-settlement only). After a confirmed credit
event, `settleYES` burns YES at 1 USDC each; NO gets nothing.

YES/NO override `_update()` (OZ v5): only `CLOB_ROLE` (CLOBSettlement, and
LiquidationEngine's `forcedTransfer`) and CreditMarket may move tokens — direct
wallet-to-wallet transfers revert, so every movement goes through a funding-sync path.
`CreditMarket` tracks `cumulativeFundingPerYES`/`cumFundingPerNO` (monotonic indices) and,
per user, `fundingSnapshot`/`snapNO`/`fundingDebt` — see "Funding Model" below for the full
ledger semantics; the entry point is `settleFunding(user)`.

### CLOB Architecture (Polymarket-style)

Off-chain matching, on-chain USDC settlement:

```
User signs EIP-712 limit order (tokenIn, tokenOut, amountIn, minAmountOut, expiry, nonce)
        ↓ submitted to order-book-server (REST) ↓ matching engine matches buy/sell ↓
Matched pair submitted to CLOBSettlement.sol on-chain, which verifies both signatures,
settles funding for both parties (CreditMarket.settleFunding), then atomically transfers
YES/NO from seller to buyer and USDC from buyer to seller.
```

**Order struct (EIP-712 typed data, wire format):**
```solidity
struct Order {
    address maker;
    address tokenIn;      // USDC (buying tokens) or YES/NO address (selling tokens)
    address tokenOut;     // YES or NO address (buying) or USDC (selling)
    uint256 amountIn;
    uint256 minAmountOut; // encodes limit price
    uint256 expiry;
    uint256 nonce;
}
```
The signature is passed alongside the order, not embedded in it: on-chain
`CLOBSettlement.verifyAndSettle(Order makerOrder, bytes makerSig, Order takerOrder, bytes
takerSig)` takes this 7-field `Order` plus two detached signatures (selector `0x538df8d8`).
Off-chain callers must match this exact ABI shape.

### Trading fee (CLOBSettlement)

```
fee = feeBps × min(p, 1−p) × Q  — computed on-chain as
      feeBps × min(tradePrice, amount − tradePrice) / 10_000
      (Q tokens carry Q USDC of notional; tradePrice is the buyer's gross USDC leg)
```

- **Who pays:** ONLY the carry-earning side — the YES seller and the NO buyer. YES buys
  and NO sells (flows that take on the funding-paying side) are fee-free. Maker/taker
  is irrelevant.
- **Why min(p, 1−p):** "buy NO at 1−p" ≡ "mint + sell YES at p" — the min-side base makes
  both routes cost the same fee, so mint can't be used to dodge it. (Measuring p on the
  gross leg is a second-order feeBps² deviation, accepted for on-chain simplicity.)
- **YES sale:** fee is deducted from seller proceeds exactly like the funding debit;
  the Option B safeguard extends to it — `tradePrice < debit + fee` reverts
  FundingShortfall with the position unchanged.
- **NO buy:** the contract can never pull USDC beyond a signed amountIn, so the buyer's
  signed `amountIn` is GROSS (position cost + fee); the fee-free seller's `minAmountOut`
  is checked against the NET amount (revert SlippageExceeded otherwise). The frontend
  sizes gross via the exact piecewise inversion `minGrossForNet` (lib/feeMath.ts,
  mirrored in order-book-server/src/fee.ts — keep all three in lockstep with
  CLOBSettlement.tradeFee).
- **Routing:** fee splits `insuranceShareBps` to InsuranceFund, remainder to teamWallet
  (launch: 50 bps, 50/50). Admin-editable via `setFeeConfig` (DEFAULT_ADMIN_ROLE,
  MAX_FEE_BPS = 500 cap); constructor leaves fee at 0 until configured. Fees NEVER touch
  CreditMarket collateral.
- **Off-chain:** order-book-server stores NO bids at their NET price (sorting/crossing
  basis; the rate is read live from CLOBSettlement.feeBps() and refreshed every 60s —
  FEE_BPS env is only the RPC-outage fallback, surfaced on GET /health) and includes the fee in the YES-sell
  FundingShortfall pre-filter + minSellProceeds hint. The matching-engine settler prunes
  SlippageExceeded pairs (deterministic for static amounts) like FundingShortfall.

### Backend Services

Every service serves ALL markets from one process, discovered via `MarketDirectory`
(`backend/shared/registry.ts`, copied per service by `sync-registry.sh`, CI-checked):
registry mode when `MARKET_REGISTRY_ADDRESS` is set, else legacy one-market `mstr` mode
from the old single-set env vars. Per-service multi-market detail: `backend/CLAUDE.md`.

```
/order-book-server  — REST: GET /markets, GET /orderbook?market=<slug> (no param = mstr),
                      POST /order (market derived from the order's token; 400
                      InvalidTokenPair / UnknownMarket / MarketInactive), DELETE /order/:id,
                      GET /health (per-market fee). Redis books namespaced
                      orderbook:<slug>:*; a recurring sweep migrates legacy keys
                      (mutations rate-limited per client IP). POST /order
                      (mutations rate-limited per client IP). POST /order
                      pre-filters against chain state (src/chain.ts, IChainReader/viem):
                      rejects flagged/claimable makers (PositionFrozen) and un-fundable
                      YES sells (FundingShortfall + minSellProceeds); fails open on RPC
                      error, on-chain check backstops.
/matching-engine    — price-time priority matching; submits matched pairs via
                      CLOBSettlement.verifyAndSettle. Decodes FundingShortfall/
                      PositionFrozen/SlippageExceeded/NonceUsed reverts at gas-estimation
                      and prunes the offending order(s) instead of retrying (other reverts
                      keep the retry behavior). Wires the settler when SETTLER_PRIVATE_KEY +
                      BASE_SEPOLIA_RPC_URL are set (log-only fallback otherwise).
                      Matches each market's book independently and settles on that
                      market's CLOB; refuses (prunes) any pair whose tokens aren't exactly
                      {USDC, that market's YES/NO} — CLOBSettlement itself doesn't check.
/funding-keeper     — accrueFunding() every epoch; flags (locks) any position
                      breaching the seizure trigger. Every active market, sequentially,
                      one market's failure isolated from the others.
/liquidation-keeper — exposes GET /claimable[?market=<slug>] (flagged positions +
                      formulaic price P, each tagged market/creditMarket/liquidationEngine);
                      does not claim itself — claiming is permissionless.
                      Both keepers discover YES holders from the token's Transfer
                      events (keepers/holder-index.ts; startup backfill + incremental
                      sync, progress in Redis) — no hand-maintained holder list.
/liquidator-bot     — (keepers/liquidator-bot.ts) the team's liquidator of last resort:
                      claims EVERY flagged position promptly, profitable or not
                      (stalls are what cost the InsuranceFund), simulating first and
                      alerting on a short float / short InsuranceFund / motion; then
                      sells the Upbet via clob-seller.ts — crosses the best bid down to
                      mark − SELL_MAX_DISCOUNT_BPS (3%), else rests an ask at the mark.
                      Own hot wallet; uses only claim() (works on old + fixed contracts).
                      All markets from one USDC float (alert vs the largest single claim)
                      and the SHARED InsuranceFund (alert vs concurrent tail shortfalls).
/oracle-monitor     — placeholder for ISDA DC scraper (manual multisig in MVP).
```

### Frontend (Next.js 14)

```
/app: / (market list), /market/[id] (id = slug; trading), /portfolio (all markets:
      balances + display layer + redeem), /admin (market picker; credit event, pause —
      team only), /liquidate (flagged across markets + claim)
/lib: markets.ts (useMarkets/useMarket — registry via NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS,
      else legacy one-market fallback), marketRegistry.ts (ABI copy), marketCopy.ts
      (per-slug long-form copy + corporate/sovereign fallback). Every component takes a
      `market` object; TradePanel's EIP-712 domain AND token addresses come from that one
      object (mitigates the CLOB token-validation gap); USDC approvals are per market.
/components:
  OrderBook, PriceChart, FundingTicker — standard market UI (poll /orderbook; TradingView
    Lightweight Charts; live annual-carry display)
  TradePanel  — signs EIP-712 orders; disables trading with an explanatory banner when
    the wallet is claimable/frozen; on YES sells shows "minimum sell price to cover
    carry + fee" and surfaces the server's FundingShortfall response inline; on NO buys
    signs a gross fee-inclusive amountIn and shows "Total … includes … trade fee";
    fee-free combos say "No trade fee on this order"; 6-decimal math (lib/feeMath.ts).
    Fee rate is read live from CLOBSettlement.feeBps() (lib/useFeeBps.ts, 60s refetch;
    NEXT_PUBLIC_FEE_BPS is only a preview fallback) — NO-buy signing is blocked until
    the live rate has loaded.
  PositionCard — Cost Basis, Equity, P&L, Breakeven Mark; YES adds Epochs To Expire with
    a warning as it nears zero. A distinct flagged panel shows a client-side cure-cost
    estimate (owed(user) minus pending NO credit — it keeps growing until cured or
    claimed) plus approve→cure(); redeem disabled while flagged, settleYES stays enabled.
  LiquidationCard — no discount ticker (P = min(owed, m×Q) from live state) — just P + Claim
```

`lib/creditMarketAbi.ts` is the shared CreditMarket/ERC20 ABI plus a `netFundingDebit`
helper. There is no buffer UI; Epochs To Expire is the only YES-side early-warning signal.

---

## Funding Model

**This is the canonical funding spec.** One contract carries the liquidation mechanism
(LiquidationEngine.sol); everything else is lightweight: no buffer, no Dutch auction, no
non-linear mark.

**Design guardrail:** `YES.totalSupply() == NO.totalSupply()` ALWAYS. Never burn YES alone
to enforce a funding cap — it orphans NO tokens whose paired YES no longer exists, still
credited funding no one pays. Retire a YES position only by transferring it to someone who
keeps paying (a liquidator), never by burning it unilaterally.

### Display layer (per holder, shown in UI — does not move cash)

```
Cost Basis (c)        = entry mark (the mark at which YES was bought)
Equity (E)             = m − f_now              // m = current mark, f_now = owed(user)
                                                  // per unit: fundingDebt ledger + live
                                                  // accrual since the snapshot
P&L                    = E − c = (m − c) − f_now
Breakeven Mark         = c + f_now               // mark needed for P&L = 0
Epochs To Expire (YES) = floor( (m/1.03 − f_now) / Δf ),  Δf = m × Δt/365
                          // epochs of runway until seizure trigger, holding m constant
```

`Epochs To Expire` is YES-only (NO never gets liquidated). Worked example at entry
(c = m = 0.05, f_now = 0, daily epoch): Δf = 0.05/365 ≈ 0.000137, Epochs To Expire =
(0.0485/0.000137) ≈ 354 days — consistent with "≈1 year of funding ≈ full token value."
Implemented as `equity`, `pnl`, `breakevenMark`, `epochsToExpire` views on `CreditMarket.sol`.

### Seizure trigger (solvency-based, cost-basis-independent)

```
f_now  = owed(user) / Q                      // owed = fundingDebt + Q × (cumYES − snapshot)
f_next = f_now + m × Δt/365                  // funding owed after one more epoch
Seize when:  m ≤ 1.03 × f_next               // 3% buffer, evaluated one epoch ahead
```

`f_now` MUST include the `fundingDebt` ledger: every CLOB trade (buyer included) moves
accrued debit into `fundingDebt` and resets the snapshot, so a snapshot-only f_now lets any
trade reset the liquidation clock (finding F4, fixed 2026-09-26). `owed(user)` is the single
definition of the YES-side obligation — the trigger, the claim price, cure and the display
layer all use it.

Implemented as `CreditMarket.isSeizable(user)`. This keys on **equity remaining relative to
token value**, never on P&L or cost basis. A holder deep underwater on the mark but current
on funding is left alone (negative MTM is never a liquidation trigger — they may be sitting
on cheap protection that pays par on a jump-to-default). Cost basis must NOT appear in the
trigger: two holders with identical funding/mark exposure but different entry prices must be
equally liquidatable, or one gets a free option at the other's (and NO's) expense. The 3%
buffer doubles as the liquidator's profit margin — the incentive that makes someone actually
claim the position.

**Flag semantics (a lock, not a freeze):** once flagged (`CreditMarket.flagClaimable`,
KEEPER_ROLE), the position is fully locked — no `mint()`, no `redeem()`, no CLOB trade on
either side (all revert `PositionFrozen`), and it can't act as a liquidator. Funding keeps
accruing: there is NO accounting freeze (a freeze let the paired NO keep earning credit
nobody paid for — finding F1). The only exits are a liquidation claim
(`LiquidationEngine.claim`), `cure()` (the holder pays the live `owed()` in cash net of NO
credit, keeps the YES and the sliver a claimant would otherwise earn), or `settleYES` after
a credit event (which auto-cures, collecting `owed()` from the payout before clearing the
flag).

### Liquidation math (formulaic, no Dutch auction)

When the trigger fires, the keeper flags (locks) the position. The claim is priced at
CLAIM time from live state — deterministic within the claiming block:

```
At claim time: owed = owed(user) (ledger + accrual to this block); m = current mark.

Claim (anyone, first to call — no auction, no discount ramp): P = min(owed, m × Q)

  NORMAL CASE (owed ≤ m×Q — expected when claimed promptly, given the 3% buffer):
    Liquidator pays P = owed USDC → into collateral (NO made whole, untouched).
    YES token TRANSFERS to liquidator (NOT burned); liquidator's funding snapshot resets
      to now — fresh start, inherits full value m, owes no back-funding.
    Residual (m − P ≈ 0.03×m) is NOT returned to the original holder — it is the
      liquidator's profit for executing the seizure (they resell the YES for ≈ m).

  TAIL CASE (owed > m×Q — mark gap, keeper downtime, or a claim that waited too long):
    Liquidator pays P = m×Q (full token value) → into collateral.
    InsuranceFund tops up the shortfall (owed − m×Q) → into collateral, so NO is ALWAYS
      made whole. YES still transfers to liquidator at P = m×Q (fair — full value paid).
```

**Stall economics:** the claimer's margin (`m×Q − owed`) starts at ≈3.2% of `m×Q` (the 3%
buffer plus the one-epoch look-ahead, less keeper lag) and shrinks by one day of carry
(`m×Q/365` ≈ 0.27% of `m×Q`) per day unclaimed, so at a constant mark a position crosses
into the tail case ≈11–12 days after flagging; a falling mark gets there sooner. From then
on every further day of stall costs the InsuranceFund one day of carry — paid only when
someone finally claims. Stalls are an operational risk: run a claiming liquidator bot.

**Claim touches ONLY the YES side:** the holder's NO-side credit is NOT netted, paid out, or
forfeited during a claim — `snapNO` is untouched and pays out at their own next settlement
touchpoint. No USDC is ever pushed to the original holder inside `claim()` (pull-over-push).

**Not "sold at zero":** the YES token is *transferred*, not burned — it still carries full
value `m`. Paying zero would short NO the funding already promised to it; `P = owed` settles
that promise, and the liquidator's profit is only the buffer sliver (`m×Q − owed`) — the same
sliver a seller keeps on a normal CLOB sale, just redirected to whoever performs the seizure.

### Funding settlement points (unified per-user `settleFunding` + `fundingDebt` ledger)

Funding accrues as a number via the indices, but **cash moves only at these points**. On
every CLOB sale, `CreditMarket.settleFunding(seller)` nets accrued funding over the seller's
FULL YES/NO balances (not just the amount sold) and resets both snapshots to now. A net
credit pays out immediately from collateral. A net debit is **recorded in the persistent
`fundingDebt[user]` ledger**, not forgiven — `settleFunding` folds any prior
`fundingDebt[user]` into the netting (`debit = fundingDebt[user] + yesOwed` vs `noCredit`)
first. Without this ledger, an uncollected debit would vanish the moment snapshots advance,
silently depleting collateral. The buyer settles the same way via `settleFunding(buyer)`,
but a buyer's (or a NO-seller's) net debit is **not** collected at trade time — it persists
in `fundingDebt` until that holder's own next touchpoint, so one party's debt never blocks a
third party's fill.

```
mint/redeem/settleYES: settleFunding(user) — credit paid out, debit folds into/out of
                        fundingDebt against the payout (zeroed on redeem/settleYES)
liquidation:            LiquidationEngine.claim prices P = min(owed(user), m×Q) at
                        claim time; the liquidator is settleFunding'd first (its own
                        NO credit paid, YES debit recorded) (see Liquidation math)

CLOB sale — NO side (seller selling NO): settleFunding(seller) nets full position —
  net credit paid in cash immediately (fundingDebt zeroed); net debit recorded in
  fundingDebt[seller], NOT collected now, does not block the trade. Seller receives
  tradePrice + any credit. snapNO[seller]=snapNO[buyer]=cumFundingPerNO (buyer starts
  fresh). settleFunding(buyer) also runs — buyer's own debit (if any) lands in fundingDebt.

CLOB sale — YES side (seller selling YES): settleFunding(seller) → debit =
  fundingDebt[seller] + yesOwed. require tradePrice ≥ debit — OPTION B SAFEGUARD: if the
  fill would clear below debit, REVERT FundingShortfall; position UNCHANGED, NOT routed to
  liquidation (still solvent, above trigger). Otherwise seller receives tradePrice − debit;
  CLOB_ROLE calls markDebtCollected(seller) to zero fundingDebt. snapYES[seller]=
  snapYES[buyer]=cumFundingPerYES. settleFunding(buyer) also runs.
```

**Worked examples:** NO sells at $95 w/ $25 credit → seller nets $120. YES sells at $30 w/
$8 debit → seller nets $22, $8 collected via markDebtCollected. YES tries to sell at $5 w/ $8
debit → REVERT FundingShortfall; position unchanged, still owes $8, not liquidated. The
shortfall case requires BOTH thin equity (near but above the 3% trigger) AND thin bid-side
liquidity — a healthy position, or a sale into a deep book, never hits it.

**Off-chain pre-filter (UX):** `POST /order` rejects at submission — a flagged/claimable
maker's order (either side) → `400 PositionFrozen`; a YES sell whose `minAmountOut` can't
cover `fundingDebt(maker) − previewFunding(maker, fullYesBalance, true)` (clamped at 0) →
`400 FundingShortfall` with `minSellProceeds` for the UI. Chain reads
(`order-book-server/src/chain.ts`, `IChainReader`, viem) **fail open** on RPC error — the
on-chain check is the backstop; this filter is pure UX.

### Critical invariants (enforce in code AND tests)

```
1. Cost basis is NEVER part of the seizure trigger. Trigger keys only on equity vs mark.
2. Negative MTM is NEVER a liquidation trigger by itself — only equity-vs-mark matters.
3. YES tokens are NEVER burned in liquidation — only TRANSFERRED. Complete-set invariant
   (YES.totalSupply() == NO.totalSupply()) must hold before and after every liquidation.
4. NO holders are ALWAYS made whole on a liquidation — P = owed in the normal case,
   topped up by InsuranceFund in the tail case. NO is never haircut, and collateral always
   backs every outstanding pair (no accounting freeze may break this — F1).
5. FREEZE all flagging and claims during a pending credit-event motion (motionPending).
   Never seize someone's protection at a discount moments before it could pay.
6. Liquidation claims are permissionless and first-come — no single liquidator is
   load-bearing. (Known MVP limitation: first-valid-tx-wins has MEV/front-run exposure;
   acceptable for MVP, revisit with private relay if it becomes a problem.)
7. EVERY settlement path (mint, redeem, settleYES, CLOB sale, liquidation) nets accrued
   funding per-user via `settleFunding`, over the user's full YES/NO balances, folding in
   any prior `fundingDebt`. A net credit is paid out in cash immediately; a net debit is
   NEVER forgiven just because snapshots advance — it persists in the `fundingDebt` ledger
   until collected at the holder's next redeem/settleYES/YES-sale proceeds/liquidation.
8. A YES sale that would clear BELOW the seller's net debit (fundingDebt + yesOwed) REVERTS
   and leaves the position completely unchanged. It is NEVER force-liquidated by a failed
   sale — the position is still above the seizure trigger and solvent. Liquidation is
   reached only by the trigger, never by a sale attempt.
9. A net funding debit recorded in `fundingDebt` is NEVER erased without the equivalent
   USDC landing in (or staying in) collateral — snapshots may advance, but debt persists
   until collected.
10. A flagged (claimable) position is fully locked — no mint, redeem, CLOB trade on
    either side, or acting as a liquidator — while its funding keeps accruing (owed() is
    non-decreasing while flagged). The only exits are claim(), cure(), or
    post-credit-event settleYES. Liquidation itself touches ONLY the YES side: the
    holder's NO-side credit survives a claim untouched.
```

**Findings fixed and deployed to Base Sepolia 2026-10-01** (batch-1 redeploy): F4 (trigger
ignored the ledger), F1 (flag froze accounting), F2 (liquidator NO credit forfeited) —
`docs/security/invariant-findings-2026-09-26.md`.

### What stays true across model iterations

- Complete-set invariant: 1 YES + 1 NO ← $1 collateral, redeemable for $1, resolves $1/$0.
- Zero recovery. YES settles at full notional on credit event.
- Off-chain CLOB, on-chain settlement.
- Linear token mark (price = hazard rate). Funding model changes do not change the mark
  function. (Known tradeoff: the true 12-month default probability is 1 − e^(−h), so a
  linear mark overstates it by ≈ h²/2 and lacks curvature — ~0.02 pts at 2%, ~0.5 pts at
  10%, ~2.5 pts at 23%. Acceptable for the launch markets; avoid listing entities far above
  MSTR's level until the v2 non-linear mark.)

---

## Funding Model v2 (FUTURE — not building now)

Documented for the roadmap only. v2 would add a per-wallet prepaid USDC buffer (so YES
holders get runway before liquidation, rather than relying solely on token-value headroom)
and a Dutch-auction discount ramp (rather than a fixed formulaic price), plus a non-linear
token mark V=(1−e^(−s)) for correct convexity at high hazard rates. Also a v2 candidate
(decided 2026-07-11): `prepayFunding()` — voluntary cash settlement of accrued funding for
UNFLAGGED holders (zeroes fundingDebt, resets snapshots, pushes the seizure trigger away);
a mild precursor of the buffer. Explicitly NOT building a fee-only top-up for
FundingShortfall-blocked YES sales — the blocked band is ≤ fee-width (~0.5% of proceeds)
and the escape is one price tick; cure() remains exclusively the flagged-position exit. The current model
already has the core liquidator mechanism and the no-free-option guarantee — v2 only adds
runway and pricing refinements. Build only after the current model validates PMF and the
no-buffer tradeoff (tighter, more frequent liquidations) proves to be a real UX problem.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Smart contracts | Solidity 0.8.x, Foundry, OpenZeppelin v5 |
| Chain | Base (EVM) |
| Frontend | Next.js 14 (App Router), TypeScript, wagmi v2, viem, RainbowKit, Tailwind CSS |
| Charts | TradingView Lightweight Charts |
| Order book server | Node.js, TypeScript, Fastify, Redis (order state) |
| Indexing (MVP) | Direct RPC + event polling (no subgraph until V2) |
| Wallet | RainbowKit + wagmi v2 |
| Testing | Foundry (contracts), Vitest (frontend/backend) |
| Deployment | Base Sepolia → Base mainnet |

---

## Smart Contract Standards

- All contracts use OpenZeppelin v5 (`AccessControl`, `ReentrancyGuard`, `Pausable`) —
  plain contracts, not upgradeable/proxy
- `AccessControl` roles (`CreditMarket.sol`): `DEFAULT_ADMIN_ROLE`, `ORACLE_ROLE`,
  `KEEPER_ROLE`, `PAUSER_ROLE`, `CLOB_ROLE`, `LIQUIDATOR_ROLE`. Token contracts
  (`YESToken.sol`/`NOToken.sol`) each additionally define `MINTER_ROLE`, `BURNER_ROLE`,
  `CLOB_ROLE`. `InsuranceFund.sol` defines its own `LIQUIDATOR_ROLE` for
  `LiquidationEngine`'s tail-case top-up.
- `ReentrancyGuard` on every function that transfers USDC or YES/NO tokens
- Pull-over-push for all USDC payouts — never push to arbitrary addresses
- YES/NO token transfers restricted to `CLOB_ROLE` and CreditMarket via `_update()` override
- `Pausable` on CreditMarket — PAUSER_ROLE halts market during determination window
- Emit events on every state change: TokensMinted, TokensRedeemed, YESSettled,
  FundingAccrued, CreditEventTriggered, FlaggedClaimable, FundingSettled, PositionCured
  (pause uses OZ `Pausable`'s standard Paused/Unpaused)

---

## Core Math

**Mint (deposit USDC, receive YES + NO tokens 1:1):**
```
yesAmount = usdcIn
noAmount  = usdcIn
invariant: YES.totalSupply() == NO.totalSupply() always (fully collateralized)
```

**Redeem (burn 1 YES + 1 NO, receive 1 USDC — pre-settlement only):**
```
usdcOut = tokenAmount × 1  (always 1:1, YES+NO pair = 1 USDC)
```

**Funding accrual, seizure trigger, and liquidation pricing:** see the "Funding Model"
section above — it is canonical; formulas are not restated here.

**Credit event settlement:**
```
YES token → burns at 1 USDC each  (full notional, zero recovery)
NO token  → worth $0, no redemption
```

**CLOB trade price:**
```
Buying  YES: pay P USDC per YES token  (P = current market ask, 0 < P < 1)
Selling YES: receive P USDC per YES token
Price P represents the market-implied annual default probability
```

---

## UX / Naming Conventions

**Product name:** Pari ("Pari — Tradable Credit For All"). Brand assets: `Pari Brand
Guidelines.html` + design tokens vendored at `frontend/styles/pari/` (Direction A "Analyst"
for nav/landing/portfolio, Direction B "Trader" for market/orderbook/liquidate).

**Never use in UI:** hazard rate, bps, basis points, protection buyer/seller, notional,
token, YES/NO (internal names only — code, ABIs, and API fields keep yes/no)

**Always use in UI:**
- "Upbet" / "Downbet" (Upbet = YES internally = long default risk, pays carry;
  Downbet = NO internally = earns carry). Colors: Upbet = `--color-danger`,
  Downbet = `--color-teal`; positive P&L stays `--color-success`.
- "X% annual probability"
- "Daily carry" (not funding rate)
- Market title: "Will [Entity] have a credit event in the next 12 months?" (e.g. "Will
  MicroStrategy have a credit event in the next 12 months?")
- Price: "23.4% chance"
- Upbet costs 23.4¢ per $1 / Downbet costs 76.6¢ per $1
- "Your position: $500 Upbet @ 23.4% entry"

---

## What NOT to Build in MVP

```
❌ Gnosis CTF / ERC-1155 (custom ERC-20 YES/NO tokens for MVP)
❌ LP vault / LPToken (team wallet is liquidity provider)
❌ MarketFactory / on-chain factory (markets added by AddMarket.s.sol + MarketRegistry)
❌ Permissionless market listing / cross-market margin or netting
❌ Shared multi-market CLOBSettlement (per-market CLOBs for MVP; v2 candidate)
❌ ISDA oracle relayer (multisig only)
❌ USDC bond module for credit event disputes
❌ Subgraph / The Graph (direct RPC polling only)
❌ Fee distributor contract (trading fees route directly 50/50 to team wallet +
   InsuranceFund at settlement time — no accrual, no claim flow)
❌ Referral system
❌ Governance
❌ Insurance fund withdrawals (fund only receives in MVP)
❌ Market listing UI
❌ Mobile optimization (desktop-first)
❌ Wallet-to-wallet YES/NO transfers (CLOB_ROLE restricted only)
```

---

## Reference Links

- OpenZeppelin v5: https://docs.openzeppelin.com/contracts/5.x/
- Foundry book: https://book.getfoundry.sh/
- wagmi v2 signTypedData: https://wagmi.sh/react/api/hooks/useSignTypedData
- Base docs: https://docs.base.org
- EIP-712 spec: https://eips.ethereum.org/EIPS/eip-712
- Polymarket CLOB (reference): https://github.com/Polymarket/clob-client
- PRBMath (fixed-point exp/ln for markValue): https://github.com/PaulRBerg/prb-math
- Everlasting options (White & Zhou) — funding model basis: search "everlasting options paper"
