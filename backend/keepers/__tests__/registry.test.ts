// CANONICAL SOURCE: backend/shared/registry.test.ts (copied by sync-registry.sh).
import { describe, expect, it, vi } from 'vitest'
import { MarketDirectory, legacyMarket, type Hex, type IRegistryClient } from '../registry'

const REG = '0x00000000000000000000000000000000000000aa' as Hex
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex

function raw(slug: string, base: number, entityType = 0, active = true) {
  return {
    slug, entityName: slug.toUpperCase(), entityType,
    creditMarket: addr(base + 1), yesToken: addr(base + 2), noToken: addr(base + 3),
    clobSettlement: addr(base + 4), oracleRouter: addr(base + 5), liquidationEngine: addr(base + 6),
    active, registeredAt: 10n, startBlock: 5n,
  }
}

function client(results: Array<unknown[] | Error>): IRegistryClient {
  const fn = vi.fn()
  for (const r of results) {
    if (r instanceof Error) fn.mockRejectedValueOnce(r)
    else fn.mockResolvedValueOnce(r)
  }
  return { readContract: fn }
}

describe('MarketDirectory', () => {
  it('registry mode: indexes markets by slug and all six addresses (case-insensitive)', async () => {
    const dir = new MarketDirectory({ client: client([[raw('mstr', 0x100), raw('try', 0x200, 1)]]), registryAddress: REG, log: () => {} })
    await dir.refresh()
    expect(dir.list().map((m) => m.slug)).toEqual(['mstr', 'try'])
    expect(dir.bySlug('try')?.entityType).toBe('sovereign')
    expect(dir.bySlug('try')?.id).toBe(1)
    expect(dir.byAddress(addr(0x203).toUpperCase().replace('0X', '0x'))?.slug).toBe('try')
    expect(dir.byAddress(addr(0x106))?.slug).toBe('mstr')
    expect(dir.byAddress(addr(0x999))).toBeUndefined()
    expect(dir.status()).toMatchObject({ mode: 'registry', marketCount: 2, lastError: null })
  })

  it('a failed refresh keeps the last good list and records lastError', async () => {
    const dir = new MarketDirectory({ client: client([[raw('mstr', 0x100)], new Error('rpc down')]), registryAddress: REG, log: () => {} })
    await dir.refresh()
    await dir.refresh()
    expect(dir.list()).toHaveLength(1)
    expect(dir.status().lastError).toBe('rpc down')
  })

  it('activeOnly filters inactive markets but they stay addressable', async () => {
    const dir = new MarketDirectory({ client: client([[raw('mstr', 0x100), raw('crwv', 0x300, 0, false)]]), registryAddress: REG, log: () => {} })
    await dir.refresh()
    expect(dir.list({ activeOnly: true }).map((m) => m.slug)).toEqual(['mstr'])
    expect(dir.byAddress(addr(0x302))?.slug).toBe('crwv')
  })

  it('legacy mode serves exactly one mstr market from env addresses', async () => {
    const legacy = legacyMarket({ creditMarket: addr(1), yesToken: addr(2), noToken: addr(3), clobSettlement: addr(4), startBlock: '43766743' })
    const dir = new MarketDirectory({ legacy, log: () => {} })
    await dir.start()
    expect(dir.mode).toBe('legacy')
    expect(dir.list()).toHaveLength(1)
    expect(dir.bySlug('mstr')?.startBlock).toBe(43766743n)
    expect(dir.byAddress(addr(4))?.slug).toBe('mstr')
    dir.stop()
  })

  it('legacyMarket returns null without a CreditMarket or YES token', () => {
    expect(legacyMarket({ yesToken: addr(2) })).toBeNull()
    expect(legacyMarket({ creditMarket: addr(1) })).toBeNull()
  })
})
