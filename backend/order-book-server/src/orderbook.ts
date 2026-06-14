import Redis from 'ioredis'
import type { StoredOrder } from './types'

// ─── Interface ────────────────────────────────────────────────────────────────

export interface OrderStore {
  saveOrder(id: string, order: StoredOrder): Promise<void>
  getOrder(id: string): Promise<StoredOrder | null>
  deleteOrder(id: string): Promise<boolean>
  addBid(id: string, price: number): Promise<void>
  addAsk(id: string, price: number): Promise<void>
  removeBid(id: string): Promise<void>
  removeAsk(id: string): Promise<void>
  /** Returns order IDs sorted by price descending (highest bid first). */
  getBidIds(): Promise<string[]>
  /** Returns order IDs sorted by price ascending (lowest ask first). */
  getAskIds(): Promise<string[]>
  isNonceUsed(maker: string, nonce: string): Promise<boolean>
  markNonceUsed(maker: string, nonce: string): Promise<void>
}

// ─── Redis-backed implementation ──────────────────────────────────────────────

export class RedisOrderStore implements OrderStore {
  constructor(private readonly redis: Redis) {}

  async saveOrder(id: string, order: StoredOrder): Promise<void> {
    await this.redis.set(`orders:${id}`, JSON.stringify(order))
  }

  async getOrder(id: string): Promise<StoredOrder | null> {
    const raw = await this.redis.get(`orders:${id}`)
    return raw ? (JSON.parse(raw) as StoredOrder) : null
  }

  async deleteOrder(id: string): Promise<boolean> {
    const deleted = await this.redis.del(`orders:${id}`)
    return deleted > 0
  }

  async addBid(id: string, price: number): Promise<void> {
    await this.redis.zadd('orderbook:bids', price, id)
  }

  async addAsk(id: string, price: number): Promise<void> {
    await this.redis.zadd('orderbook:asks', price, id)
  }

  async removeBid(id: string): Promise<void> {
    await this.redis.zrem('orderbook:bids', id)
  }

  async removeAsk(id: string): Promise<void> {
    await this.redis.zrem('orderbook:asks', id)
  }

  async getBidIds(): Promise<string[]> {
    // ZREVRANGE returns members sorted by score descending
    return this.redis.zrevrange('orderbook:bids', 0, -1)
  }

  async getAskIds(): Promise<string[]> {
    // ZRANGE returns members sorted by score ascending
    return this.redis.zrange('orderbook:asks', 0, -1)
  }

  async isNonceUsed(maker: string, nonce: string): Promise<boolean> {
    const result = await this.redis.sismember(`nonces:${maker.toLowerCase()}`, nonce)
    return result === 1
  }

  async markNonceUsed(maker: string, nonce: string): Promise<void> {
    await this.redis.sadd(`nonces:${maker.toLowerCase()}`, nonce)
  }
}

// ─── In-memory implementation (for tests) ────────────────────────────────────

export class MemoryOrderStore implements OrderStore {
  private orders = new Map<string, StoredOrder>()
  private bidPrices = new Map<string, number>()
  private askPrices = new Map<string, number>()
  private usedNonces = new Map<string, Set<string>>()

  async saveOrder(id: string, order: StoredOrder): Promise<void> {
    this.orders.set(id, order)
  }

  async getOrder(id: string): Promise<StoredOrder | null> {
    return this.orders.get(id) ?? null
  }

  async deleteOrder(id: string): Promise<boolean> {
    return this.orders.delete(id)
  }

  async addBid(id: string, price: number): Promise<void> {
    this.bidPrices.set(id, price)
  }

  async addAsk(id: string, price: number): Promise<void> {
    this.askPrices.set(id, price)
  }

  async removeBid(id: string): Promise<void> {
    this.bidPrices.delete(id)
  }

  async removeAsk(id: string): Promise<void> {
    this.askPrices.delete(id)
  }

  async getBidIds(): Promise<string[]> {
    return [...this.bidPrices.entries()]
      .sort(([, a], [, b]) => b - a)
      .map(([id]) => id)
  }

  async getAskIds(): Promise<string[]> {
    return [...this.askPrices.entries()]
      .sort(([, a], [, b]) => a - b)
      .map(([id]) => id)
  }

  async isNonceUsed(maker: string, nonce: string): Promise<boolean> {
    return this.usedNonces.get(maker.toLowerCase())?.has(nonce) ?? false
  }

  async markNonceUsed(maker: string, nonce: string): Promise<void> {
    const key = maker.toLowerCase()
    if (!this.usedNonces.has(key)) this.usedNonces.set(key, new Set())
    this.usedNonces.get(key)!.add(nonce)
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createRedisClient(host = 'localhost', port = 6379): Redis {
  return new Redis({ host, port, lazyConnect: true })
}
