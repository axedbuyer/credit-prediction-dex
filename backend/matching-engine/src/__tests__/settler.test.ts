import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { ContractFunctionRevertedError, encodeErrorResult } from 'viem'
import { Settler, NonceQueue, RedisOrderRemover, CLOB_SETTLEMENT_ABI } from '../settler'
import type { IPublicClient, IWalletClient, OrderRemover, SettlerConfig } from '../settler'
import { MatchingEngine as RealMatchingEngine } from '../engine'
import type { MatchingEngine } from '../engine'
import type { StoredOrder } from '../types'
import { MarketDirectory, legacyMarket } from '../registry'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CLOB_ADDRESS         = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9' as const
const CREDIT_MARKET_ADDR   = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0' as const
const USDC_ADDRESS         = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const
const SETTLER_ADDR         = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
const TX_HASH              = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as const

const YES_ADDR = '0x0000000000000000000000000000000000000001' as const
const NO_ADDR  = '0x0000000000000000000000000000000000000002' as const

// Legacy one-market directory (mstr) — the settler's pre-multi-market behaviour.
const CONFIG: SettlerConfig = {
  usdcAddress: USDC_ADDRESS,
  directory: new MarketDirectory({
    legacy: legacyMarket({
      creditMarket: CREDIT_MARKET_ADDR, yesToken: YES_ADDR, noToken: NO_ADDR, clobSettlement: CLOB_ADDRESS,
    }),
  }),
}

// A real ContractFunctionRevertedError, decoded from actual ABI-encoded revert
// data — exercises the same decode path (`err.walk` / `.data.errorName`) that
// real viem estimateContractGas failures produce, rather than a hand-rolled stub.
type RevertName = 'FundingShortfall' | 'PositionFrozen' | 'SlippageExceeded' | 'FillTooSmall'
  | 'FillExceedsRemaining' | 'OrderInvalidated' | 'OrderExpired' | 'InvalidOrder'

function makeRevertError(errorName: RevertName) {
  const data = encodeErrorResult({ abi: CLOB_SETTLEMENT_ABI, errorName, args: [] })
  return new ContractFunctionRevertedError({
    abi: CLOB_SETTLEMENT_ABI,
    data,
    functionName: 'fillOrders',
  })
}

function makeOrder(
  id: string,
  side: 'bid' | 'ask' = 'ask',
  overrides: Partial<Pick<StoredOrder, 'maker' | 'tokenIn' | 'tokenOut'>> = {},
): StoredOrder {
  const isBid = side === 'bid'
  return {
    id,
    maker:        overrides.maker    ?? '0xmaker',
    tokenIn:      overrides.tokenIn  ?? (isBid ? USDC_ADDRESS : YES_ADDR),
    tokenOut:     overrides.tokenOut ?? (isBid ? YES_ADDR : USDC_ADDRESS),
    amountIn:     '1000000000000000000',
    // Both sides 1e18 tokens (an ask offers amountIn, a bid wants minAmountOut), so a
    // FILL-token fill fills both orders completely.
    minAmountOut: '1000000000000000000',
    expiry:       String(Math.floor(Date.now() / 1000) + 3600),
    nonce:        '1',
    signature:    '0xsig',
    side,
    price:        0.23,
    timestamp:    Date.now(),
  }
}

// Default fill size: both fixture orders' full size.
const FILL = 10n ** 18n

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms))
}

// Use a bare EventEmitter as the engine — Settler calls engine.on('matched', …)
// and, on non-pruned settlement failures, engine.releasePendingSettlement(...ids)
// to un-wedge orders (plus engine.markIncompatible on SlippageExceeded). Stub
// both as spies so tests can assert on them.
function makeEngine() {
  const engine = new EventEmitter() as unknown as MatchingEngine & {
    releasePendingSettlement: ReturnType<typeof vi.fn>
    markIncompatible: ReturnType<typeof vi.fn>
  }
  const spies = engine as unknown as Record<'releasePendingSettlement' | 'markIncompatible', ReturnType<typeof vi.fn>>
  spies.releasePendingSettlement = vi.fn()
  spies.markIncompatible = vi.fn()
  return engine
}

// ─── Mock clients ─────────────────────────────────────────────────────────────

function makeMocks(overrides: {
  estimateContractGas?: () => Promise<bigint>
  writeContract?: () => Promise<string>
  waitForTransactionReceipt?: () => Promise<{ status: 'success' | 'reverted' }>
  readContract?: (args: { functionName: string; args: readonly unknown[] }) => Promise<unknown>
} = {}) {
  const publicClient: IPublicClient = {
    estimateContractGas: vi.fn().mockImplementation(
      overrides.estimateContractGas ?? (() => Promise.resolve(200_000n)),
    ),
    waitForTransactionReceipt: vi.fn().mockImplementation(
      overrides.waitForTransactionReceipt ??
        (() => Promise.resolve({ status: 'success' as const })),
    ),
    readContract: vi.fn().mockImplementation(
      overrides.readContract ?? (() => Promise.resolve(false)),
    ),
  }
  const walletClient: IWalletClient = {
    writeContract: vi.fn().mockImplementation(
      overrides.writeContract ?? (() => Promise.resolve(TX_HASH)),
    ),
    account: { address: SETTLER_ADDR },
  }
  const orderRemover: OrderRemover = {
    removeOrder: vi.fn().mockResolvedValue(undefined),
    setFilled: vi.fn().mockResolvedValue(undefined),
  }
  return { publicClient, walletClient, orderRemover }
}

// ─── Settler: successful settlement ──────────────────────────────────────────

describe('Settler — successful settlement', () => {
  it('calls fillOrders with correct args and emits settled', async () => {
    const engine = makeEngine()
    const { publicClient, walletClient, orderRemover } = makeMocks()
    const settler = new Settler(engine, CONFIG, publicClient, walletClient, orderRemover)

    const settled: string[] = []
    settler.on('settled', h => settled.push(h))

    const maker = makeOrder('ask1', 'ask')
    const taker = makeOrder('bid1', 'bid')
    engine.emit('matched', maker, taker, FILL)

    // Allow the async queue to flush
    await sleep(50)

    // writeContract called once with the right function
    expect(walletClient.writeContract).toHaveBeenCalledOnce()
    const callArgs = (walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArgs.address).toBe(CLOB_ADDRESS)
    expect(callArgs.functionName).toBe('fillOrders')

    // gas = estimatedGas * 1.2
    const estimated = await (publicClient.estimateContractGas as ReturnType<typeof vi.fn>)
      .mock.results[0].value as bigint
    expect(callArgs.gas).toBe((estimated * 120n) / 100n)

    // args = [makerOrder, makerSig, takerOrder, takerSig, tokens]
    const [makerArg, makerSig, takerArg, takerSig, tokens] = callArgs.args
    expect(tokens).toBe(FILL)
    expect(makerArg.maker).toBe(maker.maker)
    expect(takerArg.maker).toBe(taker.maker)
    expect(makerArg.amountIn).toBe(BigInt(maker.amountIn))
    expect(makerArg.signature).toBeUndefined()
    expect(takerArg.signature).toBeUndefined()
    expect(makerSig).toBe(maker.signature)
    expect(takerSig).toBe(taker.signature)

    // Both orders fully filled → removed from the store
    expect(orderRemover.removeOrder).toHaveBeenCalledWith('ask1', 'ask', 'mstr')
    expect(orderRemover.removeOrder).toHaveBeenCalledWith('bid1', 'bid', 'mstr')
    expect(orderRemover.setFilled).not.toHaveBeenCalled()

    // settled event emitted with tx hash
    expect(settled).toEqual([TX_HASH])
  })

  it('partial fill: the fully filled order is removed; the other keeps resting with its new filled and is released', async () => {
    const engine = makeEngine()
    const { publicClient, walletClient, orderRemover } = makeMocks()
    const settler = new Settler(engine, CONFIG, publicClient, walletClient, orderRemover)

    // Ask offers 1e18 (0.25e18 already filled earlier); bid wants only 0.25e18.
    const ask = { ...makeOrder('ask-big', 'ask'), filled: (25n * 10n ** 16n).toString() }
    const bid = { ...makeOrder('bid-small', 'bid'), minAmountOut: (25n * 10n ** 16n).toString() }
    engine.emit('matched', ask, bid, 25n * 10n ** 16n)
    await sleep(50)

    expect((walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0].args[4]).toBe(25n * 10n ** 16n)
    expect(orderRemover.removeOrder).toHaveBeenCalledTimes(1)
    expect(orderRemover.removeOrder).toHaveBeenCalledWith('bid-small', 'bid', 'mstr')
    expect(orderRemover.setFilled).toHaveBeenCalledWith('ask-big', 5n * 10n ** 17n)
    expect(engine.releasePendingSettlement).toHaveBeenCalledWith('ask-big')
    expect(engine.releasePendingSettlement).not.toHaveBeenCalledWith('bid-small')
  })
})

// ─── Settler: failed transaction ─────────────────────────────────────────────

describe('Settler — failed transaction', () => {
  it('does not remove orders from Redis when tx is reverted', async () => {
    const engine = makeEngine()
    const { publicClient, walletClient, orderRemover } = makeMocks({
      waitForTransactionReceipt: () => Promise.resolve({ status: 'reverted' }),
    })
    const settler = new Settler(engine, CONFIG, publicClient, walletClient, orderRemover)

    const settled: string[] = []
    settler.on('settled', h => settled.push(h))

    engine.emit('matched', makeOrder('ask-rev', 'ask'), makeOrder('bid-rev', 'bid'), FILL)
    await sleep(50)

    // writeContract still called — we submitted the tx
    expect(walletClient.writeContract).toHaveBeenCalledOnce()
    // But orders must NOT be removed
    expect(orderRemover.removeOrder).not.toHaveBeenCalled()
    // And no settled event
    expect(settled).toHaveLength(0)
    // v1b1-7 wedge fix: on-chain revert is a known-final outcome — orders are
    // released back into pendingSettlement so the next poll cycle can retry them.
    expect(engine.releasePendingSettlement).toHaveBeenCalledWith('ask-rev', 'bid-rev')
  })

  it('does not remove orders when writeContract throws', async () => {
    const engine = makeEngine()
    const { publicClient, walletClient, orderRemover } = makeMocks({
      writeContract: () => Promise.reject(new Error('insufficient funds')),
    })
    const settler = new Settler(engine, CONFIG, publicClient, walletClient, orderRemover)

    engine.emit('matched', makeOrder('ask-err', 'ask'), makeOrder('bid-err', 'bid'), FILL)
    await sleep(50)

    expect(orderRemover.removeOrder).not.toHaveBeenCalled()
    // No tx was ever broadcast — safe to release immediately for a retry.
    expect(engine.releasePendingSettlement).toHaveBeenCalledWith('ask-err', 'bid-err')
  })

  it('does NOT release pending orders when the receipt wait itself fails (outcome unknown)', async () => {
    const engine = makeEngine()
    const { publicClient, walletClient, orderRemover } = makeMocks({
      waitForTransactionReceipt: () => Promise.reject(new Error('RPC timeout')),
    })
    const settler = new Settler(engine, CONFIG, publicClient, walletClient, orderRemover)

    engine.emit('matched', makeOrder('ask-receipt', 'ask'), makeOrder('bid-receipt', 'bid'), FILL)
    await sleep(3000)

    expect(orderRemover.removeOrder).not.toHaveBeenCalled()
    // The tx WAS broadcast and its outcome is genuinely unknown — releasing
    // here would risk a real double-submission racing an in-flight tx, so
    // this is the one failure path that deliberately stays wedged.
    expect(engine.releasePendingSettlement).not.toHaveBeenCalled()
  }, 10_000)

  it('does not remove orders when gas estimation fails after retries', async () => {
    const engine = makeEngine()
    const { publicClient, walletClient, orderRemover } = makeMocks({
      estimateContractGas: () => Promise.reject(new Error('RPC timeout')),
    })
    const settler = new Settler(engine, CONFIG, publicClient, walletClient, orderRemover)

    engine.emit('matched', makeOrder('ask-gas', 'ask'), makeOrder('bid-gas', 'bid'), FILL)

    // withRetry retries 3× with exponential backoff; use generous wait
    await sleep(3000)

    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(orderRemover.removeOrder).not.toHaveBeenCalled()
    // No tx submitted (failed at estimation) — released for retry.
    expect(engine.releasePendingSettlement).toHaveBeenCalledWith('ask-gas', 'bid-gas')
  }, 10_000)
})

// ─── Settler: deterministic-revert handling (v1b1) ───────────────────────────

describe('Settler — deterministic revert handling', () => {
  const MAKER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const
  const MAKER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const

  it('FundingShortfall: removes only the seller-side order, keeps the buyer order, submits no tx', async () => {
    const engine = makeEngine()
    const { publicClient, walletClient, orderRemover } = makeMocks({
      estimateContractGas: () => Promise.reject(makeRevertError('FundingShortfall')),
    })
    const settler = new Settler(engine, CONFIG, publicClient, walletClient, orderRemover)

    // Seller leg: tokenIn = YES/NO (not USDC). Buyer leg: tokenIn = USDC.
    const sellerOrder = makeOrder('ask-fs', 'ask', { maker: MAKER_A })
    const buyerOrder  = makeOrder('bid-fs', 'bid', {
      maker:    MAKER_B,
      tokenIn:  USDC_ADDRESS,
      tokenOut: '0x0000000000000000000000000000000000000001',
    })
    engine.emit('matched', sellerOrder, buyerOrder, FILL)

    await sleep(3000)

    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(orderRemover.removeOrder).toHaveBeenCalledTimes(1)
    expect(orderRemover.removeOrder).toHaveBeenCalledWith('ask-fs', 'ask', 'mstr')
    // Buyer order was untouched — must be released so it can still match.
    expect(engine.releasePendingSettlement).toHaveBeenCalledWith('bid-fs')
    expect(engine.releasePendingSettlement).not.toHaveBeenCalledWith('ask-fs')
  }, 10_000)

  it('PositionFrozen: claimable(makerA)=true, claimable(makerB)=false → only makerA order removed', async () => {
    const engine = makeEngine()
    const { publicClient, walletClient, orderRemover } = makeMocks({
      estimateContractGas: () => Promise.reject(makeRevertError('PositionFrozen')),
      readContract: ({ args }) => {
        const [user] = args as [string]
        return Promise.resolve(user === MAKER_A)
      },
    })
    const settler = new Settler(engine, CONFIG, publicClient, walletClient, orderRemover)

    const orderA = makeOrder('ask-pf', 'ask', { maker: MAKER_A })
    const orderB = makeOrder('bid-pf', 'bid', { maker: MAKER_B })
    engine.emit('matched', orderA, orderB, FILL)

    await sleep(3000)

    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(orderRemover.removeOrder).toHaveBeenCalledTimes(1)
    expect(orderRemover.removeOrder).toHaveBeenCalledWith('ask-pf', 'ask', 'mstr')
    // The un-flagged taker order was untouched — release it so it can still match.
    expect(engine.releasePendingSettlement).toHaveBeenCalledWith('bid-pf')
    expect(engine.releasePendingSettlement).not.toHaveBeenCalledWith('ask-pf')
  }, 10_000)

  it('PositionFrozen: claimable() read throws → nothing removed, both released for retry', async () => {
    const engine = makeEngine()
    const { publicClient, walletClient, orderRemover } = makeMocks({
      estimateContractGas: () => Promise.reject(makeRevertError('PositionFrozen')),
      readContract: () => Promise.reject(new Error('RPC down')),
    })
    const settler = new Settler(engine, CONFIG, publicClient, walletClient, orderRemover)

    const orderA = makeOrder('ask-pf-err', 'ask', { maker: MAKER_A })
    const orderB = makeOrder('bid-pf-err', 'bid', { maker: MAKER_B })
    engine.emit('matched', orderA, orderB, FILL)

    await sleep(3000)

    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(orderRemover.removeOrder).not.toHaveBeenCalled()
    expect(engine.releasePendingSettlement).toHaveBeenCalledWith('ask-pf-err', 'bid-pf-err')
  }, 10_000)

  it('PositionFrozen but claimable() reports neither flagged → nothing removed, both released', async () => {
    const engine = makeEngine()
    const { publicClient, walletClient, orderRemover } = makeMocks({
      estimateContractGas: () => Promise.reject(makeRevertError('PositionFrozen')),
      readContract: () => Promise.resolve(false),
    })
    const settler = new Settler(engine, CONFIG, publicClient, walletClient, orderRemover)

    engine.emit('matched', makeOrder('ask-pf-none', 'ask', { maker: MAKER_A }), makeOrder('bid-pf-none', 'bid', { maker: MAKER_B }), FILL)

    await sleep(3000)

    expect(orderRemover.removeOrder).not.toHaveBeenCalled()
    expect(engine.releasePendingSettlement).toHaveBeenCalledWith('ask-pf-none', 'bid-pf-none')
  }, 10_000)

  it.each(['SlippageExceeded', 'FillTooSmall'] as const)('%s: nothing removed — pair marked incompatible, both released, no tx', async (name) => {
    const engine = makeEngine()
    const { publicClient, walletClient, orderRemover } = makeMocks({
      estimateContractGas: () => Promise.reject(makeRevertError(name)),
    })
    const settler = new Settler(engine, CONFIG, publicClient, walletClient, orderRemover)

    engine.emit('matched', makeOrder('ask-slip', 'ask'), makeOrder('bid-slip', 'bid'), FILL)

    await sleep(3000)

    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(orderRemover.removeOrder).not.toHaveBeenCalled()
    expect(engine.markIncompatible).toHaveBeenCalledWith('ask-slip', 'bid-slip')
    expect(engine.releasePendingSettlement).toHaveBeenCalledWith('ask-slip', 'bid-slip')
  }, 10_000)

  it('generic RPC error (not a deterministic revert) → nothing removed', async () => {
    const engine = makeEngine()
    const { publicClient, walletClient, orderRemover } = makeMocks({
      estimateContractGas: () => Promise.reject(new Error('execution reverted: out of gas')),
    })
    const settler = new Settler(engine, CONFIG, publicClient, walletClient, orderRemover)

    engine.emit('matched', makeOrder('ask-generic', 'ask'), makeOrder('bid-generic', 'bid'), FILL)

    await sleep(3000)

    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(orderRemover.removeOrder).not.toHaveBeenCalled()
    // v1b1-7 wedge fix: neither order is removed from the book, but both must
    // be released back into pendingSettlement — otherwise they're wedged
    // forever even though "other reverts keep the retry behavior" (root
    // CLAUDE.md) says they should be retried on the next poll cycle.
    expect(engine.releasePendingSettlement).toHaveBeenCalledWith('ask-generic', 'bid-generic')
  }, 10_000)
})

// ─── Settler + MatchingEngine: wedge-fix integration (v1b1-7) ────────────────
//
// Reproduces the actual reported bug end-to-end with the real MatchingEngine
// (not the bare-EventEmitter stand-in used above): a match is emitted, settle()
// hits a non-pruned revert (something other than FundingShortfall/
// PositionFrozen — e.g. OrderExpired), and the SAME two orders must be
// matchable again on the very next poll cycle instead of being wedged in
// pendingSettlement until process restart.
describe('Settler + MatchingEngine — wedge fix (non-pruned revert)', () => {
  it('re-matches the same order pair on the next poll cycle after a generic revert', async () => {
    const YES = '0x0000000000000000000000000000000000000001'
    const engineConfig = {
      yesTokenAddress: YES,
      noTokenAddress:  '0x0000000000000000000000000000000000000002',
      usdcAddress:     USDC_ADDRESS,
      pollIntervalMs:  100,
    }

    const bid = {
      id: 'bid-wedge', maker: '0xbuyer', tokenIn: USDC_ADDRESS, tokenOut: YES,
      amountIn: '1000', minAmountOut: '1000',
      expiry: String(Math.floor(Date.now() / 1000) + 3600), nonce: '1',
      signature: '0xsig', side: 'bid' as const, price: 0.30, timestamp: Date.now(),
    }
    const ask = {
      id: 'ask-wedge', maker: '0xseller', tokenIn: YES, tokenOut: USDC_ADDRESS,
      amountIn: '1000', minAmountOut: '230', expiry: bid.expiry, nonce: '1',
      signature: '0xsig', side: 'ask' as const, price: 0.25, timestamp: Date.now(),
    }
    const book = { bids: [bid], asks: [ask] }

    const realEngine = new RealMatchingEngine({ fetchOrderBook: async () => book }, engineConfig)

    // estimateContractGas rejects with a plain (non-deterministic) revert on
    // every call — simulating something like OrderExpired, which isn't one
    // of the two pruned error names.
    const { publicClient, walletClient, orderRemover } = makeMocks({
      estimateContractGas: () => Promise.reject(new Error('execution reverted: OrderExpired')),
    })
    new Settler(realEngine, CONFIG, publicClient, walletClient, orderRemover)

    // Cycle 1: matches, then settle() fails and (post-fix) releases both ids.
    // estimateContractGas is wrapped in withRetry (3 attempts, exponential
    // backoff) before the failure handler runs — give it the same generous
    // wait used by the other retry-path tests above.
    await realEngine.runOnce()
    await sleep(3000)
    expect(orderRemover.removeOrder).not.toHaveBeenCalled()

    // Cycle 2: same book (order still resting, never removed) — pre-fix this
    // would silently match zero times forever because both ids stayed stuck
    // in pendingSettlement; post-fix it matches again.
    const matchedAgain: Array<[string, string]> = []
    realEngine.on('matched', (maker, taker) => matchedAgain.push([maker.id, taker.id]))
    await realEngine.runOnce()

    expect(matchedAgain).toEqual([['ask-wedge', 'bid-wedge']])
  }, 10_000)
})

// ─── NonceQueue: serialisation ────────────────────────────────────────────────

describe('NonceQueue', () => {
  it('runs tasks sequentially — never more than one concurrent', async () => {
    const queue = new NonceQueue()

    let concurrent = 0
    let maxConcurrent = 0
    let completed = 0

    const task = async () => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      await sleep(10)
      concurrent--
      completed++
    }

    // Enqueue 3 tasks "simultaneously" (before any resolves)
    const p1 = queue.enqueue(task)
    const p2 = queue.enqueue(task)
    const p3 = queue.enqueue(task)

    await Promise.all([p1, p2, p3])

    expect(completed).toBe(3)
    expect(maxConcurrent).toBe(1)  // never ran more than one at a time
  })

  it('queues concurrent settlement calls from matched events', async () => {
    const engine  = makeEngine()
    let callCount = 0
    let concurrent = 0
    let maxConcurrent = 0

    const { publicClient, orderRemover } = makeMocks()
    const walletClient: IWalletClient = {
      writeContract: vi.fn().mockImplementation(async () => {
        concurrent++
        maxConcurrent = Math.max(maxConcurrent, concurrent)
        await sleep(10)  // simulate network latency
        concurrent--
        callCount++
        return `0x${callCount.toString().padStart(64, '0')}`
      }),
      account: { address: SETTLER_ADDR },
    }

    const settler = new Settler(engine, CONFIG, publicClient, walletClient, orderRemover)

    // Fire three matched events before any settlement resolves
    engine.emit('matched', makeOrder('a1', 'ask'), makeOrder('b1', 'bid'), FILL)
    engine.emit('matched', makeOrder('a2', 'ask'), makeOrder('b2', 'bid'), FILL)
    engine.emit('matched', makeOrder('a3', 'ask'), makeOrder('b3', 'bid'), FILL)

    // Wait for all three sequential settlements (3 × ~10 ms + overhead)
    await sleep(200)

    expect(callCount).toBe(3)
    expect(maxConcurrent).toBe(1)  // queue serialised — never concurrent

    // All 6 orders (3 pairs) removed from Redis
    expect(orderRemover.removeOrder).toHaveBeenCalledTimes(6)
  })
})

// ─── NonceQueue: idle() draining ──────────────────────────────────────────────

describe('NonceQueue — idle()', () => {
  it('resolves immediately when nothing has ever been enqueued', async () => {
    const queue = new NonceQueue()
    await expect(queue.idle()).resolves.toBeUndefined()
  })

  it('resolves only after a task pending on a deferred promise completes', async () => {
    const queue = new NonceQueue()
    let release: (() => void) | undefined
    const task = () => new Promise<void>(resolve => { release = resolve })

    void queue.enqueue(task)

    let idleResolved = false
    const idlePromise = queue.idle().then(() => { idleResolved = true })

    await sleep(20)
    expect(idleResolved).toBe(false)  // task still pending — must not resolve yet

    release!()
    await idlePromise
    expect(idleResolved).toBe(true)
  })

  it('waits for a task enqueued while the queue was already busy (queued behind another)', async () => {
    const queue = new NonceQueue()
    let releaseFirst: (() => void) | undefined
    const first = () => new Promise<void>(resolve => { releaseFirst = resolve })
    const second = vi.fn(() => Promise.resolve())

    void queue.enqueue(first)
    void queue.enqueue(second)  // queued — first hasn't resolved yet

    let idleResolved = false
    const idlePromise = queue.idle().then(() => { idleResolved = true })

    await sleep(20)
    expect(idleResolved).toBe(false)
    expect(second).not.toHaveBeenCalled()

    releaseFirst!()
    await idlePromise
    expect(idleResolved).toBe(true)
    expect(second).toHaveBeenCalledOnce()
  })
})

// ─── Settler — whenIdle() / describePending() (graceful shutdown support) ────

describe('Settler — whenIdle() / describePending()', () => {
  it('describePending() is null when idle, and whenIdle() resolves immediately', async () => {
    const engine = makeEngine()
    const { publicClient, walletClient, orderRemover } = makeMocks()
    const settler = new Settler(engine, CONFIG, publicClient, walletClient, orderRemover)

    expect(settler.describePending()).toBeNull()
    await expect(settler.whenIdle()).resolves.toBeUndefined()
  })

  it('describePending() reports maker/taker (and tx hash once submitted) while a settlement is in flight; whenIdle() resolves only after it finishes', async () => {
    const engine = makeEngine()
    let releaseReceipt: (() => void) | undefined
    const { publicClient, walletClient, orderRemover } = makeMocks({
      waitForTransactionReceipt: () => new Promise(resolve => {
        releaseReceipt = () => resolve({ status: 'success' as const })
      }),
    })
    const settler = new Settler(engine, CONFIG, publicClient, walletClient, orderRemover)

    engine.emit('matched', makeOrder('ask-idle', 'ask'), makeOrder('bid-idle', 'bid'), FILL)

    // Wait until the tx has been "submitted" (writeContract resolved) and the
    // settlement is now parked on the deferred receipt wait.
    await sleep(50)
    expect(walletClient.writeContract).toHaveBeenCalledOnce()
    expect(settler.describePending()).toBe('maker=ask-idle taker=bid-idle tx=' + TX_HASH)

    let idleResolved = false
    const idlePromise = settler.whenIdle().then(() => { idleResolved = true })
    await sleep(20)
    expect(idleResolved).toBe(false)

    releaseReceipt!()
    await idlePromise
    expect(idleResolved).toBe(true)
    expect(settler.describePending()).toBeNull()
  })
})

// ─── Settler: NonceUsed (duplicate resubmission after a restart) ─────────────

describe('Settler — order-state reverts (remaining() resync)', () => {
  const MAKER_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const
  const MAKER_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const

  it.each(['FillExceedsRemaining', 'OrderInvalidated', 'OrderExpired', 'InvalidOrder'] as const)(
    '%s: prunes ONLY the order with nothing left on-chain; resyncs + releases the other',
    async (name) => {
      const engine = makeEngine()
      const reads: Array<{ functionName: string; args: readonly unknown[] }> = []
      const { publicClient, walletClient, orderRemover } = makeMocks({
        estimateContractGas: () => Promise.reject(makeRevertError(name)),
        readContract: (a) => {
          reads.push(a)
          const [order] = a.args as [{ maker: string }]
          // A's order is done on-chain; B's has 0.4e18 left (0.6e18 filled — e.g. a fill
          // that landed just before a restart, before Redis was updated).
          return Promise.resolve(order.maker === MAKER_A ? 0n : 4n * 10n ** 17n)
        },
      })
      const settler = new Settler(engine, CONFIG, publicClient, walletClient, orderRemover)

      engine.emit('matched', makeOrder('ask-done', 'ask', { maker: MAKER_A }), makeOrder('bid-left', 'bid', { maker: MAKER_B }), FILL)
      await sleep(3000)

      expect(walletClient.writeContract).not.toHaveBeenCalled()
      expect(reads.every(r => r.functionName === 'remaining')).toBe(true)
      expect(orderRemover.removeOrder).toHaveBeenCalledTimes(1)
      expect(orderRemover.removeOrder).toHaveBeenCalledWith('ask-done', 'ask', 'mstr')
      expect(orderRemover.setFilled).toHaveBeenCalledWith('bid-left', 6n * 10n ** 17n)
      expect(engine.releasePendingSettlement).toHaveBeenCalledWith('bid-left')
      expect(engine.releasePendingSettlement).not.toHaveBeenCalledWith('ask-done')
    },
    10_000,
  )

  it('remaining() read throws → nothing removed, both released for retry', async () => {
    const engine = makeEngine()
    const { publicClient, walletClient, orderRemover } = makeMocks({
      estimateContractGas: () => Promise.reject(makeRevertError('FillExceedsRemaining')),
      readContract: () => Promise.reject(new Error('RPC down')),
    })
    const settler = new Settler(engine, CONFIG, publicClient, walletClient, orderRemover)

    engine.emit('matched', makeOrder('ask-r-err', 'ask', { maker: MAKER_A }), makeOrder('bid-r-err', 'bid', { maker: MAKER_B }), FILL)
    await sleep(3000)

    expect(orderRemover.removeOrder).not.toHaveBeenCalled()
    expect(orderRemover.setFilled).not.toHaveBeenCalled()
    expect(engine.releasePendingSettlement).toHaveBeenCalledWith('ask-r-err', 'bid-r-err')
  }, 10_000)
})

// ─── RedisOrderRemover ────────────────────────────────────────────────────────

describe('RedisOrderRemover', () => {
  it('deletes the order key and removes from the correct sorted set', async () => {
    const redis = {
      del:  vi.fn().mockResolvedValue(1),
      zrem: vi.fn().mockResolvedValue(1),
      get:  vi.fn(),
      set:  vi.fn(),
    }
    const remover = new RedisOrderRemover(redis)

    await remover.removeOrder('order-abc', 'bid', 'mstr')

    expect(redis.del).toHaveBeenCalledWith('orders:order-abc')
    expect(redis.zrem).toHaveBeenCalledWith('orderbook:mstr:bids', 'order-abc')
  })

  it('uses the market-namespaced asks key for ask-side orders', async () => {
    const redis = {
      del:  vi.fn().mockResolvedValue(1),
      zrem: vi.fn().mockResolvedValue(1),
      get:  vi.fn(),
      set:  vi.fn(),
    }
    await new RedisOrderRemover(redis).removeOrder('order-xyz', 'ask', 'mstr')

    expect(redis.zrem).toHaveBeenCalledWith('orderbook:mstr:asks', 'order-xyz')
  })

  it('setFilled rewrites the stored order with XX (never resurrects a removed order)', async () => {
    const stored = { ...makeOrder('o1', 'ask'), market: 'mstr' }
    const redis = {
      del:  vi.fn(),
      zrem: vi.fn(),
      get:  vi.fn().mockResolvedValue(JSON.stringify(stored)),
      set:  vi.fn().mockResolvedValue('OK'),
    }
    await new RedisOrderRemover(redis).setFilled('o1', 7n)
    expect(redis.set).toHaveBeenCalledWith('orders:o1', JSON.stringify({ ...stored, filled: '7' }), 'XX')

    redis.get.mockResolvedValue(null)
    redis.set.mockClear()
    await new RedisOrderRemover(redis).setFilled('gone', 7n)
    expect(redis.set).not.toHaveBeenCalled()
  })
})
