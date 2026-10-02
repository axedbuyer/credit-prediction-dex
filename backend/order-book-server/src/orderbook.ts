import Redis from 'ioredis'
import type { StoredOrder } from './types'

// ─── Redis key layout ─────────────────────────────────────────────────────────
// Kept in lockstep with backend/matching-engine's RedisOrderRemover.
// `orders:<id>` stays global — the order JSON itself carries `market`.
// Nonces are per market: on-chain `usedNonces` lives on each CLOBSettlement.
export const bidsKey = (market: string) => `orderbook:${market}:bids`
export const asksKey = (market: string) => `orderbook:${market}:asks`
export const nonceKey = (market: string, maker: string) => `nonces:${market}:${maker.toLowerCase()}`

// ─── Interface ────────────────────────────────────────────────────────────────

export interface OrderStore {
  saveOrder(id: string, order: StoredOrder): Promise<void>
  getOrder(id: string): Promise<StoredOrder | null>
  deleteOrder(id: string): Promise<boolean>
  addBid(market: string, id: string, price: number): Promise<void>
  addAsk(market: string, id: string, price: number): Promise<void>
  removeBid(market: string, id: string): Promise<void>
  removeAsk(market: string, id: string): Promise<void>
  /** Returns order IDs sorted by price descending (highest bid first). */
  getBidIds(market: string): Promise<string[]>
  /** Returns order IDs sorted by price ascending (lowest ask first). */
  getAskIds(market: string): Promise<string[]>
  isNonceUsed(market: string, maker: string, nonce: string): Promise<boolean>
  markNonceUsed(market: string, maker: string, nonce: string): Promise<void>
  /** Cheap reachability check for GET /health. Must never throw — swallow errors and return false. */
  ping(): Promise<boolean>
}

// ─── Redis-backed implementation ──────────────────────────────────────────────

export class RedisOrderStore implements OrderStore {
  constructor(private readonly redis: Redis) {}

  async saveOrder(id: string, order: StoredOrder): Promise<void> {
    await this.redis.set(`orders:${id}`, JSON.stringify(order))
  }

  async getOrder(id: string): Promise<StoredOrder | null> {
    const raw = await this.redis.get(`orders:${id}`)
    if (!raw) return null
    const order = JSON.parse(raw) as StoredOrder
    // Pre-migration orders have no `market` — they all belong to mstr.
    if (!order.market) order.market = 'mstr'
    return order
  }

  async deleteOrder(id: string): Promise<boolean> {
    const deleted = await this.redis.del(`orders:${id}`)
    return deleted > 0
  }

  async addBid(market: string, id: string, price: number): Promise<void> {
    await this.redis.zadd(bidsKey(market), price, id)
  }

  async addAsk(market: string, id: string, price: number): Promise<void> {
    await this.redis.zadd(asksKey(market), price, id)
  }

  async removeBid(market: string, id: string): Promise<void> {
    await this.redis.zrem(bidsKey(market), id)
  }

  async removeAsk(market: string, id: string): Promise<void> {
    await this.redis.zrem(asksKey(market), id)
  }

  async getBidIds(market: string): Promise<string[]> {
    // ZREVRANGE returns members sorted by score descending
    return this.redis.zrevrange(bidsKey(market), 0, -1)
  }

  async getAskIds(market: string): Promise<string[]> {
    // ZRANGE returns members sorted by score ascending
    return this.redis.zrange(asksKey(market), 0, -1)
  }

  async isNonceUsed(market: string, maker: string, nonce: string): Promise<boolean> {
    const result = await this.redis.sismember(nonceKey(market, maker), nonce)
    return result === 1
  }

  async markNonceUsed(market: string, maker: string, nonce: string): Promise<void> {
    await this.redis.sadd(nonceKey(market, maker), nonce)
  }

  async ping(): Promise<boolean> {
    try {
      return (await this.redis.ping()) === 'PONG'
    } catch {
      return false
    }
  }
}

// ─── In-memory implementation (for tests) ────────────────────────────────────

export class MemoryOrderStore implements OrderStore {
  private orders = new Map<string, StoredOrder>()
  private bidPrices = new Map<string, Map<string, number>>()
  private askPrices = new Map<string, Map<string, number>>()
  private usedNonces = new Map<string, Set<string>>()

  private static book(m: Map<string, Map<string, number>>, market: string): Map<string, number> {
    let b = m.get(market)
    if (!b) { b = new Map(); m.set(market, b) }
    return b
  }

  async saveOrder(id: string, order: StoredOrder): Promise<void> {
    this.orders.set(id, order)
  }

  async getOrder(id: string): Promise<StoredOrder | null> {
    return this.orders.get(id) ?? null
  }

  async deleteOrder(id: string): Promise<boolean> {
    return this.orders.delete(id)
  }

  async addBid(market: string, id: string, price: number): Promise<void> {
    MemoryOrderStore.book(this.bidPrices, market).set(id, price)
  }

  async addAsk(market: string, id: string, price: number): Promise<void> {
    MemoryOrderStore.book(this.askPrices, market).set(id, price)
  }

  async removeBid(market: string, id: string): Promise<void> {
    MemoryOrderStore.book(this.bidPrices, market).delete(id)
  }

  async removeAsk(market: string, id: string): Promise<void> {
    MemoryOrderStore.book(this.askPrices, market).delete(id)
  }

  async getBidIds(market: string): Promise<string[]> {
    return [...MemoryOrderStore.book(this.bidPrices, market).entries()]
      .sort(([, a], [, b]) => b - a)
      .map(([id]) => id)
  }

  async getAskIds(market: string): Promise<string[]> {
    return [...MemoryOrderStore.book(this.askPrices, market).entries()]
      .sort(([, a], [, b]) => a - b)
      .map(([id]) => id)
  }

  async isNonceUsed(market: string, maker: string, nonce: string): Promise<boolean> {
    return this.usedNonces.get(nonceKey(market, maker))?.has(nonce) ?? false
  }

  async markNonceUsed(market: string, maker: string, nonce: string): Promise<void> {
    const key = nonceKey(market, maker)
    if (!this.usedNonces.has(key)) this.usedNonces.set(key, new Set())
    this.usedNonces.get(key)!.add(nonce)
  }

  async ping(): Promise<boolean> {
    return true   // no external dependency — always reachable
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createRedisClient(host = 'localhost', port = 6379): Redis {
  // REDIS_URL (redis://:password@host:port) takes precedence — managed Redis
  // (e.g. Railway) requires auth that bare host/port can't carry.
  const url = process.env.REDIS_URL
  if (url) return new Redis(url, { lazyConnect: true })
  return new Redis({ host, port, lazyConnect: true })
}
