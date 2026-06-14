import type { OrderBook } from './types'

export interface OrderBookClient {
  fetchOrderBook(): Promise<OrderBook>
}

// Production client — calls the order-book-server HTTP API.
export class HttpOrderBookClient implements OrderBookClient {
  constructor(private readonly baseUrl: string) {}

  async fetchOrderBook(): Promise<OrderBook> {
    const res = await fetch(`${this.baseUrl}/orderbook`)
    if (!res.ok) throw new Error(`Order book fetch failed: ${res.status}`)
    return res.json() as Promise<OrderBook>
  }
}
