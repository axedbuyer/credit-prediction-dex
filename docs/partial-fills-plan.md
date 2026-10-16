# Partial fills + on-chain cancel — plan for the next contract batch (batch 3)

*Written 2026-10-15. Status: **plan, not started; open decisions in §6 need the owner.**
Read with root `CLAUDE.md` ("No partial fills", "Order removal policy", Funding Model).*

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

## 2. What changes on-chain (CLOBSettlement only)

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
- **liquidator bot:** `clob-seller.ts` can cross the best bid for any amount and rest
  the remainder at the mark, as designed.
- **frontend:** the order book shows remaining sizes. The portfolio lists open orders as
  "2 of 4 filled". Adds a "cancel on-chain" button. USDC approval is still per market,
  but to the new CLOB address.

## 4. Rollout: a new CLOB per market, positions untouched

Only `CLOBSettlement` changes, so the plan is to **keep every CreditMarket, YES/NO token,
OracleRouter and LiquidationEngine**, and therefore every user's position:

1. Deploy a new `CLOBSettlement` per market, pointing at that market's existing
   CreditMarket, USDC, YES and NO. Set its fee config (50 bps, 50/50).
2. Grant the new CLOB `CLOB_ROLE` on CreditMarket, YES and NO. Revoke the old CLOB's role.
3. Registry entries are immutable and `clobSettlement` is part of the entry, so this needs
   a **new MarketRegistry** registering the same market contracts with the new CLOB.
   `register()` checks that the CLOB points at the same CreditMarket, USDC and tokens, so
   it should pass. Verify this in the fork rehearsal.
4. Clear Redis `orders:*`, `orderbook:*` and `nonces:*`. Every resting order is signed
   for the old CLOB's EIP-712 domain. Users re-approve USDC to the new CLOB.
5. Flip `MARKET_REGISTRY_ADDRESS` on Railway and Vercel, then re-seed. Same flow as the
   batch-2 runbook, minus the market wind-down.

Rehearse on an anvil fork first, as for batch 2. The rehearsal must check:
- a partial fill on the re-seeded book;
- an old-CLOB order reverting after the role revoke;
- all 10 invariants under the extended invariant suite.

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

## 6. Decisions for the owner

**A. Carry debt when a YES position is sold in pieces.** Today a YES sale must cover the
seller's whole carry debt or it reverts (FundingShortfall, invariant 8). With partial
fills, a small fill might not cover a large debt, and the engine would then prune a
healthy seller's order because of a small counterparty: the same griefing pattern again.
Options:
1. **Pro-rata (recommended):** each fill collects `debt × tokens sold / YES held` and
   must cover that share plus its fee. The debt per remaining token is unchanged, so the
   seizure trigger and Epochs To Expire don't move. The final fill collects the rest.
   Invariants 8 and 9 still hold per token.
2. **Whole debt on the first fill:** keeps today's rule. Small fills against a seller
   with debt revert, and those pairs must be skipped, not pruned.
3. **Up to the fill's proceeds:** collect `min(debt, proceeds)`. Simplest, but a seller
   could sell all their YES in pieces while debt is left on a position with no YES
   behind it. Breaks invariant 9. Not recommended.

**B. Minimum fill size.** Tiny fills waste settler gas, and a 1-wei fill would round to
zero USDC. Suggest a per-market minimum (e.g. 1 Upbet), with the last remainder of an order
always allowed.

**C. Cancel scope.** Per-order `cancelOrders` only, or also a per-maker
`incrementMinNonce` "cancel everything" (useful for the market maker and the liquidator
bot). Suggest both.

**D. Batch fills.** Ship the pair form only, or also one-taker-many-makers in a single
transaction. Suggest pair-only first; batch later if settler gas matters.

## 7. Size

Roughly the batch-2 effort:
- Contract work concentrated in `CLOBSettlement` plus tests.
- Moderate changes in matching-engine, order-book-server and the frontend.
- One redeploy that keeps every position: new CLOBs and a new registry, with no market
  wind-down.
