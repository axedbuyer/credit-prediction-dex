// Off-chain mirror of CLOBSettlement's trading-fee math.
//
// fee = feeBps × min(p, 1−p) × Q, computed as
//       feeBps × min(tradePrice, amount − tradePrice) / 10_000
// where `amount` is tokens (Q tokens carry Q USDC of notional — tokens mint
// 1:1 with USDC) and `tradePrice` is the buyer's gross USDC leg. Charged only
// on the carry-earning side: YES sells (out of seller proceeds) and NO buys
// (inside the buyer's signed amountIn). YES buys and NO sells are fee-free.

const BPS = 10_000n

export function tradeFee(amount: bigint, tradePrice: bigint, feeBps: bigint): bigint {
  if (feeBps === 0n || tradePrice >= amount) return 0n
  const otherSide = amount - tradePrice
  const minSide = tradePrice < otherSide ? tradePrice : otherSide
  return (minSide * feeBps) / BPS
}

/**
 * Net USDC a NO seller actually receives from a buyer's gross amountIn —
 * the price basis for sorting/crossing NO bids. (YES bids are fee-free and
 * keep their gross basis; on YES asks the fee is the seller's burden and
 * does not move the crossing price.)
 */
export function netNoBidProceeds(tokensOut: bigint, grossUsdcIn: bigint, feeBps: bigint): bigint {
  return grossUsdcIn - tradeFee(tokensOut, grossUsdcIn, feeBps)
}

/**
 * Smallest gross tradePrice G that still nets ≥ `required` after the fee:
 * G − fee(G) ≥ required, with fee(G) = feeBps × min(G, Q−G) / 10_000.
 * net(G) is strictly increasing, so the threshold is the exact piecewise
 * inversion (ceil-rounded so the returned G always satisfies the check).
 * Used for the FundingShortfall pre-filter's minSellProceeds hint.
 */
export function minGrossForNet(required: bigint, amount: bigint, feeBps: bigint): bigint {
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
