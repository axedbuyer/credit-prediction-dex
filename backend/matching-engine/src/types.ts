import type { MarketDirectory } from './registry'

// Mirror of order-book-server's StoredOrder — kept in sync manually.
// bigint fields are stored as decimal strings (JSON-safe).
export interface StoredOrder {
  id: string
  // Market slug. Optional on the wire: pre-migration orders carry none and
  // belong to 'mstr' — always read it through orderMarketSlug().
  market?: string
  maker: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  minAmountOut: string
  expiry: string
  nonce: string
  signature: string
  side: 'bid' | 'ask'
  price: number     // USDC-per-token float, used for CLOB ordering
  timestamp: number // ms since epoch, used for time-priority tie-breaking
}

export const LEGACY_MARKET_SLUG = 'mstr'

export function orderMarketSlug(order: Pick<StoredOrder, 'market'>): string {
  return order.market || LEGACY_MARKET_SLUG
}

export interface OrderBook {
  bids: StoredOrder[]
  asks: StoredOrder[]
}

export interface MatchingEngineConfig {
  // Legacy single-market config (used as one market, `mstr`, when no directory is set).
  yesTokenAddress: string
  noTokenAddress: string
  usdcAddress: string
  pollIntervalMs?: number  // default 500
  // Multi-market: every ACTIVE market in the directory is matched, each book
  // independently. Absent => legacy single market from the fields above.
  directory?: MarketDirectory
}
