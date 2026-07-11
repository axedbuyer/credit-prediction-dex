// Client-side mirror of CLOBSettlement's trading-fee math (see contracts/src/
// CLOBSettlement.sol tradeFee and backend/order-book-server/src/fee.ts — keep
// all three in lockstep).
//
// fee = FEE_BPS × min(p, 1−p) × Q, computed as
//       FEE_BPS × min(tradePrice, amount − tradePrice) / 10_000
// where `amount` is tokens and `tradePrice` the buyer's gross USDC leg (both
// 6-decimal). Charged only on the carry-earning side: Upbet (YES) sells — out
// of the seller's proceeds — and Downbet (NO) buys — inside the buyer's signed
// amountIn. Upbet buys and Downbet sells carry no trade fee.

export const FEE_BPS = BigInt(process.env.NEXT_PUBLIC_FEE_BPS ?? '50')

const BPS = 10_000n

export function tradeFee(amount: bigint, tradePrice: bigint, feeBps: bigint = FEE_BPS): bigint {
  if (feeBps === 0n || tradePrice >= amount) return 0n
  const otherSide = amount - tradePrice
  const minSide = tradePrice < otherSide ? tradePrice : otherSide
  return (minSide * feeBps) / BPS
}

/**
 * Smallest gross USDC leg G with G − fee(G) ≥ required — exact piecewise
 * inversion of the fee formula (net is strictly increasing in G).
 * Used both to size a Downbet buy's signed amountIn so the seller nets the
 * intended position cost, and to price the "minimum sell price to cover
 * carry + fee" hint on Upbet sells.
 */
export function minGrossForNet(required: bigint, amount: bigint, feeBps: bigint = FEE_BPS): bigint {
  if (feeBps === 0n || required <= 0n) return required < 0n ? 0n : required
  // Low branch (G ≤ Q/2, fee = feeBps×G): G ≥ required / (1 − r)
  const lowG = ceilDiv(required * BPS, BPS - feeBps)
  if (lowG * 2n <= amount) return lowG
  // High branch (G > Q/2, fee = feeBps×(Q−G)): G ≥ (required + r×Q) / (1 + r)
  return ceilDiv(required * BPS + feeBps * amount, BPS + feeBps)
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b
}
