// Recurring, idempotent SWEEP of legacy (single-market) Redis keys into the
// `mstr` namespace. Run on boot AND on a timer (LEGACY_SWEEP_MS), because
// Railway overlaps old and new deployments: the OLD order-book-server keeps
// accepting POST /order into the legacy keys for a short while after the new
// instance starts, and those orders must not be stranded.
//
//   orderbook:bids / orderbook:asks  ->  orderbook:mstr:bids / orderbook:mstr:asks
//   orders:<id> JSON                 ->  gains `market: 'mstr'`
//   nonces:<maker>                   ->  UNION into nonces:mstr:<maker>, legacy key deleted
//
// Safe against a concurrently-running matching-engine: per order we (1) rewrite
// the JSON with `market` FIRST, (2) ZADD into the new book, (3) only then ZREM
// from the legacy book — so the engine (which also treats a missing `market`
// as 'mstr') never sees an unstamped order in a namespaced book.
// Safe against several replicas: a short SET NX EX lock makes the others skip.
// Crash-safe: every step is re-runnable; the lock expires on its own.
// Nonces are merged with SADD (union), never overwritten — the new instance may
// already have written nonces:mstr:<maker>.
// Cheap path when there is nothing to move: one EXISTS (no writes, no lock).

export const MIGRATION_FLAG = 'migrations:multimarket-v1'   // informational marker only
const LOCK_KEY = `${MIGRATION_FLAG}:lock`
const LEGACY_MARKET = 'mstr'

/** The subset of ioredis the sweep uses (also implemented by the test fake). */
export interface MigrationRedis {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>
  del(...keys: string[]): Promise<unknown>
  exists(...keys: string[]): Promise<number>
  zrange(key: string, start: number, stop: number, withScores: 'WITHSCORES'): Promise<string[]>
  zadd(key: string, score: number, member: string): Promise<unknown>
  zrem(key: string, ...members: string[]): Promise<unknown>
  smembers(key: string): Promise<string[]>
  sadd(key: string, ...members: string[]): Promise<unknown>
  srem(key: string, ...members: string[]): Promise<unknown>
  scan(cursor: string, ...args: Array<string | number>): Promise<[string, string[]]>
}

export interface MigrationResult {
  status: 'migrated' | 'noop' | 'locked'
  orders: number
  nonceSets: number
}

const LEGACY_NONCE_KEY = /^nonces:0x[0-9a-fA-F]{40}$/

async function findLegacyNonceKeys(redis: MigrationRedis): Promise<string[]> {
  const found = new Set<string>()
  let cursor = '0'
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', 'nonces:0x*', 'COUNT', 500)
    cursor = next
    for (const k of keys) if (LEGACY_NONCE_KEY.test(k)) found.add(k)
  } while (cursor !== '0')
  return [...found]
}

/**
 * One sweep. `scanNonces=false` skips the (more expensive) nonce SCAN — the
 * timer passes it on most ticks; boot always scans.
 */
export async function migrateLegacyKeys(
  redis: MigrationRedis,
  log: (msg: string) => void = (m) => console.log(`[migration] ${m}`),
  opts: { scanNonces?: boolean } = {},
): Promise<MigrationResult> {
  const scanNonces = opts.scanNonces ?? true

  // Read-only probe — no lock, no writes when there is nothing to move.
  const hasBooks = (await redis.exists('orderbook:bids', 'orderbook:asks')) > 0
  const nonceKeysProbe = scanNonces ? await findLegacyNonceKeys(redis) : []
  if (!hasBooks && nonceKeysProbe.length === 0) {
    return { status: 'noop', orders: 0, nonceSets: 0 }
  }

  const got = await redis.set(LOCK_KEY, '1', 'EX', 120, 'NX')
  if (got === null) {
    log('another instance holds the sweep lock — skipping')
    return { status: 'locked', orders: 0, nonceSets: 0 }
  }

  let orders = 0
  let nonceSets = 0
  try {
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
      // No unconditional DEL here: an old instance may ZADD between our ZRANGE
      // and now; the empty zset vanishes on its own and a late member is
      // picked up by the next sweep.
    }

    // Re-scan inside the lock (keys may have appeared since the probe).
    const nonceKeys = scanNonces ? await findLegacyNonceKeys(redis) : []
    for (const key of nonceKeys) {
      const maker = key.slice('nonces:'.length).toLowerCase()
      const members = await redis.smembers(key)
      if (members.length > 0) await redis.sadd(`nonces:${LEGACY_MARKET}:${maker}`, ...members)   // union
      // Members added by the old instance between SMEMBERS and DEL would be
      // lost; remove only what we copied.
      if (members.length > 0) await redis.srem(key, ...members)
      nonceSets++
    }

    if (orders > 0 || nonceSets > 0) {
      await redis.set(MIGRATION_FLAG, new Date().toISOString())
      log(`swept legacy keys: ${orders} order(s) -> orderbook:${LEGACY_MARKET}:*, ${nonceSets} nonce set(s) merged into nonces:${LEGACY_MARKET}:*`)
    }
  } finally {
    await redis.del(LOCK_KEY)
  }
  return { status: orders > 0 || nonceSets > 0 ? 'migrated' : 'noop', orders, nonceSets }
}
