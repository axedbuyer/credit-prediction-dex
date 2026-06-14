import { EventEmitter } from 'events'
import type { StoredOrder, OrderBook, MatchingEngineConfig } from './types'
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
      this.runOnce().catch(() => { /* swallow transient fetch errors */ })
    }, this.config.pollIntervalMs ?? 500)
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /**
   * Execute one poll-and-match cycle.
   * Exposed as public so tests can drive the engine deterministically
   * without relying on real timers.
   */
  async runOnce(): Promise<void> {
    const book = await this.client.fetchOrderBook()
    this.matchBook(book)
  }

  private matchBook(book: OrderBook): void {
    const yes = this.config.yesTokenAddress.toLowerCase()
    const no  = this.config.noTokenAddress.toLowerCase()

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
   * Walk both sorted lists with two pointers. While best_bid.price >= best_ask.price
   * the spread is crossed and we have a match. Execution price = ask.price
   * (ask is the maker whose limit is honoured; bid is the taker).
   *
   * Matched IDs are added to pendingSettlement so they are not re-matched
   * before Task 12 removes them from the book.
   */
  private matchMarket(bids: StoredOrder[], asks: StoredOrder[]): void {
    const activeBids = bids
      .filter(o => !this.pendingSettlement.has(o.id))
      .sort((a, b) => b.price - a.price || a.timestamp - b.timestamp)

    const activeAsks = asks
      .filter(o => !this.pendingSettlement.has(o.id))
      .sort((a, b) => a.price - b.price || a.timestamp - b.timestamp)

    let bi = 0
    let ai = 0

    while (bi < activeBids.length && ai < activeAsks.length) {
      const bid = activeBids[bi]
      const ask = activeAsks[ai]

      if (bid.price < ask.price) break  // spread not crossed — no further matches possible

      this.pendingSettlement.add(bid.id)
      this.pendingSettlement.add(ask.id)
      this.emit('matched', ask, bid)    // ask = maker (limit), bid = taker

      bi++
      ai++
    }
  }
}

export { MatchingEngine }
