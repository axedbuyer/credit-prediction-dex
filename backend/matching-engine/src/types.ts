// Mirror of order-book-server's StoredOrder — kept in sync manually.
// bigint fields are stored as decimal strings (JSON-safe).
export interface StoredOrder {
  id: string
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

export interface OrderBook {
  bids: StoredOrder[]
  asks: StoredOrder[]
}

export interface MatchingEngineConfig {
  yesTokenAddress: string
  noTokenAddress: string
  usdcAddress: string
  pollIntervalMs?: number  // default 500
}
