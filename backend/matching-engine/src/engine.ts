import { EventEmitter } from 'events'
import type { StoredOrder, OrderBook, MatchingEngineConfig } from './types'
import { LEGACY_MARKET_SLUG, orderMarketSlug } from './types'
import type { OrderBookClient } from './client'

// Declaration merging gives MatchingEngine typed event signatures without
// losing the full EventEmitter interface inherited from the class side.
declare interface MatchingEngine {
  on(event: 'matched', listener: (maker: StoredOrder, taker: StoredOrder) => void): this
  on(event: string | symbol, listener: (...args: unknown[]) => void): this
  emit(event: 'matched', maker: StoredOrder, taker: StoredOrder): boolean
  emit(event: string | symbol, ...args: unknown[]): boolean
}

// eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging
class MatchingEngine extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null

  /**
   * Order IDs that have been matched and emitted but whose on-chain settlement
   * has not yet confirmed. The engine skips these on subsequent poll cycles to
   * avoid duplicate matches. Task 12 (on-chain settler) is responsible for
   * deleting the orders from the book once settlement confirms.
   */
  private readonly pendingSettlement = new Set<string>()

  /** Pairs (`makerId|takerId`) that reverted SlippageExceeded → time marked. See markIncompatible. */
  private readonly incompatible = new Map<string, number>()

  /**
   * Number of runOnce() cycles currently in flight (fired by the interval
   * timer, not a direct test call to runOnce()). Tracked so stop() can await
   * any cycle that was already running at the moment it was called instead of
   * cutting it off mid-match — graceful shutdown must let matchBook() finish
   * emitting 'matched' for the current book before the process exits.
   */
  private activeCycles = 0

  /** Health tracking (see health.ts): last completed runOnce() sweep, per-market. */
  private lastCycleAtMs: number | null = null
  private readonly marketHealth = new Map<string, { lastCycleAt: number | null; lastError: string | null }>()

  /** Time of the last completed runOnce() sweep (even if a market's fetch failed). */
  getLastCycleAt(): number | null { return this.lastCycleAtMs }

  getMarketHealth(): Record<string, { lastCycleAt: number | null; lastError: string | null }> {
    return Object.fromEntries([...this.marketHealth].map(([k, v]) => [k, { ...v }]))
  }
  private idleWaiters: Array<() => void> = []

  /**
   * Release order IDs from the pending-settlement set so they become
   * matchable again on the next poll cycle. Called by the settler when a
   * settlement attempt ends WITHOUT the order being removed from the book
   * (i.e. every failure path that isn't a deterministic prune) — otherwise
   * the order is wedged in pendingSettlement forever with no way back in,
   * even though it's still sitting in the book and is (by design) meant to
   * be retried. See backend/matching-engine/CLAUDE.md or root CLAUDE.md
   * "other reverts keep the retry behavior" for the intended semantics.
   */
  releasePendingSettlement(...orderIds: string[]): void {
    for (const id of orderIds) this.pendingSettlement.delete(id)
  }

  constructor(
    private readonly client: OrderBookClient,
    private readonly config: MatchingEngineConfig,
  ) {
    super()
  }

  /** Begin polling the order book at the configured interval. */
  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      this.activeCycles++
      this.runOnce()
        .catch(() => { /* swallow transient fetch errors */ })
        .finally(() => {
          this.activeCycles--
          if (this.activeCycles === 0) {
            const waiters = this.idleWaiters
            this.idleWaiters = []
            for (const resolve of waiters) resolve()
          }
        })
    }, this.config.pollIntervalMs ?? 500)
  }

  /**
   * Stop polling and wait for any cycle that was already in flight to finish.
   * Clears the interval FIRST (so no new cycle starts), then resolves once
   * every currently-running runOnce() has settled — including the synchronous
   * matchBook()/emit('matched', ...) it performs, which is what hands
   * settlements off to the settler's queue (see Settler.whenIdle() for
   * draining that separate queue). Used by graceful shutdown.
   */
  async stop(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    if (this.activeCycles === 0) return
    await new Promise<void>(resolve => this.idleWaiters.push(resolve))
  }

  /**
   * Execute one poll-and-match cycle.
   * Exposed as public so tests can drive the engine deterministically
   * without relying on real timers.
   */
  async runOnce(): Promise<void> {
    // Each active market's book is fetched and matched independently — orders
    // from different markets are never crossed. One market's fetch failure must
    // not starve the others; the first error is rethrown after the sweep.
    let firstErr: unknown
    for (const m of this.activeMarkets()) {
      const h = this.marketHealth.get(m.slug) ?? { lastCycleAt: null, lastError: null }
      try {
        const book = await this.client.fetchOrderBook(m.slug)
        this.matchBook(m, book)
        h.lastCycleAt = Date.now()
        h.lastError = null
      } catch (err) {
        firstErr ??= err
        h.lastError = err instanceof Error ? err.message : String(err)
      }
      this.marketHealth.set(m.slug, h)
    }
    this.lastCycleAtMs = Date.now()
    if (firstErr !== undefined) throw firstErr
  }

  private activeMarkets(): Array<{ slug: string; yes: string; no: string }> {
    const dir = this.config.directory
    if (dir) {
      return dir.list({ activeOnly: true }).map(m => ({ slug: m.slug, yes: m.yesToken, no: m.noToken }))
    }
    // Legacy: exactly one market from the single-set config.
    return [{ slug: LEGACY_MARKET_SLUG, yes: this.config.yesTokenAddress, no: this.config.noTokenAddress }]
  }

  private matchBook(market: { slug: string; yes: string; no: string }, rawBook: OrderBook): void {
    const yes = market.yes.toLowerCase()
    const no  = market.no.toLowerCase()
    // Belt-and-braces: an order stamped with a different market never enters
    // this market's matching (an old server that ignores ?market= would
    // otherwise hand every market the same book).
    const mine = (o: StoredOrder) => orderMarketSlug(o) === market.slug
    const book: OrderBook = { bids: rawBook.bids.filter(mine), asks: rawBook.asks.filter(mine) }

    // Separate YES and NO markets by inspecting tokenIn/tokenOut on each order.
    // bids: tokenIn=USDC, tokenOut=<token>
    // asks: tokenIn=<token>, tokenOut=USDC
    this.matchMarket(
      book.bids.filter(o => o.tokenOut.toLowerCase() === yes),
      book.asks.filter(o => o.tokenIn.toLowerCase() === yes),
    )
    this.matchMarket(
      book.bids.filter(o => o.tokenOut.toLowerCase() === no),
      book.asks.filter(o => o.tokenIn.toLowerCase() === no),
    )
  }

  /**
   * Price-time priority matching for a single token-pair market.
   *
   * Sort order:
   *   bids — highest price first; equal prices: earliest timestamp first
   *   asks — lowest price first;  equal prices: earliest timestamp first
   *
   * Each bid, best first, takes the best still-unmatched ask that it crosses
   * (bid.price >= ask.price) AND that can settle with it as whole orders
   * (canSettleWhole). CLOBSettlement has no partial fills, so a crossing pair of
   * different sizes would only revert SlippageExceeded on-chain — it is skipped
   * and both orders keep resting; neither did anything wrong. A bid whose price is
   * below the best open ask ends the walk (no lower bid can cross either).
   * Execution: ask = maker (limit), bid = taker.
   *
   * Matched IDs are added to pendingSettlement so they are not re-matched
   * before the settler removes them from the book.
   */
  private matchMarket(bids: StoredOrder[], asks: StoredOrder[]): void {
    const activeBids = bids
      .filter(o => !this.pendingSettlement.has(o.id))
      .sort((a, b) => b.price - a.price || a.timestamp - b.timestamp)

    const openAsks = asks
      .filter(o => !this.pendingSettlement.has(o.id))
      .sort((a, b) => a.price - b.price || a.timestamp - b.timestamp)

    for (const bid of activeBids) {
      if (openAsks.length === 0 || bid.price < openAsks[0].price) break

      const i = openAsks.findIndex(ask =>
        bid.price >= ask.price && canSettleWhole(ask, bid) && !this.isIncompatible(ask.id, bid.id))
      if (i < 0) continue

      const [ask] = openAsks.splice(i, 1)
      this.pendingSettlement.add(bid.id)
      this.pendingSettlement.add(ask.id)
      this.emit('matched', ask, bid)    // ask = maker (limit), bid = taker
    }
  }

  /**
   * Remember that this exact pair reverted SlippageExceeded at gas estimation
   * even though it passed canSettleWhole — on a NO sale the fee-free seller's
   * limit is checked NET of the buyer-paid fee, which this engine doesn't model.
   * Amounts are static, so the pair would revert again; skip it (both orders keep
   * resting and can match anyone else). Entries expire after INCOMPATIBLE_TTL_MS
   * so a fee-config change gets a fresh try.
   */
  markIncompatible(makerId: string, takerId: string): void {
    const now = Date.now()
    for (const [k, t] of this.incompatible) if (now - t > INCOMPATIBLE_TTL_MS) this.incompatible.delete(k)
    this.incompatible.set(`${makerId}|${takerId}`, now)
  }

  private isIncompatible(makerId: string, takerId: string): boolean {
    const t = this.incompatible.get(`${makerId}|${takerId}`)
    return t !== undefined && Date.now() - t <= INCOMPATIBLE_TTL_MS
  }
}

const INCOMPATIBLE_TTL_MS = 10 * 60_000

/**
 * Mirrors CLOBSettlement.verifyAndSettle's whole-order slippage guards: the
 * seller's tokens must cover what the buyer asked for, and the buyer's USDC must
 * cover what the seller asked for. (The contract checks these maker/taker-wise;
 * with one seller and one buyer that is the same pair of conditions.) Settlement
 * moves the seller's FULL amountIn and the buyer's FULL amountIn, so a crossing
 * pair of different sizes fails one of these and can never settle.
 */
function canSettleWhole(ask: StoredOrder, bid: StoredOrder): boolean {
  try {
    return BigInt(ask.amountIn) >= BigInt(bid.minAmountOut)
        && BigInt(bid.amountIn) >= BigInt(ask.minAmountOut)
  } catch {
    return false  // malformed amounts can't settle either
  }
}

export { MatchingEngine }
