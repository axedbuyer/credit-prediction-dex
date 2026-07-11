import { describe, it, expect } from 'vitest'
import { tradeFee, netNoBidProceeds, minGrossForNet } from '../fee'

// Mirrors CLOBSettlement.tradeFee — keep the two in lockstep.
describe('tradeFee', () => {
  it('charges feeBps on the min side when p < 0.5', () => {
    // p = 0.05: min(50, 950) = 50 → 50 × 50 / 10_000 = 0.25 (in USDC units)
    expect(tradeFee(1_000_000_000n, 50_000_000n, 50n)).toBe(250_000n)
  })

  it('charges the same fee for the complementary trade (p > 0.5)', () => {
    // p = 0.95: min(950, 50) = 50 → identical to the p = 0.05 fee
    expect(tradeFee(1_000_000_000n, 950_000_000n, 50n)).toBe(250_000n)
  })

  it('is zero at feeBps = 0', () => {
    expect(tradeFee(1_000_000_000n, 50_000_000n, 0n)).toBe(0n)
  })

  it('clamps to zero when tradePrice ≥ amount (p ≥ $1)', () => {
    expect(tradeFee(1_000n, 1_000n, 50n)).toBe(0n)
    expect(tradeFee(1_000n, 2_000n, 50n)).toBe(0n)
  })
})

describe('netNoBidProceeds', () => {
  it('deducts the buyer-paid fee from the gross USDC leg', () => {
    expect(netNoBidProceeds(1_000_000_000n, 950_000_000n, 50n)).toBe(949_750_000n)
  })

  it('passes gross through at feeBps = 0', () => {
    expect(netNoBidProceeds(1_000_000_000n, 950_000_000n, 0n)).toBe(950_000_000n)
  })
})

describe('minGrossForNet', () => {
  const Q = 1_000_000_000n
  const FEE = 50n

  it('returns required unchanged at feeBps = 0', () => {
    expect(minGrossForNet(80n, Q, 0n)).toBe(80n)
  })

  it('low branch: G = ceil(required / (1 − r)) when G ≤ Q/2', () => {
    const g = minGrossForNet(30_000_000n, Q, FEE)
    expect(g).toBe(30_150_754n) // ceil(30M × 10000 / 9950)
    expect(g - tradeFee(Q, g, FEE)).toBeGreaterThanOrEqual(30_000_000n)
  })

  it('high branch: crosses Q/2 when required is large', () => {
    const required = 990_000_000n // > Q/2 after fee — forces the high branch
    const g = minGrossForNet(required, Q, FEE)
    expect(g * 2n > Q).toBe(true)
    expect(g - tradeFee(Q, g, FEE)).toBeGreaterThanOrEqual(required)
  })

  // Integer fee flooring means the hint can sit 1 unit above the true integer
  // minimum — assert it always SATISFIES the on-chain check (never undershoots)
  // and never overshoots by more than the low-branch fee slope + rounding.
  it('always satisfies net(G) ≥ D with bounded overshoot across a sweep', () => {
    for (const d of [1n, 7n, 499_999_999n, 500_000_000n, 500_000_001n, 900_000_000n]) {
      const g = minGrossForNet(d, Q, FEE)
      expect(g - tradeFee(Q, g, FEE)).toBeGreaterThanOrEqual(d)
      expect(g - d).toBeLessThanOrEqual((d * FEE) / (10_000n - FEE) + (Q * FEE) / 10_000n)
    }
  })
})
