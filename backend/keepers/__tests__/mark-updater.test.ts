import { describe, it, expect, vi } from 'vitest'
import type { Address, Hash } from 'viem'
import {
  WAD, fillYesPrice, fillTwap, yesImpliedBook, depthPrice, bookMid, chooseTarget, planUpdate,
  markConfigFromEnv, MarkUpdater, MarkUpdaterService,
} from '../mark-updater'
import type { Fill, BookOrder, IMarkPublicClient, IMarkWalletClient, IBookSource, MarkConfig, FilledLog } from '../mark-updater'
import type { MarketInfo } from '../registry'

const w = (x: number) => BigInt(Math.round(x * 1e9)) * 10n ** 9n
const T = (x: number) => BigInt(Math.round(x * 1e6))

const YES = '0x00000000000000000000000000000000000000a1' as Address
const NO  = '0x00000000000000000000000000000000000000a2' as Address
const CM  = '0x00000000000000000000000000000000000000c1' as Address
const CLOB = '0x00000000000000000000000000000000000000c2' as Address
const ME  = '0x00000000000000000000000000000000000000ee' as Address
const ROLE = ('0x' + '11'.repeat(32)) as `0x${string}`

const MARKET: MarketInfo = {
  id: 1, slug: 'crwv', entityName: 'CoreWeave', entityType: 'corporate',
  creditMarket: CM, yesToken: YES, noToken: NO, clobSettlement: CLOB,
  oracleRouter: '0x0000000000000000000000000000000000000001', liquidationEngine: '0x0000000000000000000000000000000000000002',
  active: true, registeredAt: 0n, startBlock: 0n,
} as MarketInfo

const fill = (timestamp: number, price: number, tokens = 10): Fill => ({ blockNumber: BigInt(timestamp), timestamp, yesPrice: w(price), tokens: T(tokens) })
const TW = { windowSec: 3600, minFills: 2, minFillTokens: T(1), minVolume: T(5) }

describe('fillYesPrice', () => {
  it('YES fill: gross price per token', () => {
    expect(fillYesPrice(true, T(10), T(2.3), 0n)).toBe(w(0.23))
  })
  it('NO fill: 1 − the NO seller\'s net per token', () => {
    // buyer paid 7.75 gross incl. 0.05 fee → net 7.70 for 10 Downbets → YES 23%
    expect(fillYesPrice(false, T(10), T(7.75), T(0.05))).toBe(w(0.23))
  })
  it('zero tokens is unpriceable', () => {
    expect(fillYesPrice(true, 0n, 1n, 0n)).toBeNull()
  })
})

describe('fillTwap', () => {
  it('holds each price until the next fill, the last until now', () => {
    // 20% for 600s, then 30% for 1800s → (0.2×600 + 0.3×1800)/2400 = 0.275
    const r = fillTwap([fill(1000, 0.2), fill(1600, 0.3)], 3400, TW)!
    expect(r.price).toBe(w(0.275))
    expect(r.fills).toBe(2)
  })
  it('same-second fills collapse to their VWAP', () => {
    const r = fillTwap([fill(1000, 0.2, 10), fill(1000, 0.4, 30), fill(1000, 0.1, 0.5)], 1000, { ...TW, minFills: 2 })!
    expect(r.price).toBe(w(0.35)) // 0.5-token fill is below minFillTokens and ignored
  })
  it('null when too few fills, too little volume, or fills outside the window', () => {
    expect(fillTwap([fill(1000, 0.2)], 1100, TW)).toBeNull()
    expect(fillTwap([fill(1000, 0.2, 2), fill(1100, 0.2, 2)], 1200, TW)).toBeNull()
    expect(fillTwap([fill(1000, 0.2), fill(1100, 0.2)], 1100 + 3600, TW)).toBeNull()
  })
})

const order = (o: Partial<BookOrder>): BookOrder => ({
  side: 'bid', tokenIn: '0xusdc', tokenOut: YES, amountIn: '0', minAmountOut: '0', expiry: '99999', price: 0.2, ...o,
})

describe('yesImpliedBook + depth mid', () => {
  const orders: BookOrder[] = [
    order({ side: 'bid', tokenOut: YES, minAmountOut: String(T(50)), price: 0.20 }),
    order({ side: 'bid', tokenOut: YES, minAmountOut: String(T(1)), price: 0.24 }),   // 1-token spoof bid
    order({ side: 'ask', tokenIn: YES, tokenOut: '0xusdc', amountIn: String(T(80)), price: 0.26 }),
    // NO bid at net 0.70 → YES ask at 0.30; NO ask at 0.81 → YES bid at 0.19
    order({ side: 'bid', tokenOut: NO, minAmountOut: String(T(100)), price: 0.70 }),
    order({ side: 'ask', tokenIn: NO, tokenOut: '0xusdc', amountIn: String(T(100)), price: 0.81 }),
    order({ side: 'ask', tokenIn: YES, tokenOut: '0xusdc', amountIn: String(T(500)), price: 0.27, expiry: '10' }), // expired
    order({ side: 'ask', tokenIn: YES, tokenOut: '0xusdc', amountIn: String(T(500)), price: 0.21, filled: String(T(500)) }), // filled
  ]
  const book = yesImpliedBook(orders, { yesToken: YES, noToken: NO }, 1000)

  it('mirrors NO orders, drops expired and fully filled ones, sorts best first', () => {
    expect(book.bids.map(l => l.price)).toEqual([w(0.24), w(0.20), w(0.19)])
    expect(book.asks.map(l => l.price)).toEqual([w(0.26), w(0.30)])
  })
  it('depth price ignores a thin top of book', () => {
    expect(depthPrice(book.bids, T(40))).toBe(w(0.20))
    expect(depthPrice(book.asks, T(100))).toBe(w(0.30))
    expect(depthPrice(book.asks, T(1000))).toBeNull()
  })
  it('mid needs both sides within the max spread', () => {
    expect(bookMid(book, T(40), w(0.10))).toEqual({ mid: w(0.23), bid: w(0.20), ask: w(0.26) })
    expect(bookMid(book, T(100), w(0.05))).toBeNull() // 0.19..0.30 too wide
    expect(bookMid(book, T(10_000), w(0.5))).toBeNull()
  })
})

describe('chooseTarget', () => {
  const B = { min: w(0.001), max: w(0.95) }
  it('prefers fills; clamps them into the depth band', () => {
    expect(chooseTarget({ price: w(0.25), fills: 3, volume: T(30) }, { mid: w(0.23), bid: w(0.2), ask: w(0.26) }, B))
      .toEqual({ target: w(0.25), source: 'fills', clampedToBook: false })
    expect(chooseTarget({ price: w(0.10), fills: 3, volume: T(30) }, { mid: w(0.23), bid: w(0.2), ask: w(0.26) }, B))
      .toEqual({ target: w(0.2), source: 'fills', clampedToBook: true })
  })
  it('falls back to the book mid; null with neither; clamps to bounds', () => {
    expect(chooseTarget(null, { mid: w(0.23), bid: w(0.2), ask: w(0.26) }, B)!.source).toBe('book')
    expect(chooseTarget(null, null, B)).toBeNull()
    expect(chooseTarget({ price: w(0.99), fills: 3, volume: T(30) }, null, B)!.target).toBe(w(0.95))
  })
})

describe('planUpdate', () => {
  const base = { current: w(0.23), lastUpdate: 0n, nowSec: 10_000n, maxStep: w(0.5), minInterval: 600n, deadband: w(0.0025) }
  it('jumps both ways within the step bound', () => {
    expect(planUpdate({ ...base, target: w(0.60) })).toEqual({ action: 'set', mark: w(0.60), stepped: false })
    expect(planUpdate({ ...base, target: w(0.05) })).toEqual({ action: 'set', mark: w(0.05), stepped: false })
  })
  it('steps by maxStep when the move is larger', () => {
    expect(planUpdate({ ...base, current: w(0.05), target: w(0.90) })).toEqual({ action: 'set', mark: w(0.55), stepped: true })
  })
  it('holds inside the deadband and before minMarkInterval', () => {
    expect(planUpdate({ ...base, target: w(0.231) })).toEqual({ action: 'hold', reason: 'deadband' })
    expect(planUpdate({ ...base, target: w(0.3), lastUpdate: 9_500n })).toEqual({ action: 'hold', reason: 'interval' })
  })
})

// ─── Worker against fake chain + book ─────────────────────────────────────────

interface Chain {
  mark: bigint
  lastMarkUpdate: bigint
  confirmed?: boolean
  hasRole?: boolean
  noMarkRole?: boolean // batch-3 contracts
  head: { number: bigint; timestamp: bigint }
  logs: FilledLog[]
  blockTs: Record<string, bigint>
}

function fakes(c: Chain) {
  const writes: Array<{ functionName: string; args?: readonly unknown[] }> = []
  const pub: IMarkPublicClient = {
    readContract: vi.fn(async ({ functionName }) => {
      switch (functionName) {
        case 'creditEventConfirmed': return c.confirmed ?? false
        case 'currentMark': return c.mark
        case 'lastMarkUpdate': return c.lastMarkUpdate
        case 'maxMarkStep': return w(0.5)
        case 'minMarkInterval': return 600n
        case 'MARK_ROLE': if (c.noMarkRole) throw new Error('execution reverted'); return ROLE
        case 'hasRole': return c.hasRole ?? true
        default: throw new Error(`unexpected read ${functionName}`)
      }
    }),
    estimateContractGas: vi.fn(async () => 50_000n),
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' as const })),
    getBlock: vi.fn(async (a?: { blockNumber?: bigint }) =>
      a?.blockNumber !== undefined ? { number: a.blockNumber, timestamp: c.blockTs[a.blockNumber.toString()] } : c.head),
    getLogs: vi.fn(async ({ fromBlock, toBlock }) => c.logs.filter(l => l.blockNumber! >= fromBlock && l.blockNumber! <= toBlock)),
  }
  const wallet: IMarkWalletClient = {
    account: { address: ME },
    writeContract: vi.fn(async (a) => { writes.push(a); c.mark = a.args![0] as bigint; return ('0x' + 'ab'.repeat(32)) as Hash }),
  }
  return { pub, wallet, writes }
}

const yesLog = (block: number, price: number, tokens = 10): FilledLog => ({
  blockNumber: BigInt(block), args: { token: YES, tokens: T(tokens), tradePrice: T(price * tokens), fee: 0n },
})

const CFG: MarkConfig = { ...markConfigFromEnv({}), twap: TW, bookMinDepth: T(40) }
const emptyBook: IBookSource = { fetch: async () => [] }

describe('MarkUpdater', () => {
  const chainWithFills = (): Chain => ({
    mark: w(0.10), lastMarkUpdate: 0n,
    head: { number: 1000n, timestamp: 20_000n },
    logs: [yesLog(900, 0.40), yesLog(950, 0.40)],
    blockTs: { '900': 19_800n, '950': 19_900n },
  })

  it('moves the mark to the fills TWAP (a jump up of 30 points in one update)', async () => {
    const c = chainWithFills()
    const { pub, wallet, writes } = fakes(c)
    const u = new MarkUpdater(pub, wallet, MARKET, emptyBook, CFG)
    await u.runOnce()
    expect(writes).toHaveLength(1)
    expect(writes[0].functionName).toBe('setMark')
    expect(writes[0].args![0]).toBe(w(0.40))
    expect(u.health().source).toBe('fills')
    expect(u.health().lastSetTx).toMatch(/^0xab/)
  })

  it('a downward jump is sent at once too', async () => {
    const c = chainWithFills()
    c.mark = w(0.60)
    const { pub, wallet, writes } = fakes(c)
    await new MarkUpdater(pub, wallet, MARKET, emptyBook, CFG).runOnce()
    expect(writes[0].args![0]).toBe(w(0.40))
  })

  it('dry run without MARK_ROLE (batch-3 contracts): computes, sends nothing', async () => {
    const c = { ...chainWithFills(), noMarkRole: true }
    const { pub, wallet, writes } = fakes(c)
    const u = new MarkUpdater(pub, wallet, MARKET, emptyBook, CFG)
    await u.runOnce()
    expect(writes).toHaveLength(0)
    expect(u.health().writable).toBe(false)
    expect(u.health().lastPlan).toMatch(/dry run/)
  })

  it('dry run when the wallet lacks MARK_ROLE, and with MARK_DRY_RUN', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const a = fakes({ ...chainWithFills(), hasRole: false })
    await new MarkUpdater(a.pub, a.wallet, MARKET, emptyBook, CFG).runOnce()
    expect(a.writes).toHaveLength(0)
    const b = fakes(chainWithFills())
    await new MarkUpdater(b.pub, b.wallet, MARKET, emptyBook, { ...CFG, dryRun: true }).runOnce()
    expect(b.writes).toHaveLength(0)
    errSpy.mockRestore()
  })

  it('respects minMarkInterval and never writes after a confirmed credit event', async () => {
    const a = fakes({ ...chainWithFills(), lastMarkUpdate: 19_700n })
    await new MarkUpdater(a.pub, a.wallet, MARKET, emptyBook, CFG).runOnce()
    expect(a.writes).toHaveLength(0)
    const b = fakes({ ...chainWithFills(), confirmed: true })
    const u = new MarkUpdater(b.pub, b.wallet, MARKET, emptyBook, CFG)
    await u.runOnce()
    expect(b.writes).toHaveLength(0)
    expect(u.health().lastPlan).toMatch(/confirmed/)
  })

  it('falls back to the depth-filtered book mid when there are no fills', async () => {
    const c: Chain = { mark: w(0.10), lastMarkUpdate: 0n, head: { number: 1000n, timestamp: 20_000n }, logs: [], blockTs: {} }
    const { pub, wallet, writes } = fakes(c)
    const book: IBookSource = { fetch: async () => [
      order({ side: 'bid', tokenOut: YES, minAmountOut: String(T(50)), price: 0.20, expiry: '30000' }),
      order({ side: 'ask', tokenIn: YES, tokenOut: '0xusdc', amountIn: String(T(50)), price: 0.26, expiry: '30000' }),
    ] }
    const u = new MarkUpdater(pub, wallet, MARKET, book, CFG)
    await u.runOnce()
    expect(writes[0].args![0]).toBe(w(0.23))
    expect(u.health().source).toBe('book')
  })

  it('holds and alerts after MARK_STALE_ALERT_SEC with no source', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    let now = 1_000_000
    const c: Chain = { mark: w(0.10), lastMarkUpdate: 0n, head: { number: 1000n, timestamp: 20_000n }, logs: [], blockTs: {} }
    const { pub, wallet, writes } = fakes(c)
    const u = new MarkUpdater(pub, wallet, MARKET, emptyBook, { ...CFG, staleAlertSec: 60 }, () => now)
    await u.runOnce()
    expect(errSpy.mock.calls.some(x => String(x[0]).includes('[ALERT]'))).toBe(false)
    now += 61_000
    await u.runOnce()
    expect(writes).toHaveLength(0)
    expect(errSpy.mock.calls.some(x => String(x[0]).includes('[ALERT]') && String(x[0]).includes('no usable'))).toBe(true)
    errSpy.mockRestore()
  })

  it('reads logs incrementally across polls', async () => {
    const c = chainWithFills()
    const { pub, wallet } = fakes(c)
    const u = new MarkUpdater(pub, wallet, MARKET, emptyBook, CFG)
    await u.runOnce()
    c.head = { number: 1010n, timestamp: 20_020n }
    await u.runOnce()
    const calls = (pub.getLogs as ReturnType<typeof vi.fn>).mock.calls.map(x => [x[0].fromBlock, x[0].toBlock])
    expect(calls[calls.length - 1]).toEqual([1001n, 1010n])
  })
})

describe('MarkUpdaterService', () => {
  it('runs active markets one at a time and survives a failing one', async () => {
    const order: string[] = []
    const markets = [MARKET, { ...MARKET, slug: 'try' }, { ...MARKET, slug: 'old', active: false }] as MarketInfo[]
    const dir = {
      mode: 'registry' as const,
      list: (o?: { activeOnly?: boolean }) => markets.filter(m => !o?.activeOnly || m.active),
      status: () => ({ mode: 'registry' as const, registryAddress: null, marketCount: 3, lastRefreshAt: 1, lastError: null }),
    }
    const svc = new MarkUpdaterService(dir as never, m => ({
      runOnce: async () => { order.push(m.slug); if (m.slug === 'crwv') throw new Error('boom') },
      health: () => ({}) as never,
    }), { pollMs: 1e9, dryRun: false })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await svc.runAll()
    expect(order).toEqual(['crwv', 'try'])
    errSpy.mockRestore()
  })
})

describe('markConfigFromEnv', () => {
  it('defaults', () => {
    const c = markConfigFromEnv({})
    expect(c.pollMs).toBe(60_000)
    expect(c.deadband).toBe(w(0.0025))
    expect(c.bookMaxSpread).toBe(w(0.1))
    expect(c.dryRun).toBe(false)
    expect(markConfigFromEnv({ MARK_DRY_RUN: 'true' }).dryRun).toBe(true)
    expect(WAD).toBe(10n ** 18n)
  })
})
