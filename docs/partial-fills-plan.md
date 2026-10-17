# Partial fills + on-chain cancel — batch 3

*Written 2026-10-15. Status: **BUILT 2026-10-16 on `feat/partial-fills` (not deployed). All
decisions A–E made 2026-10-16 (§6). Rollout = a FULL redeploy of every market (§4),
runbook `docs/redeploy-batch3-runbook.md`.** Read with root `CLAUDE.md` ("Partial fills",
"Order removal policy", Funding Model). §2–§3 are the original plan; "As built" notes mark
where the code differs.*

## 1. Why

`CLOBSettlement.verifyAndSettle` settles two orders **whole**: it moves both orders' full
`amountIn` and spends both nonces. Two valid orders at crossing prices but different sizes
can never trade. On Sepolia a 1-Upbet buy at 24¢ could not fill against a 4-Upbet ask at 24¢.

Until 2026-10-15 the matching engine paired orders on price alone, and the settler deleted
BOTH orders when such a pair reverted, so anyone could wipe a market maker's quote with
a tiny order. The engine now only pairs orders that can settle whole and never deletes
for a size mismatch (stopgap, PR "whole-order matching"). But trading still only happens
between near-identical sizes:

- A user's $10 buy rests forever next to a $25 ask at a better price.
- The book can show a "crossed" spread (bid ≥ ask) that never trades.
- The liquidator bot's "cross the best bid" (`keepers/clob-seller.ts`) posts its whole
  claimed position, so it only crosses a bid of exactly that size; otherwise it just rests.

Partial fills fix all three: an order fills in pieces against any number of counterparties
until it is used up, cancelled or expired. This is how Polymarket's CTF Exchange works.

### A second, related gap: cancelling isn't binding

`verifyAndSettle` is callable by anyone, and `GET /orderbook` publishes the signed orders.
`DELETE /order` only removes the order from our off-chain book, so anyone who saved the
signature can still settle it until it expires. Frontend orders expire after 1 hour; the
market-maker seed orders (`scripts/demo/mm-sepolia-seed.ts`) after 7 days. The fix belongs
to the same contract change: an on-chain cancel.

## 2. What changes on-chain (CLOBSettlement, plus a small CreditMarket change)

> **As built:** decision A needs `CreditMarket.collectDebt(user, amount)` (replacing
> `markDebtCollected`, which could only zero the whole debt), so CreditMarket changes too —
> hence the full redeploy in §4. The batch-3 invariant run also found that flooring every
> YES debit let collateral drift < 1 wei short per settlement; YES debits now round UP
> (`CreditMarket._yesDebit`), NO credits stay rounded down.
>
> Size is in outcome tokens (`tokenQuantity`: a bid's `minAmountOut`, an ask's `amountIn`).
> `filled[hash]` counts tokens; `spent[hash]` counts the USDC a buy order has paid and is a
> hard cap at its signed `amountIn`, so rounding can never pull more than the buyer signed.
> Per fill: buyerCap = min(ceil(q × B_usdc / B_tokens), amountIn − spent); makerPrice = a
> YES maker-seller's ceil(q × minAmountOut / amountIn), a NO maker-seller's
> `minGrossForNet` of that, a maker-buyer's buyerCap; tradePrice = min(makerPrice,
> buyerCap); the seller's floor(q × minAmountOut / amountIn) must hold (gross for YES, net
> of fee for NO) else SlippageExceeded; a 0 price reverts FillTooSmall. Cancel-all is
> `setMinNonce(n)` (not `incrementMinNonce`) so ms-timestamp nonces work. Fuzz:
> `testFuzz_SplitFills_NeverCrossLimits`.

**Fill tracking replaces the nonce flag.**
`mapping(bytes32 orderHash => uint256 filled)` (in units of the order's `amountIn`)
replaces `usedNonces`. An order is live while `filled < amountIn`, it isn't cancelled and
it hasn't expired.

**Settlement takes a fill size.**
```
fillOrders(Order maker, bytes makerSig, Order taker, bytes takerSig, uint256 tokens)
```
`tokens` is how many YES/NO change hands in this fill. Later, a batch form (one taker
against several makers in one transaction) saves gas; start with the pair form.

**Price = the maker's limit price** (the resting order's price; the taker gets any
improvement). Today the trade runs at the buyer's full `amountIn`, which only makes sense
for whole orders. Per fill:
```
makerPrice  = maker's USDC side / maker's token side            (as a ratio, no division)
usdc        = tokens × makerPrice, rounded in the MAKER's favour
taker limit : usdc / tokens must not be worse than the taker's own limit
              (checked by cross-multiplying, never by dividing)
both orders : this fill must not exceed what remains of either order
```
Rounding rule: no party ever trades beyond its signed limit, even by 1 wei. Foundry fuzz
tests must prove it.

**On-chain cancel.** `cancelOrders(Order[])`, callable only by each order's maker, sets
`filled = amountIn`. Possibly also `incrementMinNonce()` to cancel everything at once
(decision C below). `DELETE /order` stays as the cheap off-chain path, and the frontend
offers "cancel on-chain" for real certainty.

**Fees stay the same formula, per fill:** `tradeFee(tokens, usdc)`. It is linear in size,
so fills add up to the same fee as one whole trade (up to rounding, which goes against the
fee payer). NO buys sign a GROSS `amountIn` (cost + fee) today. A partial fill of a NO bid
uses that gross amount pro rata, and the fee-free seller's NET check runs per fill. All
three fee-math copies change in lockstep: `CLOBSettlement`, `frontend/lib/feeMath.ts`,
`order-book-server/src/fee.ts`.

**Funding per fill.** `settleFunding(seller)` and `settleFunding(buyer)` already run on
every trade, so they run per fill unchanged. The one rule that needs a decision is how a
YES seller's carry debt is collected when the sale happens in pieces (decision A).

## 3. What changes off-chain

- **order-book-server:** stores each order's remaining size. `GET /orderbook` shows
  remaining sizes and drops fully filled orders. The FundingShortfall pre-filter and the
  `minSellProceeds` hint follow decision A. `DELETE /order` documents that it is
  off-chain only.
- **matching-engine:** walks the book by price-time priority and fills
  `min(remaining bid, remaining ask)` per pair. One order can fill against several
  counterparties in one cycle. The remaining size is updated only after the fill
  confirms, so a reverted fill changes nothing. `canSettleWhole` and `markIncompatible`
  are deleted. Order removal policy is unchanged: only filled, cancelled, expired or
  own-state reasons.
  *As built:* one fill per order per cycle (the next fill waits until `filled` is
  recorded); the earlier order is the maker. `markIncompatible` stays for
  SlippageExceeded / FillTooSmall (a valid pair that can't trade at this size).
  FillExceedsRemaining / OrderInvalidated / OrderExpired / InvalidOrder re-read
  `remaining()`: 0 → prune, else resync `filled`.
- **liquidator bot:** `clob-seller.ts` can cross the best bid for any amount and rest
  the remainder at the mark, as designed.
- **frontend:** the order book shows remaining sizes. The portfolio lists open orders as
  "2 of 4 filled". Adds a "cancel on-chain" button. USDC approval is still per market,
  but to the new CLOB address.
  *As built:* a "Your Open Orders" card on the market page (remaining "of" size, Cancel →
  `cancelOrders`, "Cancel all in this market" → `setMinNonce(Date.now())`), then
  `POST /orders/sync` (new order-book-server route: drops that maker's orders whose
  `remaining()` is 0 — objective state, no signature). TradePanel: 1-Upbet minimum and
  the pro-rata carry share on YES sells.

## 4. Rollout: a FULL redeploy of every market (decided 2026-10-16)

The original plan here (new CLOBs only, positions kept) no longer works: decision A needs
`CreditMarket.collectDebt`, so CreditMarket changes. The owner chose **pro-rata + full
redeploy**, the same shape as batch 2: a fresh contract set for every market under a new
MarketRegistry, the batch-2 markets wound down (paused, deactivated; holders redeem), Redis
cleared, Railway + Vercel flipped to the new registry, books re-seeded. New in batch 3:
`OPERATOR_ADDRESS` (the matching-engine settler) gets CLOBSettlement `OPERATOR_ROLE` in
`AddMarket.s.sol`, and order-book-server reads `MIN_ORDER_TOKENS` (default 1 Upbet).
Step by step: `docs/redeploy-batch3-runbook.md`.

## 5. Tests

- **Foundry unit + fuzz:**
  - fills never exceed either order;
  - no party ever trades beyond its limit, whatever the rounding;
  - fees over N fills equal the whole-trade fee to within N wei, against the payer;
  - cancel by the maker only;
  - cancelled, expired and fully filled orders revert;
  - NO-buy gross/net per fill.
- **Invariant suite:** add random partial fills and cancels to the existing handlers.
  Complete-set supply, collateral backing, and `filled ≤ amountIn` for every order.
- **Off-chain:** engine multi-fill walks; remaining-size bookkeeping across a reverted
  fill; the pre-filter under decision A.
- **Smoke:** a new check where a small taker partially fills a large resting ask, then a
  second taker fills the rest. The 11 existing checks must stay green.

## 6. Decisions

Owner decisions of 2026-10-16: all of A–E decided.

**A. Carry debt when a YES position is sold in pieces: PRO-RATA (decided).** Today a
YES sale must cover the seller's whole carry debt or it reverts (FundingShortfall,
invariant 8). With partial fills, a small fill might not cover a large debt, and the
engine would prune a healthy seller's order because of a small counterparty.

Each fill instead collects `debt × tokens sold / YES held`. The fill's price must cover
that share plus the fee, or the fill reverts and the position is unchanged (invariant 8,
per fill). The debt per remaining token stays the same, so the seizure trigger and Epochs
To Expire don't move. Selling the last YES collects the rest. Invariant 9 holds: no debt
is erased without the matching USDC reaching collateral. The off-chain FundingShortfall
pre-filter and `minSellProceeds` switch to the per-fill share.

Rejected:
- whole debt on the first fill (small fills against an indebted seller would revert);
- `min(debt, proceeds)`, which can leave debt on a position with no YES behind it and
  breaks invariant 9.

**B. Minimum size: DECIDED — 1 Upbet/Downbet, off-chain only** ("go for 1 Upbet
minimum at this stage"; `MIN_ORDER_TOKENS`, default 1_000_000, one value for all markets).
Research that led there: For comparison, Polymarket's CTF
Exchange has **no on-chain minimum fill**: `fillOrder`, `fillOrders` and `matchOrders`
take any fill amount up to what remains of the order (`MakingGtRemaining` otherwise).
The minimum is an off-chain rule applied when an order is placed: each market's book
carries a `min_order_size` (and a `tick_size`). The clob-client types and the docs example
use 5 shares. The remainder of a partly filled order may fall below the minimum and still
fill.

Dust fills aren't a problem for Polymarket because only its operator can call the fill
functions (`onlyOperator`), so nobody else can submit 1-wei fills (see E).

Recommendation: copy that.
- A per-market minimum order size enforced by `POST /order` (suggest 5 Upbets, set per
  market in the order-book-server).
- No on-chain minimum. The contract only rejects a fill that rounds to 0 USDC.
- Leftovers below the minimum still fill.

**C. Cancel scope: BOTH (decided).** Per-order `cancelOrders(Order[])`, maker only, plus
per-maker "cancel everything" — built as `setMinNonce(n)` (n must increase). Polymarket has the same pair:
`cancelOrders` and `incrementNonce`.

**D. Batch fills: PAIR-ONLY first (decided).** `fillOrders(maker, taker, tokens)`.
One-taker-many-makers comes later, if settler gas matters.

**E. Who may submit fills: DECIDED — operator-only** (`OPERATOR_ROLE`, the settler). Today `verifyAndSettle` is permissionless.
Polymarket restricts every fill to an operator role. Doing the same, with an
`OPERATOR_ROLE` held by the settler wallet:
- stops anyone else choosing fill sizes, which removes dust griefing (B);
- makes `DELETE /order` binding in practice, since only our operator settles and it
  honours off-chain cancels;
- costs nothing, because the matching engine's settler is already the only caller.

The trade-off: if the operator is down, nothing settles. That's already true in practice.
On-chain cancel (C) remains the guarantee that doesn't depend on trusting us.
Recommendation: operator-only.

## 7. Size

Roughly the batch-2 effort:
- Contract work concentrated in `CLOBSettlement` plus tests.
- Moderate changes in matching-engine, order-book-server and the frontend.
- One full redeploy (every market, new registry, wind-down of batch 2) — see §4.
