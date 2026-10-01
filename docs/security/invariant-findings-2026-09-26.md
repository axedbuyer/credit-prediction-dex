# Invariant suite + findings (2026-09-26)

Second Phase 3 security-gate artifact (`docs/production-plan.md`), after
`docs/security/slither-2026-09-26.md`.

**Status (2026-09-28): F1, F2, F4 fixed in source** on branch `fix/unified-owed` (the
recommended unified `owed()` fix, approved by the owner) — **not yet redeployed**; Base
Sepolia still runs the vulnerable contracts. The invariant suite was rewritten for the
fix: no compensation terms, the trigger check re-derived from the spec, a new
`invariant_NoMissedSeizureFlags`, the repros flipped to `test_Regression_*`; 7/7 planted
bugs caught at the default profile, including reverting the F4 and F2 fixes.

## The suite

`contracts/test/invariant/Handler.sol` drives the real deployed system (all seven
contracts, MockUSDC) with 5 funded actors and bounded actions: mint, redeem, settleYES,
EIP-712-signed CLOB trades (YES/NO, fee on/off), small and large time warps + accrual,
setMark, a boundary-seeking action that parks a position right at the seizure trigger,
flag, cure, liquidation claim (incl. the InsuranceFund tail case), credit-event
confirmation, motion pending, and InsuranceFund top-ups. Every action is try/catch-wrapped
and tallied (`callSummary()`); "must never succeed" properties are ghost counters.

`contracts/test/invariant/CreditMarketInvariant.t.sol` — 12 `invariant_*` functions:

| Invariant | CLAUDE.md |
|---|---|
| YES/NO supply reconcile exactly with ghost mint/burn ledgers | 3 |
| YES.totalSupply == NO.totalSupply before a credit event | complete-set |
| **Collateral solvency (exact, derived):** USDC(market) == YES supply − Σ fundingDebt − Σ unsynced YES debit (freeze-aware) + Σ unsynced NO credit, ± 2 wei/actor rounding, with explicit ghost terms for findings F1/F2 below | 4, 7, 9 |
| redeem/settleYES pay out exactly `amount ± projected funding delta` (per action) | 7, 9 |
| cumFundingPerYES == cumFundingPerNO, both monotonic | funding |
| flagged positions can't mint/redeem/trade; frozenFunding immutable while flagged | 10 |
| no flag or claim succeeds while a motion is pending | 5 |
| a claim leaves the original holder's fundingDebt/frozenFunding at 0 | liquidation |
| isSeizable == independent cost-basis-free `m ≤ 1.03 × f_next` | 1, 2 |
| CLOBSettlement never holds USDC/YES/NO | fees |

Default profile (CI): runs 64 × depth 64 — the whole `forge test` (112 tests) takes ~5s.
Deep: `FOUNDRY_PROFILE=deep forge test --match-path "test/invariant/*"` (512 × 256, ~45s).

**Mutation-tested:** five bugs were planted in `CreditMarket.sol` one at a time (restored
after each). All five are caught at the default profile, repeatedly:

| Planted bug | Caught by |
|---|---|
| redeem forgives funding debt | CollateralSolvency, RedeemAndSettleYESPayoutMatchesLedger |
| redeem burns half the NO | CollateralSolvency, CompleteSet, NoSupplyReconciliation |
| mint ignores the freeze | CollateralSolvency, FlaggedPositionsLocked, FrozenFundingImmutable |
| seizure buffer 3% → 4% | SeizureTriggerConsistency |
| flag ignores a pending motion | NoActionDuringMotionPending |

(The first version of the suite caught only 2 of 5 — a campaign-wide skip made the
solvency invariant vacuous and flag/boundary states were too rare — hence the
boundary-seeking action and the precise compensation terms.)

## F1 — Frozen YES funding vs live NO credit: permanent collateral leak (MEDIUM)

**Mechanism.** When a YES holder is flagged, `settleFunding` charges their YES side only
`frozenFunding` (the flag-time value) and `cure()`/claims restart accrual from "now". But
funding is a zero-sum transfer between the two legs of each complete set: the NO tokens
paired with that YES (held by anyone) keep accruing credit off the live
`cumFundingPerNO`, and that credit is paid out of collateral when those holders settle.
The funding for the flagged window is never charged to anyone.

**Impact.** Collateral ends up short of full backing by ≈ Δ(funding index during the
flagged window) × position size — permanently; InsuranceFund doesn't cover it (it only
tops up `LiquidationEngine.claim`'s own formula). It also gives a flagged holder a free
option: if nobody claims (thin liquidator market, or a pending motion freezing claims),
they pay no carry for the whole window and can later `cure()` for the flag-time amount.
Breaks invariant 4 (NO is made whole only by drawing down everyone else's backing) and
the spirit of 9.

**Repro:** `test_Repro_FrozenYesLiveNoCreditLeak` — Alice mints $1000 and sells the NO to
Bob, 354 days pass, Alice is flagged, 30 more days pass, Bob settles (live NO credit),
Alice cures paying her full frozen bill → the market holds less USDC than the YES supply
by exactly the 30-day window's NO credit.

**Severity in practice.** A flagged position is worth claiming immediately (the claimer
pays ≈97% of `m` for YES worth `m`), so in a healthy market the window is minutes to
hours and the leak is tiny (a 1-hour window at a 23% mark ≈ 0.0026% of notional). It is
unbounded when claims stall: no active liquidator (the MVP's liquidation-keeper only
lists positions; nobody claims), a pending credit-event motion (claims blocked), or the
mark falling after the flag (claim profit `m − min(f_frozen, m)` shrinks to zero).

**Testnet exposure:** none today (the only YES holder is the deployer; nothing has been
flagged).

**Fix options** — re-evaluated after F4 below; see "Recommended fix" at the end.

## F2 — Liquidator's own NO credit is forfeited on claim (LOW)

`clearLiquidatedPosition` calls `_syncUserFunding(liquidator)`, which folds the
liquidator's YES debit into `fundingDebt` but resets `snapNO[liquidator]` **without
paying the NO credit they had accrued**. Only matters if the liquidator already holds NO;
the protocol keeps the money (no solvency risk) at the liquidator's expense. Fix: call
`settleFunding(liquidator)` there instead. (`_syncUserFunding`'s only other caller is the
external `syncUserFunding`, CLOB_ROLE-gated and unused by CLOBSettlement — could be
removed.) The suite tracks the forfeited amount in `ghost_forfeitedNoCredit`.

## F3 — A flagged liquidator skips the fresh-start reset (INFORMATIONAL)

`_syncUserFunding` returns early for a flagged user, so if the liquidator is itself a
flagged YES holder, `clearLiquidatedPosition` doesn't reset its snapshot. Requires two
simultaneously-flagged positions where one claims the other; the handler skips that combo.
Moot if F2's fix routes the liquidator through `settleFunding`, whose flagged branch is
explicit — re-check when fixing F2.

## F4 — Any trade resets the seizure clock while debt grows unseen (HIGH)

**Mechanism.** `isSeizable` measures `f_now = cumulativeFundingPerYES −
fundingSnapshot[user]` and never reads `fundingDebt`. Every CLOB trade runs
`settleFunding` on BOTH parties (`CLOBSettlement.sol:250-251`); for a buyer that moves the
accrued YES debit into `fundingDebt` and resets the snapshot. So a YES holder resets their
liquidation clock with any purchase (of either token, any size) every < ~353 days — the
trigger time is ≈ 365/1.03 days at any constant mark — while the real debt grows in a
ledger the trigger ignores.

**Impact.** The position ends up owing more than it is worth, yet can never be flagged or
claimed. The debt is uncollectable outside a credit event: a YES sale must clear ≥ the
debit (worth less than the debt), and redeem underflows. Meanwhile the paired NO keeps
being paid its credit out of collateral. Net effect: carry-free protection — the holder
pays carry only if a credit event happens (deducted from the $1 payout); otherwise they
walk away and other holders' collateral has funded the NO side. Reachable by any YES
holder, no stall needed, unbounded. The invariant suite missed it because its
trigger-consistency check mirrors the contract's formula and the solvency check treats
ledger debt as collectable — both should be re-derived from the spec when fixing.

**Repro:** `test_Repro_F4_TradeResetsSeizureClockWhileDebtGrows` — Alice holds 1000 YES
at a 5% mark ($50 of value) and buys 1 NO from Bob before each of three 300-day
stretches. After 900 days: `fundingDebt(alice)` = **$123.16** (≈2.5× her position),
`isSeizable` = false, `flagClaimable` reverts, and the market has paid Bob **$123.16** of
NO credit backed only by that IOU.

## Recommended fix (F1 + F4 together)

Both are the same root problem: the protocol has more than one notion of "funding owed",
and the trigger/claim/cure paths each use a partial or stale one. Define ONE:

```
owed(user) = fundingDebt[user] + yesBal × (cumulativeFundingPerYES − fundingSnapshot[user]) / 1e18
```

and use it everywhere:
- **Trigger (F4):** seize when `m × yesBal ≤ 1.03 × (owed(user) + yesBal × Δf_epoch)` —
  the spec's `m ≤ 1.03 × f_next` with f = total owed per unit, now including the ledger.
- **While flagged (F1, option A):** no accounting freeze — `frozenFunding` goes away; the
  flag only LOCKS the position (no mint/redeem/trade), as invariant 10 requires.
- **Claim price:** `P = min(owed(user), m × Q)`, evaluated at claim time (deterministic
  from on-chain state in that block); InsuranceFund tops up `owed − m×Q` exactly as in
  today's tail case, so NO is made whole AND collateral stays solvent.
- **Cure:** pays the live `owed(user)` — the free option disappears.

Why A over B now: F4's fix already requires the trigger to read the full live `owed`;
using the same number for claim and cure removes `frozenFunding` and the F1/F3 special
cases instead of adding an InsuranceFund transfer on top of them (B). Honest caveat: no
scheme makes a *stalled* claim free — under A the cost of a long stall lands on the
InsuranceFund at claim time (bounded by the fund) instead of silently on collateral; the
real mitigation for stalls is operational: **run a claiming liquidator bot** (today none
exists). Spec changes needed in root CLAUDE.md: Funding Model → freeze semantics,
liquidation math (`P = min(owed, m)` at claim time), invariant 10 wording, plus the
trigger definition of `f_now`.

## Next

Decide on the recommended fix, then fold F1 + F4 + F2 into the planned CreditMarket-family redeploy
(with `depositCap`, the `setMark` bound, and the Slither follow-ups). When fixed: delete
the F1/F2 compensation terms in the handler — the solvency invariant must then pass
with them at zero — and keep the repro tests as regression tests (flipped to assert
full backing).
