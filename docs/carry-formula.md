# Carry formula: price = 12-month default probability

Status: implemented in `CreditMarket.carryRateFor` (batch-2 contracts, 2026-10-15). Applies
to every market — all markets deploy the same `CreditMarket.sol`.

## The change

```
before:  carry = m                       (annual carry per YES = the price)
after:   carry = h × (1 − m),  h = −ln(1 − m)
               = −(1 − m) · ln(1 − m)
```

`m` is the YES price, which the product presents as the probability of a credit event in
the next 12 months. Accrual is `cumFundingPerYES += carry × Δt / 365 days`. Nothing else
changes: the token's value is still `m` (equity, the seizure trigger's left side, the claim
cap `m × Q`, cost basis), settlement and all 10 invariants are untouched.

## Why carry = m was wrong

Two separate gaps, compounding:

1. **The price isn't the hazard rate.** An Upbet holder pays carry at rate `c` but only
   stands to gain `1 − m` on a credit event — they already paid `m` for the token, which
   then jumps to $1. Break-even is `h × (1 − m) = c`. With `c = m` the implied hazard is
   `h = m / (1 − m)`, not `m`.
2. **A hazard rate isn't a 12-month probability.** The probability of default within 12
   months at constant hazard is `1 − e^(−h)`.

Together, at a 23% price the market was implying a 25.8% 12-month probability. (Earlier
docs said a linear mark *overstated* the probability by ≈ h²/2; that ignored gap 1 and had
the sign wrong.)

## Derivation

Decompose one Upbet at price `m`:

| | Holder's own cash | Unfunded CDS on (1 − m) | Total | Upbet |
|---|---|---|---|---|
| Credit event | m | +(1 − m) | $1.00 | redeems $1 ✓ |
| No event | m | 0 | m | sells for m ✓ |

The first `m` of the $1 payout is the holder's own money; the NO side (which posted exactly
`1 − m` and can lose at most `1 − m`) sells protection on `1 − m`. Fair spread on a
zero-recovery CDS is the hazard `h`, so fair carry is `h × (1 − m)`. Requiring the price to
be the 12-month probability, `m = 1 − e^(−h)`, gives `h = −ln(1 − m)` and the formula above.

### The "prepaid carry" view

One can read `m` as prepaid carry: with `c = m` a held Upbet's equity `m − c·t` hits zero at
exactly one year. That holds on the no-default path, but on a credit event `settleYES`
collects `owed()` from the $1 payout — the holder receives `1 − c·t`, not $1. The `m` is not
spent; it is token value that a credit event replaces with $1. So default still adds exactly
`1 − m`, and the break-even carry is `h × (1 − m)`.

### Expected P&L check

Buy at m = 23¢ (true 12-month probability 23%, constant hazard), hold to seizure, no buffer:

| Carry rule | Runway | E[default leg] | E[survival leg] | E[P&L] per $1 |
|---|---|---|---|---|
| c = m (old) | 1.00 y | +15.18¢ | −17.71¢ | **−2.53¢** |
| c = h | 0.88 y | +13.55¢ | −18.27¢ | **−4.73¢** |
| c = h(1 − m) (new) | 1.14 y | +17.06¢ | −17.06¢ | **0.00¢** |

With the 3% seizure buffer, the new rule shows −0.5¢: the liquidator's margin, paid only by
a holder who rides the position all the way to seizure. Because P&L drift is
`h(1 − m) − c` at every instant, the zero holds for any exit strategy, not just hold-to-seizure.

## Numbers

| Price (12-month chance) | Old carry | New carry | Runway to seizure (old → new) |
|---|---|---|---|
| 2% | 2.00% | 1.98% | 354 → 358 days |
| 5% | 5.00% | 4.87% | 354 → 363 days |
| 10% | 10.00% | 9.48% | 354 → 373 days |
| 23% | 23.00% | 20.13% | 354 → 404 days |
| 40% | 40.00% | 30.65% | 354 → 462 days |

Properties (all fuzz-tested in `test/CreditMarket.t.sol`):
- `m(1 − m) ≤ carry ≤ m` — never above the old rate.
- Non-decreasing up to its peak of `1/e ≈ 36.8%` at `m = 1 − 1/e ≈ 63.2%`; it falls above
  that (there is little left to protect). Keep listings well below 63%.
- `1 − exp(−carry / (1 − m)) == m` to 1e-9 relative — price is the 12-month probability.
- Small-price approximation: `carry ≈ m − m²/2`.

## Implementation

- `carryRateFor(m)` is `public pure`: `−(1 − m)·lnWad(1 − m)` via Solady
  `FixedPointMathLib.lnWad` (v0.1.26, `contracts/lib/solady`), clamped to `≤ m` against
  rounding; a 1-wei mark rounds to 0 carry.
- `currentCarryRate` is stored and recomputed only in the constructor and `_setMark` (after
  accruing at the old rate), so per-accrual gas is unchanged.
- Sites switched from `currentMark` to `currentCarryRate`: `_accrueFunding`,
  `_projectedCumYES`, `previewFunding`, the next-epoch term of `isSeizable`, and the step of
  `epochsToExpire`.

## Seeding a market from a TradFi CDS spread

The `(1 − R)` of the credit triangle belongs only here, when converting a quoted spread `s`
(built with recovery `R`, usually 40%, often 25% for EM sovereigns) into our zero-recovery
world:

```
m_seed = 1 − exp(−s / (1 − R))
```

The launch seeds (MSTR 23%, CRWV 10%, TRY 2%) are placeholders until ISDA marks are
available.

## Rejected alternative: forgive owed carry on default

Making `settleYES` pay the full $1 (forgiving `owed()`) would make `c = m` exactly right —
`(1 − m)(1 − e^(−h)) = e^(−h)·m` solves to `m = 1 − e^(−h)`. But NO-side credit is paid in
cash as it settles while YES-side carry can sit unpaid in `fundingDebt`; forgiving that debt
on default leaves collateral below $1 per YES, breaking invariants 4 and 9 unless the
InsuranceFund or a payout haircut fills the hole.

## What remains approximate (disclosed, not fixed)

- **Flat hazard.** A perpetual prices one number; "next 12 months" assumes the hazard term
  structure is flat.
- **Idle collateral.** The $1 behind each pair earns nothing; at ~4% rates both sides want
  that yield, so prices lean slightly off fair. Same as any USDC prediction market; fixing
  it needs yield-bearing collateral (v2).
