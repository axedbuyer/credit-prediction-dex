// One-time Redis key migration for multi-market (single-market → per-slug keys).
//
//   orderbook:bids / orderbook:asks  →  orderbook:mstr:bids / orderbook:mstr:asks
//   orders:<id> JSON                 →  gains `market: 'mstr'`
//   nonces:<maker>                   →  nonces:mstr:<maker>
//
// Idempotent and crash-safe: each step is individually re-runnable, and the
// completion flag is written LAST. Safe against a concurrently-running
// matching-engine: per order we (1) rewrite the JSON with `market` FIRST,
// (2) ZADD into the new book, (3) only then ZREM from the legacy book — so the
// engine (which also treats a missing `market` as 'mstr') can briefly see an
// empty book but never an order without `market` in a namespaced book.
// Safe against several order-book-server replicas starting at once: a short
// SET NX lock makes the others skip (the flag makes later boots no-ops).

export const MIGRATION_FLAG = 'migrations:multimarket-v1'
const LOCK_KEY = `${MIGRATION_FLAG}:lock`
const LEGACY_MARKET = 'mstr'

/** The subset of ioredis the migration uses (also implemented by the test fake). */
export interface MigrationRedis {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>
  del(...keys: string[]): Promise<unknown>
  zrange(key: string, start: number, stop: number, withScores: 'WITHSCORES'): Promise<string[]>
  zadd(key: string, score: number, member: string): Promise<unknown>
  zrem(key: string, ...members: string[]): Promise<unknown>
  smembers(key: string): Promise<string[]>
  sadd(key: string, ...members: string[]): Promise<unknown>
  scan(cursor: string, ...args: Array<string | number>): Promise<[string, string[]]>
}

export interface MigrationResult {
  status: 'migrated' | 'already-done' | 'locked'
  orders: number
  nonceSets: number
}

const LEGACY_NONCE_KEY = /^nonces:0x[0-9a-fA-F]{40}$/

export async function migrateLegacyKeys(
  redis: MigrationRedis,
  log: (msg: string) => void = (m) => console.log(`[migration] ${m}`),
): Promise<MigrationResult> {
  if ((await redis.get(MIGRATION_FLAG)) !== null) {
    return { status: 'already-done', orders: 0, nonceSets: 0 }
  }
  const got = await redis.set(LOCK_KEY, '1', 'EX', 120, 'NX')
  if (got === null) {
    log('another instance holds the migration lock — skipping')
    return { status: 'locked', orders: 0, nonceSets: 0 }
  }

  let orders = 0
  for (const side of ['bids', 'asks'] as const) {
    const legacyKey = `orderbook:${side}`
    const flat = await redis.zrange(legacyKey, 0, -1, 'WITHSCORES')
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const id = flat[i]
      const score = Number(flat[i + 1])
      const raw = await redis.get(`orders:${id}`)
      if (raw) {
        const order = JSON.parse(raw) as Record<string, unknown>
        if (!order.market) {
          order.market = LEGACY_MARKET
          await redis.set(`orders:${id}`, JSON.stringify(order))
        }
        await redis.zadd(`orderbook:${LEGACY_MARKET}:${side}`, score, id)
        orders++
      }
      // (stale id with no order JSON is simply dropped)
      await redis.zrem(legacyKey, id)
    }
    await redis.del(legacyKey)
  }

  let nonceSets = 0
  let cursor = '0'
  const legacyNonceKeys: string[] = []
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'nonces:*', 'COUNT', 500)
    cursor = next
    for (const k of keys) if (LEGACY_NONCE_KEY.test(k)) legacyNonceKeys.push(k)
  } while (cursor !== '0')
  for (const key of new Set(legacyNonceKeys)) {
    const maker = key.slice('nonces:'.length).toLowerCase()
    const members = await redis.smembers(key)
    if (members.length > 0) await redis.sadd(`nonces:${LEGACY_MARKET}:${maker}`, ...members)
    await redis.del(key)
    nonceSets++
  }

  await redis.set(MIGRATION_FLAG, new Date().toISOString())
  await redis.del(LOCK_KEY)
  log(`multimarket-v1 done: ${orders} order(s) moved into orderbook:${LEGACY_MARKET}:*, ${nonceSets} nonce set(s) renamed`)
  return { status: 'migrated', orders, nonceSets }
}
