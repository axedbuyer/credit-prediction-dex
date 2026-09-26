# Invariant suite + findings (2026-09-26)

Second Phase 3 security-gate artifact (`docs/production-plan.md`), after
`docs/security/slither-2026-09-26.md`. Test-only work — **no contract changes were made**;
the findings below need a spec decision and a contract redeploy.

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

## F1 — Frozen YES funding vs live NO credit: permanent collateral leak (HIGH for mainnet)

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

**Testnet exposure:** none today (the only YES holder is the deployer; nothing has been
flagged).

**Fix options — a spec decision** (CLAUDE.md deliberately freezes f at flag time "so the
price formula stays deterministic"):

- **A. Freeze only the claim price, not the accounting (recommended).** `cure()` and the
  post-event `settleYES` auto-cure charge live accrual since the pre-flag snapshot (the
  snapshot is already left untouched while flagged). The liquidation claim price becomes
  `P = min(f_live, m)` instead of `min(f_frozen, m)`, with the InsuranceFund covering
  `f_live − m` exactly as in today's tail case. Keeps NO whole AND collateral solvent,
  removes the free option, and the liquidator's margin (`m − f_live`) shrinks while a
  position sits unclaimed — an incentive to claim fast. Cost: the claim price is no
  longer fixed at flag time (still fully deterministic from on-chain state at claim time;
  the `/claimable` feed would compute it live).
- **B. Keep the frozen price; InsuranceFund absorbs the window.** At cure/claim, the
  InsuranceFund pays `(cum_now − cum_at_flag) × Q` into collateral. Minimal spec change,
  but the fund pays for every flagged window, and the free option remains unless cure
  also charges live accrual.
- **C. Liquidator inherits the window** (snapshot set to flag time instead of now).
  Rejected: after a long window the claim becomes unprofitable and positions get stuck.

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

## Next

Pick an F1 option, then fold F1 + F2 into the planned CreditMarket-family redeploy
(with `depositCap`, the `setMark` bound, and the Slither follow-ups). When fixed: delete
the F1/F2 compensation terms in the handler — the solvency invariant must then pass
with them at zero — and keep the repro tests as regression tests (flipped to assert
full backing).
