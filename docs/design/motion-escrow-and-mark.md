# Design: informational motions, carry escrow from the EDD, trade-following mark

Status: **DRAFT for owner sign-off, 2026-11-18.** Nothing here is built. It replaces the
"freeze during a motion" design in PR #22, which is on hold. The guards that block
flagging and claims after confirmation, and the `OracleRouter.setMotionPending`
forwarder, carry forward. Target: batch 4.

## 1. Why

The motion freeze (current invariant 5) protects Upbet holders while the DC decides, but
carry keeps accruing during the freeze. If the DC says "No", the motion closes and some
Upbet holders are suddenly far past the trigger. Covering that with the InsuranceFund
would backstop a design flaw rather than a real tail risk.

The new model:

1. **A motion is informational.** Trading, flagging, liquidation claims, cure, mint and
   redeem all run normally while a motion is open.
2. **Carry stops at the EDD, but only if the event is confirmed.** The motion records an
   index snapshot. Carry accrued after it is held in escrow per address. On a DC "Yes",
   all post-EDD carry is cancelled: Upbet debt is forgiven and post-EDD cash payments are
   refunded to whoever paid them. On a DC "No", the escrow is released to Downbet holders
   and post-EDD Upbet debt becomes ordinary debt.
3. **Upbet holders protect themselves by paying carry.** `cure()` is open to every Upbet
   holder at any time ("Pay carry" in the UI), and a health alert warns them well before
   the trigger.
4. **The mark follows trades**, so solvency during stress is judged at the market's price,
   not at a stale seed.

A holder who lets their position become seizable during a motion and gets liquidated
before a "Yes" carries that outcome themselves, like a protection buyer who fails a
margin call the day before the ruling.

## 2. Today vs this design

| | Today (batch 3) | This design |
|---|---|---|
| Who moves `currentMark` | Seed at deploy; admin `adminSetMark` only. No service calls `setMark`. CLOB fills never write it. | Mark updater service from fills and the book (§3) |
| Flag/claim during a motion | Frozen (`MotionInProgress`, `MotionPending`) | Normal |
| Flag/claim after confirmation | Allowed on batch 3 (bug); blocked by PR #22 | Blocked (PR #22 guards) |
| Carry after the EDD | Paid in cash like any carry | Escrowed per address until the ruling (§5) |
| `cure()` | Flagged positions only; blocked while paused | Any Upbet holder; works while paused (§4) |
| Warning before a flag | Epochs To Expire on PositionCard | Health score with alert levels (§4) |

## 3. Mark updater

**Problem.** `currentMark` drives the carry rate, Equity, the trigger, the claim cap m×Q and
cost basis on mint, but nothing connects it to trading. During stress, the book could trade
Upbets at 80¢ while the mark reads 10%. Downbets then earn carry below fair, and an Upbet
holder who owes about 10¢ per token is seized for about 10¢ when the market prices the token
at 80¢.

**Design.**
- A new keeper loop (in `funding-keeper` or its own service) computes a mark per market:
  - a time-weighted average of fill prices over a short window;
  - when there are too few fills, the book mid, counting only quotes with real size behind
    them;
  - no update when neither source is usable (the mark holds; alert).
- Jumps are allowed in both directions, and a downward jump counts for flagging
  immediately. Owner decision: no waiting period; the protection is the health alert plus
  pay-carry-anytime (§4). A holder whose carry is paid owes about nothing, so a falling
  mark can't seize them: the trigger needs m ≤ 1.03 × (owed + one day of carry).
- On-chain bounds: raise `maxMarkStep` so a repricing lands in at most one or two updates,
  and shorten `minMarkInterval`. Proposed starting point: 50 points per step, 10 minutes
  apart (decided, Q2).
- Key risk: a compromised mark key could post a bad mark. The admin can revert with
  `adminSetMark`, and holders who keep carry paid are unaffected. The mark gets its own
  `MARK_ROLE`, separate from the flagging `KEEPER_ROLE` (Q4).

**Not changed:** the carry formula, the trigger formula, and the claim price.

## 4. Pay carry anytime, and the health score

**`cure()` for every Upbet holder.** `cure()` already settles funding, nets Downbet credit,
takes the remaining debt in cash and resets the clock. Changes:
- remove the `PositionNotFlagged` check (clear the flag only if set);
- remove `whenNotPaused` (curing only adds collateral; today a paused market lets a holder
  be flagged and claimed but not cure);
- block it after confirmation (settleYES auto-cures instead);
- UI label: **"Pay carry"**.

This replaces the `prepayFunding()` item on the v2 roadmap and the rule that `cure()` is
only the flagged-position exit.

**Health score.** It is shown on PositionCard and Portfolio, and returned by
`/claimable` (or a new `/health` endpoint):
```
health = m × Q / (1.03 × (owed + one epoch of carry))     // flaggable at health ≤ 1
```
| Level | Rule (proposed) | UI |
|---|---|---|
| OK | runway > 30 days | none |
| Watch | runway ≤ 30 days | amber badge, "Pay carry" prompt |
| Warning | runway ≤ 7 days, or health ≤ 1.5 | red banner on market + Portfolio |
| Critical | runway ≤ 2 days, or health ≤ 1.15 | modal on connect |

Here runway means Epochs To Expire. During an open motion every Upbet holder with debt sees
a banner: *"A DC question is open on this market. Keep your carry paid: liquidations
continue until the ruling."*

Delivery: on-site only (owner decision, Q3). Alerts reach only holders who visit, which the
user docs must say plainly.

## 5. Motion = EDD marker + carry escrow

### 5.1 State

- A motion has an id `k`, an open time, and an index snapshot `I_k`
  (`cumulativeFundingPerYES` after `_accrueFunding()` at open). Only one motion can be open
  at a time.
- Per address, for the latest motion it touched (`motionOf[u]`):
  - `E[u]`: escrowed post-EDD Downbet credit (rounded down);
  - `D[u]`: unpaid post-EDD Upbet debt (rounded up);
  - `R[u]`: post-EDD carry this address paid in cash, refundable on a "Yes". It can be any
    payer: a holder curing or selling, a liquidator through P, or the InsuranceFund in the
    tail case.
- The resolution of each motion: `Open`, `No`, or `Yes`.

### 5.2 Accrual split

For an address with snapshot `s` and current index `I` while motion `k` is open, its
accrual since the snapshot splits at `I_k`:
```
pre  = bal × (min(I, I_k) − s)⁺        // ordinary carry, handled exactly as today
post = bal × (I − max(s, I_k))         // escrowed
```
This applies to both sides (Upbet debit and Downbet credit). The pre-EDD part goes through
today's `settleFunding` path unchanged: credit paid in cash, debit into `fundingDebt`. The
post-EDD parts are netted within the address (the owner's own Downbet credit against their
own Upbet debit), and the result lands in `E[u]` or `D[u]`. Netting within one address is
always neutral, because both sides resolve the same way.

### 5.3 Collection while a motion is open

Every place that collects Upbet debt (cure, the YES-sale `collectDebt` share, the redeem
payout deduction, the liquidation price P) takes pre-EDD `fundingDebt` first, then `D`.
The post-EDD part collected adds to `R[payer]`.

- `owed(u)` includes `D[u]`, so the trigger and the claim price count post-EDD carry.
  That's the owner's rule: liquidations stay fully live.
- Liquidation: P covers pre-EDD debt first, then post-EDD debt. `R[liquidator]` += the
  post-EDD part of P. In the tail case `R[InsuranceFund]` += the InsuranceFund's top-up.
  The holder's `E` (Downbet side) is untouched, consistent with "a claim touches only the
  Upbet side".

### 5.4 Resolution

**DC "No" (close motion):** motion `k` is marked `No`. Each address is folded the next
time it's touched (lazily, by any `settleFunding(u)`, which is already public):
- `E[u]` is paid out in cash;
- `D[u]` moves into `fundingDebt[u]`;
- `R[u]` is zeroed (the payment was for carry that turned out to be owed).

**DC "Yes" (confirm):** motion `k` is marked `Yes` and the market ends. On the next touch:
- `E[u]` is cancelled;
- `D[u]` is cancelled (forgiven);
- `R[u]` is refunded in cash (pull: the payer calls a function, or it is folded into
  settleYES or settleFunding). The InsuranceFund's `R` is claimable by the fund.
- Carry accrued after confirmation is post-EDD by definition, so it is cancelled
  automatically.

### 5.5 Why it balances

Both indexes are equal, so the total post-EDD Downbet credit accrued equals the total
post-EDD Upbet debit accrued (up to rounding, which favours collateral). The Upbet side of
that total is either still owed (`D` or not yet settled) or already paid (`R`, held in
collateral). The Downbet side is either escrowed (`E`) or not yet settled.

- **"No":** Downbet holders are paid out of `R` cash plus `D` as it is collected, exactly
  like today's model, where credit is paid ahead of debt collection and debt is a recorded
  claim on the Upbet's $1.
- **"Yes":** `E` and `D` cancel each other out, and the `R` cash goes back to whoever
  paid it. The collateral then backs every Upbet at $1.

New invariant tests must show that collateral always covers: pairs at $1, plus pre-EDD
credit owed, plus `ΣE`, plus `ΣR`, minus collectable `ΣD`. They must also show this holds
through random sequences of motion open, close and confirm.

### 5.6 Worked example: a Downbet seller during a motion

Day 0 the DC question appears and the motion opens. Day 15 Alice sells her Downbets.
- She receives her pre-EDD carry in cash as today.
- Her 15 days of post-EDD carry go to `E[Alice]`. The cash stays in collateral, and the
  buyer gets none of it. The buyer's price doesn't depend on Alice's history.
- DC "No" on day 30: Alice's `E` is paid to her on her next touch (or she calls
  `settleFunding(Alice)`), out of collateral backed by Upbet holders' post-EDD payments
  and debt.
- DC "Yes": Alice's `E` is cancelled. That cash refunds the Upbet side's post-EDD
  payments.

The Downbet price during a motion should therefore reflect that carry earned after the EDD
depends on the ruling. The UI shows it as "Pending carry: $X, paid if the DC rules No".

### 5.7 EDD timing

The motion uses the on-chain time it was opened, not a backdated DC request time.
Backdating can't work: Downbet carry paid in cash between the DC request and the motion has
already left collateral, so a backdated rebate would be underfunded. The gap is closed
operationally (§7) and disclosed in user copy.

### 5.8 Gap between a DC "Yes" and confirmation

Liquidations run until the confirm transaction lands.
- The team's keeper stops flagging the moment the DC announces "Yes" (an off-chain switch
  in funding-keeper, set by the runbook).
- Claims on already-flagged positions stay permissionless, so confirm within minutes.
- User copy warns Upbet holders about this window and points them to "Pay carry".

## 6. Contract changes (batch 4)

| Contract | Change |
|---|---|
| CreditMarket | Keep the PR #22 post-confirmation guards and `MotionPendingSet`. Remove the `motionPending` check from `flagClaimable`. `setMotionPending(true)` opens motion `k` with snapshot `I_k`; `false` resolves it `No`. `confirmCreditEvent` requires an open motion and resolves it `Yes`. `settleFunding` gains the pre/post split, `E/D/R` and lazy folding. `owed()` includes `D`. `collectDebt` and the redeem, cure and settleYES deductions take pre-EDD debt first. New refund pull for `R`. `cure()` opened to all (§4). |
| LiquidationEngine | Remove the `motionPending` revert in `claim`. Report P's pre/post split to CreditMarket so `R[liquidator]` and `R[InsuranceFund]` are recorded. |
| CLOBSettlement | `collectDebt` call unchanged; the split happens inside CreditMarket. |
| OracleRouter | Keep the PR #22 forwarder. New narrow `MOTION_ROLE` that can open a motion only, for the on-call rota now and a monitor later (§7, Q5). |
| MarketRegistry | Unchanged. |

New per-market config: none required beyond the mark bounds. Bytecode size needs checking:
CreditMarket grows.

**Invariant 5 (proposed rewrite):** *A credit-event motion never blocks trading, flagging,
claims or cure. Carry accrued after the motion opened is escrowed per address and resolves
with the motion: released on a "No", cancelled and refunded to its payers on a "Yes". Once
a credit event is confirmed, flagging and claims revert forever (`CreditEventAlreadyConfirmed`).*

**New invariant 11:** escrow conservation (§5.5).

## 7. Operations

- **Event framing.** Before listing a market, the team frames its covered credit events to
  match the industry-standard terms for that kind of entity, decided privately. Public
  copy lists only the events the market covers.
- **DC monitoring.** The All DC Requests page loads its table by script, the site's RSS
  feed is stale, there is no public API, and `robots.txt` disallows all automated access.
  So an automated poller should not run without written permission from the site
  operator. Plan:
  1. Ask the DC administrator (site contact page) for permission to poll, or for a
     notification feed.
  2. Meanwhile: a human rota checks the page in a browser, plus news alerts on each listed
     entity and on "Determinations Committee".
  3. If permission is granted: a monitor service with a narrow motion-opener key. A false
     motion only delays Downbet carry until it's closed. Confirmation stays with the
     multisig.
- **Runbook.**
  - Motion opened: announce, and the market banner goes live.
  - DC "Yes" announced: switch keeper flagging off, confirm.
  - DC "No": close the motion.
  - Remove the "liquidations frozen" comms.

## 8. Off-chain and UI changes

- **funding-keeper:** flags during motions; stops flagging on confirmation and on the
  runbook's "DC Yes" switch. Mark updater loop (§3).
- **liquidator-bot:** claims during motions; never after confirmation (PR #22).
- **order-book-server:** the `FundingShortfall` pre-filter must use the new debt split
  (`previewFunding` + `fundingDebt` + `D`).
- **Frontend:**
  - "Pay carry" on every Upbet position;
  - health badge and alerts;
  - motion banner;
  - "Pending carry" for Downbets;
  - `/admin` open/close/confirm (confirm requires an open motion);
  - docs pages (credit-events, risks, faq, glossary) rewritten to this model.
- **Spec:** root `CLAUDE.md` (invariant 5, new invariant 11, cure, mark updater, roadmap
  `prepayFunding` removed), `contracts/CLAUDE.md`, the credit-event runbook, and the
  batch-4 runbook.

## 8a. User note: closing a position

Netting happens only within one market and one address. Tell users to close a position by
**selling what they hold**. Buying the other side doesn't close it: until the pair is
redeemed, the Upbet side still accrues carry against `owed()` (which excludes Downbet
credit) and can be flagged. If they do buy the other side, they should redeem the pair
right away. This goes in the trading docs and the FAQ.

## 8b. Implementation notes (batch-4 contracts)

- `fundingDebt(user)` became a view (ordinary debt + live post-EDD debt); storage is
  `_debt`. CLOBSettlement and the off-chain readers need no change.
- `previewFunding` returns `cashOut − debtAfter + fundingDebt`, so the off-chain formulas
  (`max(0, fundingDebt − preview)` and `preview − fundingDebt`) stay exact during a motion.
- `confirmCreditEvent` without an open motion opens and resolves one in the same call
  (EDD = now, nothing voided). The runbook still always opens a motion first.
- `setMotionPending` reverts `MotionStateUnchanged` on a no-op and
  `CreditEventAlreadyConfirmed` after confirmation.
- Ordinary credit paying post-EDD debt (refundable) is in the code for completeness. With
  balances unchanged since the last settlement, both buckets have the same sign, so in
  practice it only triggers on rounding.
- Closing a motion can lower `owed()` by at most 1 wei: the two rounded-up buckets merge.

## 9. Owner decisions (2026-11-18)

- **Q1 — decided:** on a "Yes", `R` is refunded to whoever paid the post-EDD carry,
  including a liquidator through P (and the InsuranceFund for its top-up).
- **Q2 — decided:** keep a wide on-chain bound as a circuit breaker against a bad or
  stolen updater key: 50 points per update, at least 10 minutes apart (deploy defaults).
- **Q3 — decided:** health alerts are on-site only for batch 4.
- **Q4 — decided:** separate `MARK_ROLE` for the mark updater, distinct from the flagging
  `KEEPER_ROLE` (subject to the CreditMarket size limit).
- **Q5 — decided:** add the narrow motion-opener role on OracleRouter now. The on-call
  person can open a motion within minutes without a multisig quorum; a monitor service can
  use it later if the DC site operator permits polling.

## 10. Build order

1. Owner signs off on this note — done 2026-11-18 (Q1–Q5 decided).
2. Contracts + unit tests + invariant 11 + the rewritten invariant 5 suite, on a branch
   based on PR #22.
3. Keepers (mark updater, flagging rules), order-book-server pre-filter.
4. Frontend + docs pages.
5. Spec + runbooks.
6. Batch-4 deploy (owner-run), `docs/redeploy-batch4-runbook.md` updated.
