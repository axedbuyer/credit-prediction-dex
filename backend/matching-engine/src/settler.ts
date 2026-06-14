import { EventEmitter } from 'events'
import path from 'path'
import fs from 'fs'
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import type { Address, Hash } from 'viem'
import type { StoredOrder } from './types'
import type { MatchingEngine } from './engine'

// ─── CLOBSettlement ABI (minimal — verifyAndSettle only) ─────────────────────

const ORDER_COMPONENTS = [
  { name: 'maker',        type: 'address' },
  { name: 'tokenIn',      type: 'address' },
  { name: 'tokenOut',     type: 'address' },
  { name: 'amountIn',     type: 'uint256' },
  { name: 'minAmountOut', type: 'uint256' },
  { name: 'expiry',       type: 'uint256' },
  { name: 'nonce',        type: 'uint256' },
  { name: 'signature',    type: 'bytes'   },
] as const

export const CLOB_SETTLEMENT_ABI = [
  {
    name: 'verifyAndSettle',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [
      { name: 'makerOrder', type: 'tuple', components: ORDER_COMPONENTS },
      { name: 'takerOrder', type: 'tuple', components: ORDER_COMPONENTS },
    ],
    outputs: [],
  },
] as const

// ─── Narrow client interfaces (real viem clients satisfy these) ───────────────

export interface IPublicClient {
  estimateContractGas(args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
    account: Address
  }): Promise<bigint>
  waitForTransactionReceipt(args: {
    hash: Hash
  }): Promise<{ status: 'success' | 'reverted' }>
}

export interface IWalletClient {
  writeContract(args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
    gas: bigint
  }): Promise<Hash>
  account: { address: Address } | undefined
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface SettlerConfig {
  clobSettlementAddress: Address
}

export interface OrderRemover {
  removeOrder(orderId: string, side: 'bid' | 'ask'): Promise<void>
}

// ─── NonceQueue: serialises concurrent settlements to prevent nonce conflicts ─

export class NonceQueue {
  private running = false
  private readonly pending: Array<() => Promise<void>> = []

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push(async () => {
        try {
          resolve(await task())
        } catch (err) {
          reject(err)
        }
      })
      this.drain()
    })
  }

  private drain(): void {
    if (this.running || this.pending.length === 0) return
    this.running = true
    const next = this.pending.shift()!
    next().finally(() => {
      this.running = false
      this.drain()
    })
  }
}

// ─── Settler ──────────────────────────────────────────────────────────────────

declare interface Settler {
  on(event: 'settled', listener: (txHash: Hash) => void): this
  on(event: string | symbol, listener: (...args: unknown[]) => void): this
  emit(event: 'settled', txHash: Hash): boolean
  emit(event: string | symbol, ...args: unknown[]): boolean
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
class Settler extends EventEmitter {
  private readonly nonceQueue = new NonceQueue()

  constructor(
    engine: MatchingEngine,
    private readonly config: SettlerConfig,
    private readonly publicClient: IPublicClient,
    private readonly walletClient: IWalletClient,
    private readonly orderRemover: OrderRemover,
  ) {
    super()
    engine.on('matched', (maker, taker) => {
      // All settlements are serialised through the nonce queue —
      // only one writeContract call is in-flight at any time.
      this.nonceQueue.enqueue(() => this.settle(maker, taker)).catch(err => {
        console.error('[settler] unexpected queue error:', err)
      })
    })
  }

  private async settle(maker: StoredOrder, taker: StoredOrder): Promise<void> {
    const makerArg = toContractOrder(maker)
    const takerArg = toContractOrder(taker)
    const account  = this.walletClient.account?.address
    if (!account) throw new Error('wallet client has no account')

    // ── 1. Estimate gas (read-only → safe to retry on RPC timeout) ───────────
    let gasEstimate: bigint
    try {
      gasEstimate = await withRetry(() =>
        this.publicClient.estimateContractGas({
          address:      this.config.clobSettlementAddress,
          abi:          CLOB_SETTLEMENT_ABI,
          functionName: 'verifyAndSettle',
          args:         [makerArg, takerArg],
          account,
        }),
      )
    } catch (err) {
      console.error(`[settler] gas estimation failed maker=${maker.id} taker=${taker.id}:`, err)
      return  // orders stay in book; matching engine will skip them (pendingSettlement)
    }

    const gas = (gasEstimate * 120n) / 100n  // +20% buffer

    // ── 2. Submit tx (no retry — avoid double-submit on timeout) ─────────────
    let txHash: Hash
    try {
      txHash = await this.walletClient.writeContract({
        address:      this.config.clobSettlementAddress,
        abi:          CLOB_SETTLEMENT_ABI,
        functionName: 'verifyAndSettle',
        args:         [makerArg, takerArg],
        gas,
      })
    } catch (err) {
      console.error(`[settler] tx submission failed maker=${maker.id} taker=${taker.id}:`, err)
      return
    }

    console.log(`[settler] submitted ${txHash} maker=${maker.id} taker=${taker.id}`)

    // ── 3. Wait for receipt (read-only → safe to retry on RPC timeout) ───────
    let receipt: { status: 'success' | 'reverted' }
    try {
      receipt = await withRetry(() =>
        this.publicClient.waitForTransactionReceipt({ hash: txHash }),
      )
    } catch (err) {
      console.error(`[settler] receipt wait failed ${txHash}:`, err)
      return
    }

    if (receipt.status !== 'success') {
      // On-chain revert: do NOT remove orders — let next match cycle decide
      console.error(`[settler] tx reverted ${txHash} maker=${maker.id} taker=${taker.id}`)
      return
    }

    // ── 4. Remove both orders from the order book store ───────────────────────
    await Promise.all([
      this.orderRemover.removeOrder(maker.id, maker.side),
      this.orderRemover.removeOrder(taker.id, taker.side),
    ])

    console.log(`[settler] settled ${txHash}`)
    this.emit('settled', txHash)
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toContractOrder(order: StoredOrder) {
  return {
    maker:        order.maker        as Address,
    tokenIn:      order.tokenIn      as Address,
    tokenOut:     order.tokenOut     as Address,
    amountIn:     BigInt(order.amountIn),
    minAmountOut: BigInt(order.minAmountOut),
    expiry:       BigInt(order.expiry),
    nonce:        BigInt(order.nonce),
    signature:    order.signature    as `0x${string}`,
  } as const
}

async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 3,
  baseDelayMs = 500,
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < maxAttempts; i++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (i < maxAttempts - 1) await sleep(baseDelayMs * 2 ** i)
    }
  }
  throw lastErr
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// ─── Redis-backed OrderRemover (production) ───────────────────────────────────

interface MinimalRedis {
  del(...keys: string[]): Promise<unknown>
  zrem(key: string, ...members: string[]): Promise<unknown>
}

export class RedisOrderRemover implements OrderRemover {
  constructor(private readonly redis: MinimalRedis) {}

  async removeOrder(orderId: string, side: 'bid' | 'ask'): Promise<void> {
    const sortedSet = side === 'bid' ? 'orderbook:bids' : 'orderbook:asks'
    await Promise.all([
      this.redis.del(`orders:${orderId}`),
      this.redis.zrem(sortedSet, orderId),
    ])
  }
}

// ─── Production factory ───────────────────────────────────────────────────────

export function createSettler(engine: MatchingEngine): Settler {
  const privateKey = process.env.SETTLER_PRIVATE_KEY
  if (!privateKey) throw new Error('SETTLER_PRIVATE_KEY env var is required')

  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL
  if (!rpcUrl) throw new Error('BASE_SEPOLIA_RPC_URL env var is required')

  // Path: src/ → matching-engine/ → backend/ → project root → contracts/deployments/
  const deploymentsPath = path.join(
    __dirname, '..', '..', '..', 'contracts', 'deployments', 'base-sepolia.json',
  )
  const deployments = JSON.parse(fs.readFileSync(deploymentsPath, 'utf8')) as {
    clobSettlement: string
  }

  const account = privateKeyToAccount(privateKey as `0x${string}`)
  const transport = http(rpcUrl)

  const publicClient = createPublicClient({ chain: baseSepolia, transport })
  const walletClient = createWalletClient({ account, chain: baseSepolia, transport })

  const Redis = require('ioredis') as typeof import('ioredis').default
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? 'localhost',
    port: parseInt(process.env.REDIS_PORT ?? '6379'),
  })

  return new Settler(
    engine,
    { clobSettlementAddress: deployments.clobSettlement as Address },
    publicClient as IPublicClient,
    walletClient as unknown as IWalletClient,
    new RedisOrderRemover(redis),
  )
}

export { Settler }
