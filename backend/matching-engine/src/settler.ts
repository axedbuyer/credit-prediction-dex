import { EventEmitter } from 'events'
import { createPublicClient, createWalletClient, defineChain, http, BaseError, ContractFunctionRevertedError } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import type { Address, Hash } from 'viem'
import type { StoredOrder } from './types'
import type { MatchingEngine } from './engine'
import type { MarketDirectory, MarketInfo } from './registry'
import { orderMarketSlug } from './types'

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
  // Order amounts are static, so a SlippageExceeded pair reverts identically
  // forever too. It only arises when the server's FEE_BPS disagrees with
  // CLOBSettlement.feeBps (a NO bid priced gross crosses, but the fee-free
  // seller's net check fails on-chain) — prune rather than wedge the level.
  {
    name: 'SlippageExceeded',
    type: 'error' as const,
    inputs: [],
  },
  // A prior verifyAndSettle call for one (or both) of these makers' nonces
  // already landed on-chain — most commonly a duplicate resubmission of a
  // pair whose original tx was broadcast, then confirmed, just before/while
  // this process was killed and restarted (the in-memory pendingSettlement
  // set doesn't survive a restart, so the same resting orders get re-matched
  // and re-submitted). Deterministic forever for this exact pair — prune
  // rather than wedge the level.
  {
    name: 'NonceUsed',
    type: 'error' as const,
    inputs: [],
  },
  {
    name: 'usedNonces',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'maker', type: 'address' }, { name: 'nonce', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
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
  // Used to identify the seller-side order in a matched pair (the leg whose
  // tokenIn is YES/NO, not USDC) when a FundingShortfall revert needs pruning,
  // and by the pre-submit token validation.
  usdcAddress: Address
  // Source of per-market CLOBSettlement / CreditMarket / YES / NO addresses.
  // One settler wallet serves every market; each pair is submitted to the CLOB
  // of the market both of its orders belong to.
  directory: MarketDirectory
}

export interface OrderRemover {
  // `market` = slug of the book the order rests in (namespaced Redis keys).
  removeOrder(orderId: string, side: 'bid' | 'ask', market: string): Promise<void>
}

// ─── NonceQueue: serialises concurrent settlements to prevent nonce conflicts ─

export class NonceQueue {
  private running = false
  private readonly pending: Array<() => Promise<void>> = []

  // Count of tasks enqueued but not yet settled (queued + currently running).
  // Used by idle() to let graceful shutdown wait for the queue to fully drain
  // (submitted tx receipt + Redis cleanup included) without polling.
  private active = 0
  private idleWaiters: Array<() => void> = []

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    this.active++
    return new Promise<T>((resolve, reject) => {
      this.pending.push(async () => {
        try {
          resolve(await task())
        } catch (err) {
          reject(err)
        } finally {
          this.active--
          if (this.active === 0) {
            const waiters = this.idleWaiters
            this.idleWaiters = []
            for (const w of waiters) w()
          }
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

  /**
   * Resolves once every task enqueued so far (including the one currently
   * running) has settled. Does NOT block new enqueues from extending the
   * wait — a task enqueued after idle() is called but before it resolves is
   * still awaited, since `active` only reaches 0 when nothing is left.
   */
  idle(): Promise<void> {
    if (this.active === 0) return Promise.resolve()
    return new Promise(resolve => this.idleWaiters.push(resolve))
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

  // Describes whichever settlement is currently executing (gas estimate → tx
  // submit → receipt wait → Redis cleanup), for graceful-shutdown timeout
  // logging only — NOT used for any settlement/matching decision. The queue
  // serialises settlements one at a time, so at most one of these is ever set.
  private currentSettlement: { makerId: string; takerId: string; txHash?: Hash } | null = null

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
    this.currentSettlement = { makerId: maker.id, takerId: taker.id }
    try {
      const market = await this.validatePair(maker, taker)
      if (market) await this.settleInner(maker, taker, market)
    } finally {
      this.currentSettlement = null
    }
  }

  // ── Defense in depth for the CLOBSettlement token-validation gap ──────────
  // CLOBSettlement does not itself check that an order's tokens belong to its
  // market, so before spending gas we re-verify that BOTH orders are exactly
  // {USDC, this market's YES or NO}, are on opposite sides of the SAME outcome
  // token, and that both belong to the same market. Anything else is pruned
  // WITHOUT submitting (loud log). Returns the market to settle on, or null if
  // the pair was dropped/released here.
  private async validatePair(maker: StoredOrder, taker: StoredOrder): Promise<MarketInfo | null> {
    const makerSlug = orderMarketSlug(maker)
    const takerSlug = orderMarketSlug(taker)
    const market = this.config.directory.bySlug(makerSlug)
    if (!market) {
      // Our directory doesn't know this market (stale registry read). Don't
      // prune — the orders are fine, we just can't route them yet.
      console.error(
        `[settler] unknown market "${makerSlug}" for maker=${maker.id} — not submitting, releasing both`,
      )
      this.engine.releasePendingSettlement(maker.id, taker.id)
      return null
    }
    const problem = pairProblem(maker, taker, makerSlug, takerSlug, market, this.config.usdcAddress)
    if (problem) {
      console.error(
        `[settler] REFUSING to submit mismatched pair (${problem}) maker=${maker.id}[${makerSlug}] ` +
        `taker=${taker.id}[${takerSlug}] market=${market.slug} — pruning both orders`,
      )
      await this.removeBoth(maker, taker)
      return null
    }
    if (!market.active) {
      // Market was deactivated after the orders matched — keep them resting.
      console.error(`[settler] market ${market.slug} inactive — not submitting maker=${maker.id} taker=${taker.id}`)
      this.engine.releasePendingSettlement(maker.id, taker.id)
      return null
    }
    return market
  }

  private async settleInner(maker: StoredOrder, taker: StoredOrder, market: MarketInfo): Promise<void> {
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
          address:      market.clobSettlement,
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
        await this.handlePositionFrozen(maker, taker, market)
        return
      }
      if (revertName === 'SlippageExceeded') {
        // Deterministic for this pair (amounts are static; almost certainly a
        // FEE_BPS ↔ on-chain feeBps mismatch). Either order might still match
        // a different counterparty, but we can't tell which leg is "at fault"
        // without re-deriving fee math here — remove both; makers can resubmit.
        console.error(
          `[settler] SlippageExceeded (fee-config mismatch?) — removing both ` +
          `maker=${maker.id} taker=${taker.id}`,
        )
        await this.removeBoth(maker, taker)
        return
      }
      if (revertName === 'NonceUsed') {
        await this.handleNonceUsed(maker, taker, market)
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
        address:      market.clobSettlement,
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
    if (this.currentSettlement) this.currentSettlement.txHash = txHash

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
    await this.removeBoth(maker, taker)

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
    await this.orderRemover.removeOrder(sellerOrder.id, sellerOrder.side, orderMarketSlug(sellerOrder))
    // The other (buyer-side) order was untouched — it's still in the book,
    // so release it back into pendingSettlement or it can never match again.
    const otherOrder = sellerOrder.id === maker.id ? taker : maker
    this.engine.releasePendingSettlement(otherOrder.id)
  }

  // ── PositionFrozen: one (or both) makers are flagged claimable — prune the
  // flagged party's order(s). If we can't determine who's flagged, remove both:
  // makers can always resubmit, so over-pruning here is safe.
  private async handlePositionFrozen(maker: StoredOrder, taker: StoredOrder, market: MarketInfo): Promise<void> {
    let makerFlagged: boolean
    let takerFlagged: boolean
    try {
      ;[makerFlagged, takerFlagged] = await Promise.all([
        this.readClaimable(market, maker.maker as Address),
        this.readClaimable(market, taker.maker as Address),
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
    if (makerFlagged) removals.push(this.orderRemover.removeOrder(maker.id, maker.side, orderMarketSlug(maker)))
    if (takerFlagged) removals.push(this.orderRemover.removeOrder(taker.id, taker.side, orderMarketSlug(taker)))
    await Promise.all(removals)
    // Exactly one side flagged (the !makerFlagged && !takerFlagged case
    // already returned above): the other order is untouched and still in
    // the book — release it back into pendingSettlement so it can match
    // again instead of being wedged.
    if (!makerFlagged) this.engine.releasePendingSettlement(maker.id)
    if (!takerFlagged) this.engine.releasePendingSettlement(taker.id)
  }

  // ── NonceUsed: one (or both) orders' nonces already landed on-chain —
  // almost always a duplicate resubmission after a restart (the in-memory
  // pendingSettlement set doesn't survive a kill, so filled-but-not-yet-
  // cleaned-up orders get re-matched). Such an order can never fill, so it
  // must be pruned or it wedges the book forever. The revert carries no args,
  // so read usedNonces for both and prune ONLY the spent one(s): removing an
  // innocent counterparty's valid resting order would let anyone knock orders
  // off the book by crossing them with a spent-nonce order. If the read fails
  // or shows neither spent, fall back to removing both (over-pruning is safe).
  private async handleNonceUsed(maker: StoredOrder, taker: StoredOrder, market: MarketInfo): Promise<void> {
    let makerSpent: boolean
    let takerSpent: boolean
    try {
      ;[makerSpent, takerSpent] = await Promise.all([
        this.readUsedNonce(market, maker),
        this.readUsedNonce(market, taker),
      ])
    } catch (err) {
      console.error(
        `[settler] NonceUsed — usedNonces() read failed, removing both orders ` +
        `maker=${maker.id} taker=${taker.id}:`, err,
      )
      await this.removeBoth(maker, taker)
      return
    }

    if (!makerSpent && !takerSpent) {
      console.error(
        `[settler] NonceUsed but usedNonces() reports neither nonce spent — ` +
        `removing both maker=${maker.id} taker=${taker.id}`,
      )
      await this.removeBoth(maker, taker)
      return
    }

    console.error(
      `[settler] NonceUsed — maker=${maker.id}(spent=${makerSpent}) ` +
      `taker=${taker.id}(spent=${takerSpent})`,
    )
    const removals: Array<Promise<void>> = []
    if (makerSpent) removals.push(this.orderRemover.removeOrder(maker.id, maker.side, orderMarketSlug(maker)))
    if (takerSpent) removals.push(this.orderRemover.removeOrder(taker.id, taker.side, orderMarketSlug(taker)))
    await Promise.all(removals)
    if (!makerSpent) this.engine.releasePendingSettlement(maker.id)
    if (!takerSpent) this.engine.releasePendingSettlement(taker.id)
  }

  private async readUsedNonce(market: MarketInfo, order: StoredOrder): Promise<boolean> {
    return this.publicClient.readContract({
      address:      market.clobSettlement,
      abi:          CLOB_SETTLEMENT_ABI,
      functionName: 'usedNonces',
      args:         [order.maker as Address, BigInt(order.nonce)],
    }) as Promise<boolean>
  }

  private async readClaimable(market: MarketInfo, user: Address): Promise<boolean> {
    return this.publicClient.readContract({
      address:      market.creditMarket,
      abi:          CREDIT_MARKET_ABI,
      functionName: 'claimable',
      args:         [user],
    }) as Promise<boolean>
  }

  /**
   * Resolves once any settlement(s) currently queued or executing (gas
   * estimate → tx submit → receipt wait → Redis cleanup) have finished. Used
   * by graceful shutdown to drain in-flight work before the process exits.
   */
  whenIdle(): Promise<void> {
    return this.nonceQueue.idle()
  }

  /**
   * Human-readable description of whichever settlement is currently in
   * flight, or null if idle. Includes the tx hash once known. For graceful-
   * shutdown timeout logging only.
   */
  describePending(): string | null {
    if (!this.currentSettlement) return null
    const { makerId, takerId, txHash } = this.currentSettlement
    return `maker=${makerId} taker=${takerId}` + (txHash ? ` tx=${txHash}` : ' (tx not yet submitted)')
  }

  private async removeBoth(maker: StoredOrder, taker: StoredOrder): Promise<void> {
    await Promise.all([
      this.orderRemover.removeOrder(maker.id, maker.side, orderMarketSlug(maker)),
      this.orderRemover.removeOrder(taker.id, taker.side, orderMarketSlug(taker)),
    ])
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type DeterministicRevert = 'FundingShortfall' | 'PositionFrozen' | 'SlippageExceeded' | 'NonceUsed'

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
  if (
    errorName === 'FundingShortfall' ||
    errorName === 'PositionFrozen' ||
    errorName === 'SlippageExceeded' ||
    errorName === 'NonceUsed'
  ) return errorName
  return undefined
}

// Returns a human-readable reason if the pair must NOT be submitted, else null.
// Valid = same market slug on both orders, each order is exactly one USDC leg +
// that market's YES or NO, both on the SAME outcome token, opposite directions.
function pairProblem(
  maker: StoredOrder,
  taker: StoredOrder,
  makerSlug: string,
  takerSlug: string,
  market: MarketInfo,
  usdcAddress: string,
): string | null {
  if (makerSlug !== takerSlug) return `orders belong to different markets`
  const usdc = usdcAddress.toLowerCase()
  const yes = market.yesToken.toLowerCase()
  const no = market.noToken.toLowerCase()
  const outcomeOf = (o: StoredOrder): string | null => {
    const tin = o.tokenIn.toLowerCase()
    const tout = o.tokenOut.toLowerCase()
    const tok = tin === usdc ? tout : tout === usdc ? tin : null
    if (tok === null || tok === usdc) return null
    return tok === yes || tok === no ? tok : null
  }
  const mo = outcomeOf(maker)
  const to = outcomeOf(taker)
  if (mo === null) return `maker order tokens are not {USDC, ${market.slug} YES/NO}`
  if (to === null) return `taker order tokens are not {USDC, ${market.slug} YES/NO}`
  if (mo !== to) return `orders trade different outcome tokens`
  const makerBuys = maker.tokenIn.toLowerCase() === usdc
  const takerBuys = taker.tokenIn.toLowerCase() === usdc
  if (makerBuys === takerBuys) return `orders are on the same side`
  return null
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

  async removeOrder(orderId: string, side: 'bid' | 'ask', market: string): Promise<void> {
    // Namespaced per market; keys mirror order-book-server's bidsKey/asksKey.
    const sortedSet = `orderbook:${market}:${side === 'bid' ? 'bids' : 'asks'}`
    await Promise.all([
      this.redis.del(`orders:${orderId}`),
      this.redis.zrem(sortedSet, orderId),
    ])
  }
}

// ─── Production factory ───────────────────────────────────────────────────────

// A settler plus the underlying Redis connection it uses for order cleanup —
// callers (main.ts) need the latter to quit() it cleanly on graceful shutdown
// instead of letting the process exit yank the connection out from under any
// in-flight command.
export interface CreatedSettler {
  settler: Settler
  redis: { quit(): Promise<unknown> }
}

export function createSettler(engine: MatchingEngine, directory: MarketDirectory, usdcAddress: Address): CreatedSettler {
  const privateKey = process.env.SETTLER_PRIVATE_KEY
  if (!privateKey) throw new Error('SETTLER_PRIVATE_KEY env var is required')

  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL
  if (!rpcUrl) throw new Error('BASE_SEPOLIA_RPC_URL env var is required')

  const account = privateKeyToAccount(privateKey as `0x${string}`)
  const transport = http(rpcUrl)

  // CHAIN_ID env override lets a local anvil node (31337) work; default Base Sepolia.
  const chainId = parseInt(process.env.CHAIN_ID ?? String(baseSepolia.id))
  const chain = chainId === baseSepolia.id
    ? baseSepolia
    : defineChain({
        id: chainId,
        name: 'Local',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      })
  const publicClient = createPublicClient({ chain, transport })
  const walletClient = createWalletClient({ account, chain, transport })

  const Redis = require('ioredis') as typeof import('ioredis').default
  // REDIS_URL (redis://:password@host:port) takes precedence — managed Redis
  // (e.g. Railway) requires auth that bare host/port can't carry.
  const redis = process.env.REDIS_URL
    ? new Redis(process.env.REDIS_URL)
    : new Redis({
        host: process.env.REDIS_HOST ?? 'localhost',
        port: parseInt(process.env.REDIS_PORT ?? '6379'),
      })

  const settler = new Settler(
    engine,
    { usdcAddress, directory },
    publicClient as IPublicClient,
    walletClient as unknown as IWalletClient,
    new RedisOrderRemover(redis),
  )

  return { settler, redis }
}

export { Settler }
