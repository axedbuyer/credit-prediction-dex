import { EventEmitter } from 'events'
import path from 'path'
import fs from 'fs'
import { createPublicClient, createWalletClient, http, BaseError, ContractFunctionRevertedError } from 'viem'
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
] as const

export const CLOB_SETTLEMENT_ABI = [
  {
    name: 'verifyAndSettle',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [
      { name: 'makerOrder', type: 'tuple', components: ORDER_COMPONENTS },
      { name: 'makerSig',   type: 'bytes' },
      { name: 'takerOrder', type: 'tuple', components: ORDER_COMPONENTS },
      { name: 'takerSig',   type: 'bytes' },
    ],
    outputs: [],
  },
  // v1b1: deterministic reverts — including these lets viem decode the
  // revert data into a named error (ContractFunctionRevertedError.data.errorName)
  // instead of an opaque "execution reverted". Both are terminal on retry:
  // the seller's funding debit / the flagged freeze won't clear itself.
  {
    name: 'FundingShortfall',
    type: 'error' as const,
    inputs: [],
  },
  {
    name: 'PositionFrozen',
    type: 'error' as const,
    inputs: [],
  },
] as const

// ─── CreditMarket ABI (minimal — claimable() read only) ──────────────────────

export const CREDIT_MARKET_ABI = [
  {
    name: 'claimable',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
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
  readContract(args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
  }): Promise<unknown>
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
  creditMarketAddress: Address
  // Used to identify the seller-side order in a matched pair (the leg whose
  // tokenIn is YES/NO, not USDC) when a FundingShortfall revert needs pruning.
  usdcAddress: Address
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
    private readonly engine: MatchingEngine,
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
    const makerSig = maker.signature as `0x${string}`
    const takerSig = taker.signature as `0x${string}`
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
          args:         [makerArg, makerSig, takerArg, takerSig],
          account,
        }),
      )
    } catch (err) {
      console.error(`[settler] gas estimation failed maker=${maker.id} taker=${taker.id}:`, err)

      // FundingShortfall / PositionFrozen are deterministic — retrying the same
      // pair will revert identically forever, wedging this price level. Prune
      // the offending order(s) instead of leaving them to be re-matched.
      const revertName = decodeSettlementError(err)
      if (revertName === 'FundingShortfall') {
        await this.handleFundingShortfall(maker, taker)
        return
      }
      if (revertName === 'PositionFrozen') {
        await this.handlePositionFrozen(maker, taker)
        return
      }

      // Not a deterministic revert (e.g. RPC hiccup, OrderExpired, an
      // as-yet-unhandled revert reason) — no tx was ever submitted, so it's
      // safe to release both orders back into pendingSettlement immediately:
      // they stay in the book and are retried on the next poll cycle instead
      // of being wedged forever.
      this.engine.releasePendingSettlement(maker.id, taker.id)
      return
    }

    const gas = (gasEstimate * 120n) / 100n  // +20% buffer

    // ── 2. Submit tx (no retry — avoid double-submit on timeout) ─────────────
    let txHash: Hash
    try {
      txHash = await this.walletClient.writeContract({
        address:      this.config.clobSettlementAddress,
        abi:          CLOB_SETTLEMENT_ABI,
        functionName: 'verifyAndSettle',
        args:         [makerArg, makerSig, takerArg, takerSig],
        gas,
      })
    } catch (err) {
      console.error(`[settler] tx submission failed maker=${maker.id} taker=${taker.id}:`, err)
      // No tx hash was ever obtained — nothing was broadcast (or, in the rare
      // case the response was merely lost, a duplicate resubmission would
      // safely revert on the order's already-consumed nonce/signature).
      // Safe to release for a retry on the next poll cycle.
      this.engine.releasePendingSettlement(maker.id, taker.id)
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
      // Deliberately NOT released: the tx WAS broadcast and its outcome is
      // genuinely unknown (RPC couldn't confirm either way). Releasing here
      // risks a real double-submission racing an in-flight tx. Orders stay
      // wedged out of matching until this is manually investigated — a
      // narrower tradeoff than the plain-revert case below, where the
      // outcome (reverted) is already known for certain.
      return
    }

    if (receipt.status !== 'success') {
      // On-chain revert: do NOT remove orders from the book, but DO release
      // them back into pendingSettlement — this is what lets "next match
      // cycle decide" (below) actually happen. Unlike the gas-estimation
      // failure above, the receipt alone carries no revert reason (viem's
      // waitForTransactionReceipt doesn't decode it), and re-simulating here
      // would race a since-changed chain state (e.g. a nonce already
      // consumed by this same reverted tx would surface as NonceUsed instead
      // of the original cause). Orders are re-matched next cycle, at which
      // point a deterministic revert will re-surface at the gas-estimation
      // step above and be pruned there; anything else falls into the
      // release-and-retry path there too.
      console.error(`[settler] tx reverted ${txHash} maker=${maker.id} taker=${taker.id}`)
      this.engine.releasePendingSettlement(maker.id, taker.id)
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

  // ── FundingShortfall: the seller-side order can never clear at this price —
  // prune only that leg; the other party's order is untouched and can still match.
  private async handleFundingShortfall(maker: StoredOrder, taker: StoredOrder): Promise<void> {
    const sellerOrder = identifySellerOrder(maker, taker, this.config.usdcAddress)
    if (!sellerOrder) {
      // Neither leg's tokenIn is USDC — shouldn't happen for a valid matched
      // pair, but fail safe rather than guess: leave both orders untouched —
      // and release both back into pendingSettlement so they aren't wedged.
      console.error(
        `[settler] FundingShortfall but could not identify seller-side order ` +
        `maker=${maker.id} taker=${taker.id}`,
      )
      this.engine.releasePendingSettlement(maker.id, taker.id)
      return
    }
    console.error(
      `[settler] FundingShortfall — removing seller order ${sellerOrder.id} ` +
      `(maker=${maker.id} taker=${taker.id})`,
    )
    await this.orderRemover.removeOrder(sellerOrder.id, sellerOrder.side)
    // The other (buyer-side) order was untouched — it's still in the book,
    // so release it back into pendingSettlement or it can never match again.
    const otherOrder = sellerOrder.id === maker.id ? taker : maker
    this.engine.releasePendingSettlement(otherOrder.id)
  }

  // ── PositionFrozen: one (or both) makers are flagged claimable — prune the
  // flagged party's order(s). If we can't determine who's flagged, remove both:
  // makers can always resubmit, so over-pruning here is safe.
  private async handlePositionFrozen(maker: StoredOrder, taker: StoredOrder): Promise<void> {
    let makerFlagged: boolean
    let takerFlagged: boolean
    try {
      ;[makerFlagged, takerFlagged] = await Promise.all([
        this.readClaimable(maker.maker as Address),
        this.readClaimable(taker.maker as Address),
      ])
    } catch (err) {
      console.error(
        `[settler] PositionFrozen — claimable() read failed, removing both orders ` +
        `maker=${maker.id} taker=${taker.id}:`, err,
      )
      await this.removeBoth(maker, taker)
      return
    }

    if (!makerFlagged && !takerFlagged) {
      // Read succeeded but neither reports flagged (e.g. cured between the
      // revert and this check) — fall back to removing both.
      console.error(
        `[settler] PositionFrozen but claimable() reports neither party flagged — ` +
        `removing both maker=${maker.id} taker=${taker.id}`,
      )
      await this.removeBoth(maker, taker)
      return
    }

    console.error(
      `[settler] PositionFrozen — maker=${maker.id}(flagged=${makerFlagged}) ` +
      `taker=${taker.id}(flagged=${takerFlagged})`,
    )
    const removals: Array<Promise<void>> = []
    if (makerFlagged) removals.push(this.orderRemover.removeOrder(maker.id, maker.side))
    if (takerFlagged) removals.push(this.orderRemover.removeOrder(taker.id, taker.side))
    await Promise.all(removals)
    // Exactly one side flagged (the !makerFlagged && !takerFlagged case
    // already returned above): the other order is untouched and still in
    // the book — release it back into pendingSettlement so it can match
    // again instead of being wedged.
    if (!makerFlagged) this.engine.releasePendingSettlement(maker.id)
    if (!takerFlagged) this.engine.releasePendingSettlement(taker.id)
  }

  private async readClaimable(user: Address): Promise<boolean> {
    return this.publicClient.readContract({
      address:      this.config.creditMarketAddress,
      abi:          CREDIT_MARKET_ABI,
      functionName: 'claimable',
      args:         [user],
    }) as Promise<boolean>
  }

  private async removeBoth(maker: StoredOrder, taker: StoredOrder): Promise<void> {
    await Promise.all([
      this.orderRemover.removeOrder(maker.id, maker.side),
      this.orderRemover.removeOrder(taker.id, taker.side),
    ])
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type DeterministicRevert = 'FundingShortfall' | 'PositionFrozen'

// Decodes a deterministic, non-retryable custom-error revert out of a thrown
// estimateContractGas error. viem wraps on-chain reverts in a BaseError chain;
// once the ABI passed to the call includes the error definition (see
// CLOB_SETTLEMENT_ABI above), ContractFunctionRevertedError.data.errorName
// carries the decoded name. Anything else (RPC timeout, network error, an
// as-yet-unhandled revert reason) yields undefined and the caller falls back
// to today's leave-orders-in-book behavior.
function decodeSettlementError(err: unknown): DeterministicRevert | undefined {
  if (!(err instanceof BaseError)) return undefined
  const revertError = err.walk(
    e => e instanceof ContractFunctionRevertedError,
  ) as ContractFunctionRevertedError | null
  const errorName = revertError?.data?.errorName
  if (errorName === 'FundingShortfall' || errorName === 'PositionFrozen') return errorName
  return undefined
}

// The seller-side order is whichever leg sends YES/NO tokens in for USDC
// (tokenIn != USDC). Returns undefined if neither leg matches (shouldn't
// happen for a valid matched pair).
function identifySellerOrder(
  maker: StoredOrder,
  taker: StoredOrder,
  usdcAddress: Address,
): StoredOrder | undefined {
  const usdc = usdcAddress.toLowerCase()
  if (maker.tokenIn.toLowerCase() !== usdc) return maker
  if (taker.tokenIn.toLowerCase() !== usdc) return taker
  return undefined
}

function toContractOrder(order: StoredOrder) {
  return {
    maker:        order.maker        as Address,
    tokenIn:      order.tokenIn      as Address,
    tokenOut:     order.tokenOut     as Address,
    amountIn:     BigInt(order.amountIn),
    minAmountOut: BigInt(order.minAmountOut),
    expiry:       BigInt(order.expiry),
    nonce:        BigInt(order.nonce),
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

  // Contract addresses: env vars take precedence; the checked-in deployments
  // JSON is a local-dev fallback only (it does not exist inside containers).
  const deployments = {
    clobSettlement: process.env.CLOB_SETTLEMENT_ADDRESS,
    creditMarket:   process.env.CREDIT_MARKET_ADDRESS,
    usdc:           process.env.USDC_ADDRESS,
  }
  if (!deployments.clobSettlement || !deployments.creditMarket || !deployments.usdc) {
    // Path: src/ → matching-engine/ → backend/ → project root → contracts/deployments/
    const deploymentsPath = path.join(
      __dirname, '..', '..', '..', 'contracts', 'deployments', 'base-sepolia.json',
    )
    let file: { clobSettlement?: string; creditMarket?: string; usdc?: string }
    try {
      file = JSON.parse(fs.readFileSync(deploymentsPath, 'utf8'))
    } catch (err) {
      throw new Error(
        'settler: CLOB_SETTLEMENT_ADDRESS, CREDIT_MARKET_ADDRESS, and USDC_ADDRESS ' +
        `are not all set, and the deployments fallback could not be read at ${deploymentsPath}: ${err}`,
      )
    }
    deployments.clobSettlement ??= file.clobSettlement
    deployments.creditMarket   ??= file.creditMarket
    deployments.usdc           ??= file.usdc
    if (!deployments.clobSettlement || !deployments.creditMarket || !deployments.usdc) {
      throw new Error(`settler: missing contract address(es) in env and ${deploymentsPath}`)
    }
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
    {
      clobSettlementAddress: deployments.clobSettlement as Address,
      creditMarketAddress:   deployments.creditMarket   as Address,
      usdcAddress:           deployments.usdc            as Address,
    },
    publicClient as IPublicClient,
    walletClient as unknown as IWalletClient,
    new RedisOrderRemover(redis),
  )
}

export { Settler }
