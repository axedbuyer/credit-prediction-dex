import type { OrderBook } from './types'

export interface OrderBookClient {
  /** `market` = slug; omitted => the server's default (mstr). */
  fetchOrderBook(market?: string): Promise<OrderBook>
}

// Production client — calls the order-book-server HTTP API.
export class HttpOrderBookClient implements OrderBookClient {
  constructor(private readonly baseUrl: string) {}

  async fetchOrderBook(market?: string): Promise<OrderBook> {
    const qs = market ? `?market=${encodeURIComponent(market)}` : ''
    const res = await fetch(`${this.baseUrl}/orderbook${qs}`)
    if (!res.ok) throw new Error(`Order book fetch failed: ${res.status}`)
    return res.json() as Promise<OrderBook>
  }
}
