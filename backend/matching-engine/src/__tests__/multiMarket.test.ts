import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { ContractFunctionRevertedError, encodeErrorResult } from 'viem'
import { MatchingEngine } from '../engine'
import { Settler, CLOB_SETTLEMENT_ABI } from '../settler'
import type { IPublicClient, IWalletClient, OrderRemover } from '../settler'
import { MarketDirectory } from '../registry'
import type { IRegistryClient } from '../registry'
import type { OrderBook, StoredOrder } from '../types'
import type { OrderBookClient } from '../client'

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}`
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const M = {
  mstr:   { cm: a(0x100), yes: a(0x101), no: a(0x102), clob: a(0x103) },
  turkey: { cm: a(0x200), yes: a(0x201), no: a(0x202), clob: a(0x203) },
  dead:   { cm: a(0x300), yes: a(0x301), no: a(0x302), clob: a(0x303) },
}

function rawMarket(slug: keyof typeof M, active = true) {
  const m = M[slug]
  return {
    slug, entityName: slug, entityType: 0, creditMarket: m.cm, yesToken: m.yes, noToken: m.no,
    clobSettlement: m.clob, oracleRouter: a(1), liquidationEngine: a(2), active, registeredAt: 1n, startBlock: 1n,
  }
}

async function directory(): Promise<MarketDirectory> {
  const client: IRegistryClient = {
    readContract: async () => [rawMarket('mstr'), rawMarket('turkey'), rawMarket('dead', false)],
  }
  const d = new MarketDirectory({ client, registryAddress: a(0x999) as `0x${string}`, log: () => {} })
  await d.refresh()
  return d
}

let seq = 0
function order(
  id: string, slug: string, token: string, kind: 'bid' | 'ask', price: number, extra: Partial<StoredOrder> = {},
): StoredOrder {
  return {
    id, market: slug, maker: a(0xabc + (++seq)), nonce: String(seq),
    tokenIn: kind === 'bid' ? USDC : token, tokenOut: kind === 'bid' ? token : USDC,
    amountIn: '1000', minAmountOut: '1000', expiry: '9999999999', signature: '0xsig',
    side: kind, price, timestamp: Date.now() + seq, ...extra,
  }
}

// ─── Engine ───────────────────────────────────────────────────────────────────

describe('MatchingEngine — multi-market', () => {
  const cfg = async () => ({ yesTokenAddress: a(1), noTokenAddress: a(2), usdcAddress: USDC, directory: await directory() })

  it('fetches each ACTIVE market by slug and matches each book independently', async () => {
    const books: Record<string, OrderBook> = {
      mstr:   { bids: [order('mb', 'mstr', M.mstr.yes, 'bid', 0.3)],     asks: [order('ma', 'mstr', M.mstr.yes, 'ask', 0.2)] },
      turkey: { bids: [order('tb', 'turkey', M.turkey.no, 'bid', 0.6)],  asks: [order('ta', 'turkey', M.turkey.no, 'ask', 0.5)] },
    }
    const fetchOrderBook = vi.fn(async (slug?: string) => books[slug!])
    const engine = new MatchingEngine({ fetchOrderBook } as OrderBookClient, await cfg())
    const matches: Array<[StoredOrder, StoredOrder]> = []
    engine.on('matched', (m, t) => matches.push([m, t]))
    await engine.runOnce()
    expect(fetchOrderBook.mock.calls.map(c => c[0])).toEqual(['mstr', 'turkey'])   // 'dead' inactive: skipped
    expect(matches.map(([m, t]) => [m.id, t.id])).toEqual([['ma', 'mb'], ['ta', 'tb']])
  })

  it('never crosses orders from different markets (even if one book contains both)', async () => {
    // A server that ignores ?market= returns one mixed book for every slug.
    const mixed: OrderBook = {
      bids: [order('mb', 'mstr', M.mstr.yes, 'bid', 0.9)],
      asks: [order('ta', 'turkey', M.turkey.yes, 'ask', 0.1)],
    }
    const engine = new MatchingEngine({ fetchOrderBook: async () => mixed } as OrderBookClient, await cfg())
    const matches: unknown[] = []
    engine.on('matched', (...args) => matches.push(args))
    await engine.runOnce()
    expect(matches).toHaveLength(0)
  })

  it('same-token crossing only happens when both orders carry the same market', async () => {
    // Stamped turkey but using mstr's YES token: filtered out of mstr's matching
    // by slug, and out of turkey's by token.
    const book: OrderBook = {
      bids: [order('b', 'turkey', M.mstr.yes, 'bid', 0.9)],
      asks: [order('a', 'mstr', M.mstr.yes, 'ask', 0.1)],
    }
    const engine = new MatchingEngine({ fetchOrderBook: async () => book } as OrderBookClient, await cfg())
    const matches: unknown[] = []
    engine.on('matched', (...args) => matches.push(args))
    await engine.runOnce()
    expect(matches).toHaveLength(0)
  })

  it("treats a missing `market` as 'mstr'", async () => {
    const bid = order('b', 'x', M.mstr.yes, 'bid', 0.3); delete bid.market
    const ask = order('a', 'x', M.mstr.yes, 'ask', 0.2); delete ask.market
    const engine = new MatchingEngine({ fetchOrderBook: async (s?: string) => (s === 'mstr' ? { bids: [bid], asks: [ask] } : { bids: [], asks: [] }) } as OrderBookClient, await cfg())
    const matches: unknown[] = []
    engine.on('matched', (...args) => matches.push(args))
    await engine.runOnce()
    expect(matches).toHaveLength(1)
  })

  it("one market's fetch failure does not starve the others (error still surfaces)", async () => {
    const fetchOrderBook = vi.fn(async (slug?: string) => {
      if (slug === 'mstr') throw new Error('boom')
      return { bids: [order('tb', 'turkey', M.turkey.yes, 'bid', 0.3)], asks: [order('ta', 'turkey', M.turkey.yes, 'ask', 0.2)] }
    })
    const engine = new MatchingEngine({ fetchOrderBook } as OrderBookClient, await cfg())
    const matches: unknown[] = []
    engine.on('matched', (...args) => matches.push(args))
    await expect(engine.runOnce()).rejects.toThrow('boom')
    expect(matches).toHaveLength(1)
  })
})

// ─── Settler ──────────────────────────────────────────────────────────────────

function revert(errorName: 'PositionFrozen' | 'NonceUsed') {
  return new ContractFunctionRevertedError({
    abi: CLOB_SETTLEMENT_ABI,
    data: encodeErrorResult({ abi: CLOB_SETTLEMENT_ABI, errorName, args: [] }),
    functionName: 'verifyAndSettle',
  })
}

async function settlerHarness(over: { estimate?: () => Promise<bigint>; read?: (args: { address: string; functionName: string }) => Promise<unknown> } = {}) {
  const engine = new EventEmitter() as unknown as MatchingEngine
  ;(engine as unknown as { releasePendingSettlement: unknown }).releasePendingSettlement = vi.fn()
  const publicClient: IPublicClient = {
    estimateContractGas: vi.fn(over.estimate ?? (async () => 200_000n)),
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' as const })),
    readContract: vi.fn(async (args) => over.read ? over.read(args as { address: string; functionName: string }) : false),
  }
  const walletClient: IWalletClient = {
    writeContract: vi.fn(async () => '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as const),
    account: { address: a(0xfeed) as `0x${string}` },
  }
  const orderRemover: OrderRemover = { removeOrder: vi.fn(async () => {}) }
  new Settler(engine, { usdcAddress: USDC as `0x${string}`, directory: await directory() }, publicClient, walletClient, orderRemover)
  const flush = (ms = 30) => new Promise(r => setTimeout(r, ms))
  return { engine, publicClient, walletClient, orderRemover, flush }
}

describe('Settler — multi-market routing', () => {
  it("submits each pair to that market's own CLOBSettlement", async () => {
    const h = await settlerHarness()
    h.engine.emit('matched', order('ma', 'mstr', M.mstr.yes, 'ask', 0.2), order('mb', 'mstr', M.mstr.yes, 'bid', 0.3))
    h.engine.emit('matched', order('ta', 'turkey', M.turkey.no, 'ask', 0.2), order('tb', 'turkey', M.turkey.no, 'bid', 0.3))
    await h.flush()
    const targets = (h.walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0].address)
    expect(targets).toEqual([M.mstr.clob, M.turkey.clob])
    // cleanup targets each order's own namespaced book
    expect(h.orderRemover.removeOrder).toHaveBeenCalledWith('ta', 'ask', 'turkey')
    expect(h.orderRemover.removeOrder).toHaveBeenCalledWith('tb', 'bid', 'turkey')
    expect(h.orderRemover.removeOrder).toHaveBeenCalledWith('ma', 'ask', 'mstr')
  })

  it('PositionFrozen reads claimable() on the pair\'s market CreditMarket and prunes the flagged order', async () => {
    const h = await settlerHarness({
      estimate: async () => { throw revert('PositionFrozen') },
      read: async ({ address }) => address === M.turkey.cm,
    })
    h.engine.emit('matched', order('ta', 'turkey', M.turkey.yes, 'ask', 0.2), order('tb', 'turkey', M.turkey.yes, 'bid', 0.3))
    await h.flush(2500)
    const reads = (h.publicClient.readContract as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0].address)
    expect(new Set(reads)).toEqual(new Set([M.turkey.cm]))
    expect(h.orderRemover.removeOrder).toHaveBeenCalledWith('ta', 'ask', 'turkey')
    expect(h.orderRemover.removeOrder).toHaveBeenCalledWith('tb', 'bid', 'turkey')
  })

  it("NonceUsed reads usedNonces on that market's CLOB", async () => {
    const h = await settlerHarness({
      estimate: async () => { throw revert('NonceUsed') },
      read: async () => true,
    })
    h.engine.emit('matched', order('ta', 'turkey', M.turkey.yes, 'ask', 0.2), order('tb', 'turkey', M.turkey.yes, 'bid', 0.3))
    await h.flush(2500)
    const calls = (h.publicClient.readContract as ReturnType<typeof vi.fn>).mock.calls.map(c => [c[0].address, c[0].functionName])
    expect(calls).toEqual([[M.turkey.clob, 'usedNonces'], [M.turkey.clob, 'usedNonces']])
  })

  const refuse = async (maker: StoredOrder, taker: StoredOrder) => {
    const h = await settlerHarness()
    h.engine.emit('matched', maker, taker)
    await h.flush()
    expect(h.publicClient.estimateContractGas).not.toHaveBeenCalled()
    expect(h.walletClient.writeContract).not.toHaveBeenCalled()
    return h
  }

  it('REFUSES (prunes both, no submit) a pair from different markets', async () => {
    const h = await refuse(
      order('ma', 'mstr', M.mstr.yes, 'ask', 0.2),
      order('tb', 'turkey', M.turkey.yes, 'bid', 0.3),
    )
    expect(h.orderRemover.removeOrder).toHaveBeenCalledWith('ma', 'ask', 'mstr')
    expect(h.orderRemover.removeOrder).toHaveBeenCalledWith('tb', 'bid', 'turkey')
  })

  it("REFUSES a pair stamped with one market but trading another market's token", async () => {
    const h = await refuse(
      order('a', 'mstr', M.turkey.yes, 'ask', 0.2),
      order('b', 'mstr', M.turkey.yes, 'bid', 0.3),
    )
    expect(h.orderRemover.removeOrder).toHaveBeenCalledTimes(2)
  })

  it('REFUSES an order whose legs are not {USDC, outcome token}', async () => {
    const bad = order('b', 'mstr', M.mstr.yes, 'bid', 0.3, { tokenOut: M.mstr.cm })   // creditMarket address as "token"
    await refuse(order('a', 'mstr', M.mstr.yes, 'ask', 0.2), bad)
    const bad2 = order('b2', 'mstr', M.mstr.yes, 'bid', 0.3, { tokenIn: M.mstr.no, tokenOut: M.mstr.yes })   // no USDC leg
    await refuse(order('a2', 'mstr', M.mstr.yes, 'ask', 0.2), bad2)
  })

  it('REFUSES pairs on different outcome tokens or the same side', async () => {
    await refuse(order('a', 'mstr', M.mstr.yes, 'ask', 0.2), order('b', 'mstr', M.mstr.no, 'bid', 0.3))
    await refuse(order('a', 'mstr', M.mstr.yes, 'ask', 0.2), order('b', 'mstr', M.mstr.yes, 'ask', 0.3))
  })

  it('does not prune (releases) when the market is unknown to this directory', async () => {
    const h = await settlerHarness()
    h.engine.emit('matched', order('a', 'ghost', M.mstr.yes, 'ask', 0.2), order('b', 'ghost', M.mstr.yes, 'bid', 0.3))
    await h.flush()
    expect(h.walletClient.writeContract).not.toHaveBeenCalled()
    expect(h.orderRemover.removeOrder).not.toHaveBeenCalled()
    expect((h.engine as unknown as { releasePendingSettlement: ReturnType<typeof vi.fn> }).releasePendingSettlement).toHaveBeenCalledWith('a', 'b')
  })
})
