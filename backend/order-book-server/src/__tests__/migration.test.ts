import { describe, it, expect, beforeEach } from 'vitest'
import { migrateLegacyKeys, MIGRATION_FLAG, type MigrationRedis } from '../migration'

// Minimal in-memory Redis implementing exactly the commands the migration uses.
class FakeRedis implements MigrationRedis {
  kv = new Map<string, string>()
  z = new Map<string, Map<string, number>>()
  sets = new Map<string, Set<string>>()
  /** optional hook run between commands, to simulate a concurrent engine */
  onCommand?: (cmd: string) => void

  private tick(c: string) { this.onCommand?.(c) }
  async get(k: string) { this.tick('get'); return this.kv.get(k) ?? null }
  async set(k: string, v: string, ...args: Array<string | number>) {
    this.tick('set')
    if (args.includes('NX') && this.kv.has(k)) return null
    this.kv.set(k, v)
    return 'OK'
  }
  async del(...keys: string[]) { for (const k of keys) { this.kv.delete(k); this.z.delete(k); this.sets.delete(k) } return keys.length }
  async zrange(k: string, _s: number, _e: number, _w: 'WITHSCORES') {
    this.tick('zrange')
    return [...(this.z.get(k) ?? new Map()).entries()].sort((a, b) => a[1] - b[1]).flatMap(([m, s]) => [m, String(s)])
  }
  async zadd(k: string, score: number, m: string) { this.tick('zadd'); if (!this.z.has(k)) this.z.set(k, new Map()); this.z.get(k)!.set(m, score) }
  async zrem(k: string, ...ms: string[]) { this.tick('zrem'); for (const m of ms) this.z.get(k)?.delete(m) }
  async smembers(k: string) { return [...(this.sets.get(k) ?? [])] }
  async sadd(k: string, ...ms: string[]) { if (!this.sets.has(k)) this.sets.set(k, new Set()); for (const m of ms) this.sets.get(k)!.add(m) }
  async scan(_c: string, ..._a: Array<string | number>): Promise<[string, string[]]> {
    return ['0', [...this.kv.keys(), ...this.z.keys(), ...this.sets.keys()].filter(k => k.startsWith('nonces:'))]
  }
}

const MAKER = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266'
const order = (id: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, maker: MAKER, side: 'bid', price: 0.2, timestamp: 1, ...extra })

describe('migrateLegacyKeys', () => {
  let r: FakeRedis
  beforeEach(() => {
    r = new FakeRedis()
    r.kv.set('orders:b1', order('b1'))
    r.kv.set('orders:a1', order('a1', { side: 'ask' }))
    r.z.set('orderbook:bids', new Map([['b1', 0.2], ['ghost', 0.1]]))   // ghost: no order JSON
    r.z.set('orderbook:asks', new Map([['a1', 0.25]]))
    r.sets.set(`nonces:${MAKER}`, new Set(['1', '2']))
  })

  it('moves books, stamps market, renames nonces, drops legacy keys, sets the flag', async () => {
    const res = await migrateLegacyKeys(r, () => {})
    expect(res).toEqual({ status: 'migrated', orders: 2, nonceSets: 1 })
    expect([...r.z.get('orderbook:mstr:bids')!.keys()]).toEqual(['b1'])
    expect([...r.z.get('orderbook:mstr:asks')!.keys()]).toEqual(['a1'])
    expect(r.z.get('orderbook:mstr:asks')!.get('a1')).toBe(0.25)
    expect(JSON.parse(r.kv.get('orders:b1')!).market).toBe('mstr')
    expect(JSON.parse(r.kv.get('orders:a1')!).market).toBe('mstr')
    expect(r.z.has('orderbook:bids')).toBe(false)
    expect(r.z.has('orderbook:asks')).toBe(false)
    expect([...r.sets.get(`nonces:mstr:${MAKER}`)!].sort()).toEqual(['1', '2'])
    expect(r.sets.has(`nonces:${MAKER}`)).toBe(false)
    expect(r.kv.has(MIGRATION_FLAG)).toBe(true)
  })

  it('is idempotent: a second run is a no-op and changes nothing', async () => {
    await migrateLegacyKeys(r, () => {})
    const snap = JSON.stringify([[...r.kv], [...r.z].map(([k, v]) => [k, [...v]]), [...r.sets].map(([k, v]) => [k, [...v]])])
    expect((await migrateLegacyKeys(r, () => {})).status).toBe('already-done')
    expect(JSON.stringify([[...r.kv], [...r.z].map(([k, v]) => [k, [...v]]), [...r.sets].map(([k, v]) => [k, [...v]])])).toBe(snap)
  })

  it('re-runs safely after a crash before the flag (no duplicates, nothing lost)', async () => {
    // Simulate a crash after b1 was already moved but before the flag/lock cleanup.
    r.z.set('orderbook:mstr:bids', new Map([['b1', 0.2]]))
    r.kv.set('orders:b1', order('b1', { market: 'mstr' }))
    const res = await migrateLegacyKeys(r, () => {})
    expect(res.status).toBe('migrated')
    expect([...r.z.get('orderbook:mstr:bids')!.keys()]).toEqual(['b1'])
    expect(JSON.parse(r.kv.get('orders:b1')!).market).toBe('mstr')
  })

  it('skips when another instance holds the lock', async () => {
    r.kv.set('migrations:multimarket-v1:lock', '1')
    expect((await migrateLegacyKeys(r, () => {})).status).toBe('locked')
    expect(r.z.has('orderbook:bids')).toBe(true)
  })

  it('never exposes an order without `market` in a namespaced book (concurrent engine)', async () => {
    const violations: string[] = []
    r.onCommand = () => {
      for (const side of ['bids', 'asks']) {
        for (const id of r.z.get(`orderbook:mstr:${side}`)?.keys() ?? []) {
          const raw = r.kv.get(`orders:${id}`)
          if (!raw || !JSON.parse(raw).market) violations.push(id)
        }
      }
    }
    await migrateLegacyKeys(r, () => {})
    expect(violations).toEqual([])
  })

  it('does not touch already-namespaced nonce keys', async () => {
    r.sets.set(`nonces:turkey:${MAKER}`, new Set(['9']))
    await migrateLegacyKeys(r, () => {})
    expect([...r.sets.get(`nonces:turkey:${MAKER}`)!]).toEqual(['9'])
  })
})
