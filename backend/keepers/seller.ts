// Contract between the liquidator bot (liquidator-bot.ts), which claims flagged
// positions, and the component that sells the claimed Upbet (YES) on the CLOB
// (clob-seller.ts). All amounts are raw 6-decimal token units; prices are
// 1e18-scaled USDC per YES (same scale as CreditMarket.currentMark).

export interface SellRequest {
  /** YES the bot currently wants on offer (its whole balance). */
  yesAmount: bigint
  /** CreditMarket.currentMark at the time of the request (1e18-scaled). */
  markWad: bigint
}

export type SellAction =
  | 'crossed'   // posted an ask at the best bid (≥ floor) — expected to fill now
  | 'rested'    // no bid ≥ floor: posted an ask at the mark and left it resting
  | 'unchanged' // an existing resting ask already covers yesAmount — nothing posted
  | 'skipped'   // nothing to sell, or selling disabled / not possible (see reason)

export interface SellResult {
  action: SellAction
  orderId?: string
  priceWad?: bigint
  amount?: bigint
  reason?: string
}

export interface IYesSeller {
  /** Idempotent: safe to call every cycle while the bot holds YES. Never throws. */
  sell(req: SellRequest): Promise<SellResult>
}
