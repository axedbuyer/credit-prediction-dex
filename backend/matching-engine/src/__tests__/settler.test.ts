import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'events'
import { Settler, NonceQueue, RedisOrderRemover } from '../settler'
import type { IPublicClient, IWalletClient, OrderRemover, SettlerConfig } from '../settler'
import type { MatchingEngine } from '../engine'
import type { StoredOrder } from '../types'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CLOB_ADDRESS = '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9' as const
const SETTLER_ADDR  = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
const TX_HASH       = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as const

const CONFIG: SettlerConfig = { clobSettlementAddress: CLOB_ADDRESS }

function makeOrder(id: string, side: 'bid' | 'ask' = 'ask'): StoredOrder {
  return {
    id,
    maker:        '0xmaker',
    tokenIn:      '0x0000000000000000000000000000000000000001',
    tokenOut:     '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    amountIn:     '1000000000000000000',
    minAmountOut: '230000',
    expiry:       String(Math.floor(Date.now() / 1000) + 3600),
    nonce:        '1',
    signature:    '0xsig',
    side,
    price:        0.23,
    timestamp:    Date.now(),
  }
}

function sleep(ms: number) {
  return new Promise<void>(r => setTimeout(r, ms))
}

// Use a bare EventEmitter as the engine — Settler only calls engine.on('matched', …)
function makeEngine() {
  return new EventEmitter() as unknown as MatchingEngine
}

// ─── Mock clients ─────────────────────────────────────────────────────────────

function makeMocks(overrides: {
  estimateContractGas?: () => Promise<bigint>
  writeContract?: () => Promise<string>
  waitForTransactionReceipt?: () => Promise<{ status: 'success' | 'reverted' }>
} = {}) {
  const publicClient: IPublicClient = {
    estimateContractGas: vi.fn().mockImplementation(
      overrides.estimateContractGas ?? (() => Promise.resolve(200_000n)),
    ),
    waitForTransactionReceipt: vi.fn().mockImplementation(
      overrides.waitForTransactionReceipt ??
        (() => Promise.resolve({ status: 'success' as const })),
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
  }
  return { publicClient, walletClient, orderRemover }
}

// ─── Settler: successful settlement ──────────────────────────────────────────

describe('Settler — successful settlement', () => {
  it('calls verifyAndSettle with correct args and emits settled', async () => {
    const engine = makeEngine()
    const { publicClient, walletClient, orderRemover } = makeMocks()
    const settler = new Settler(engine, CONFIG, publicClient, walletClient, orderRemover)

    const settled: string[] = []
    settler.on('settled', h => settled.push(h))

    const maker = makeOrder('ask1', 'ask')
    const taker = makeOrder('bid1', 'bid')
    engine.emit('matched', maker, taker)

    // Allow the async queue to flush
    await sleep(50)

    // writeContract called once with the right function
    expect(walletClient.writeContract).toHaveBeenCalledOnce()
    const callArgs = (walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArgs.address).toBe(CLOB_ADDRESS)
    expect(callArgs.functionName).toBe('verifyAndSettle')

    // gas = estimatedGas * 1.2
    const estimated = await (publicClient.estimateContractGas as ReturnType<typeof vi.fn>)
      .mock.results[0].value as bigint
    expect(callArgs.gas).toBe((estimated * 120n) / 100n)

    // args[0] = makerOrder (the ask), args[1] = takerOrder (the bid)
    const [makerArg, takerArg] = callArgs.args
    expect(makerArg.maker).toBe(maker.maker)
    expect(takerArg.maker).toBe(taker.maker)
    expect(makerArg.amountIn).toBe(BigInt(maker.amountIn))

    // Both orders removed from the store
    expect(orderRemover.removeOrder).toHaveBeenCalledWith('ask1', 'ask')
    expect(orderRemover.removeOrder).toHaveBeenCalledWith('bid1', 'bid')

    // settled event emitted with tx hash
    expect(settled).toEqual([TX_HASH])
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

    engine.emit('matched', makeOrder('ask-rev', 'ask'), makeOrder('bid-rev', 'bid'))
    await sleep(50)

    // writeContract still called — we submitted the tx
    expect(walletClient.writeContract).toHaveBeenCalledOnce()
    // But orders must NOT be removed
    expect(orderRemover.removeOrder).not.toHaveBeenCalled()
    // And no settled event
    expect(settled).toHaveLength(0)
  })

  it('does not remove orders when writeContract throws', async () => {
    const engine = makeEngine()
    const { publicClient, walletClient, orderRemover } = makeMocks({
      writeContract: () => Promise.reject(new Error('insufficient funds')),
    })
    const settler = new Settler(engine, CONFIG, publicClient, walletClient, orderRemover)

    engine.emit('matched', makeOrder('ask-err', 'ask'), makeOrder('bid-err', 'bid'))
    await sleep(50)

    expect(orderRemover.removeOrder).not.toHaveBeenCalled()
  })

  it('does not remove orders when gas estimation fails after retries', async () => {
    const engine = makeEngine()
    const { publicClient, walletClient, orderRemover } = makeMocks({
      estimateContractGas: () => Promise.reject(new Error('RPC timeout')),
    })
    const settler = new Settler(engine, CONFIG, publicClient, walletClient, orderRemover)

    engine.emit('matched', makeOrder('ask-gas', 'ask'), makeOrder('bid-gas', 'bid'))

    // withRetry retries 3× with exponential backoff; use generous wait
    await sleep(3000)

    expect(walletClient.writeContract).not.toHaveBeenCalled()
    expect(orderRemover.removeOrder).not.toHaveBeenCalled()
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
    engine.emit('matched', makeOrder('a1', 'ask'), makeOrder('b1', 'bid'))
    engine.emit('matched', makeOrder('a2', 'ask'), makeOrder('b2', 'bid'))
    engine.emit('matched', makeOrder('a3', 'ask'), makeOrder('b3', 'bid'))

    // Wait for all three sequential settlements (3 × ~10 ms + overhead)
    await sleep(200)

    expect(callCount).toBe(3)
    expect(maxConcurrent).toBe(1)  // queue serialised — never concurrent

    // All 6 orders (3 pairs) removed from Redis
    expect(orderRemover.removeOrder).toHaveBeenCalledTimes(6)
  })
})

// ─── RedisOrderRemover ────────────────────────────────────────────────────────

describe('RedisOrderRemover', () => {
  it('deletes the order key and removes from the correct sorted set', async () => {
    const redis = {
      del:  vi.fn().mockResolvedValue(1),
      zrem: vi.fn().mockResolvedValue(1),
    }
    const remover = new RedisOrderRemover(redis)

    await remover.removeOrder('order-abc', 'bid')

    expect(redis.del).toHaveBeenCalledWith('orders:order-abc')
    expect(redis.zrem).toHaveBeenCalledWith('orderbook:bids', 'order-abc')
  })

  it('uses orderbook:asks for ask-side orders', async () => {
    const redis = {
      del:  vi.fn().mockResolvedValue(1),
      zrem: vi.fn().mockResolvedValue(1),
    }
    await new RedisOrderRemover(redis).removeOrder('order-xyz', 'ask')

    expect(redis.zrem).toHaveBeenCalledWith('orderbook:asks', 'order-xyz')
  })
})
