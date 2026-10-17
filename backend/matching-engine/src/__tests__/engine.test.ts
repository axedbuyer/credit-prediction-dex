import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { MatchingEngine } from '../engine'
import type { OrderBook, StoredOrder } from '../types'
import type { OrderBookClient } from '../client'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const YES  = '0x0000000000000000000000000000000000000001'
const NO   = '0x0000000000000000000000000000000000000002'
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

const CONFIG = {
  yesTokenAddress: YES,
  noTokenAddress:  NO,
  usdcAddress:     USDC,
  pollIntervalMs:  100,
}

let _idSeq = 0
function resetIds() { _idSeq = 0 }

function makeOrder(overrides: Partial<StoredOrder> & Pick<StoredOrder, 'id' | 'price'>): StoredOrder {
  return {
    maker: '0xmaker',
    tokenIn: USDC,
    tokenOut: YES,
    amountIn: '1000',
    minAmountOut: '1000',
    expiry: String(Math.floor(Date.now() / 1000) + 3600),
    nonce: String(++_idSeq),
    signature: '0xdeadbeef',
    side: 'bid',
    timestamp: Date.now(),
    ...overrides,
  }
}

function yesBid(id: string, price: number, timestamp = Date.now()): StoredOrder {
  return makeOrder({ id, price, timestamp, side: 'bid', tokenIn: USDC, tokenOut: YES })
}

function yesAsk(id: string, price: number, timestamp = Date.now()): StoredOrder {
  return makeOrder({ id, price, timestamp, side: 'ask', tokenIn: YES, tokenOut: USDC })
}

function noBid(id: string, price: number, timestamp = Date.now()): StoredOrder {
  return makeOrder({ id, price, timestamp, side: 'bid', tokenIn: USDC, tokenOut: NO })
}

function noAsk(id: string, price: number, timestamp = Date.now()): StoredOrder {
  return makeOrder({ id, price, timestamp, side: 'ask', tokenIn: NO, tokenOut: USDC })
}

function staticClient(book: OrderBook): OrderBookClient {
  return { fetchOrderBook: async () => book }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

type MatchPair = [maker: StoredOrder, taker: StoredOrder]

function collectMatches(engine: MatchingEngine): MatchPair[] {
  const out: MatchPair[] = []
  engine.on('matched', (maker, taker) => out.push([maker, taker]))
  return out
}

// ─── YES market ───────────────────────────────────────────────────────────────

describe('YES market matching', () => {
  beforeEach(resetIds)

  it('matches a YES buy against a YES sell when bid price ≥ ask price', async () => {
    const ask = yesAsk('ask1', 0.25, 1_000)   // resting first
    const bid = yesBid('bid1', 0.30, 2_000)
    const engine = new MatchingEngine(staticClient({ bids: [bid], asks: [ask] }), CONFIG)

    const matches = collectMatches(engine)
    await engine.runOnce()

    expect(matches).toHaveLength(1)
    const [maker, taker] = matches[0]
    expect(maker.id).toBe('ask1')  // the EARLIER order is the maker (sets the price)
    expect(taker.id).toBe('bid1')  // the later one takes it
  })

  it('does not match when bid price < ask price', async () => {
    const bid = yesBid('bid1', 0.20)
    const ask = yesAsk('ask1', 0.25)
    const engine = new MatchingEngine(staticClient({ bids: [bid], asks: [ask] }), CONFIG)

    const matches = collectMatches(engine)
    await engine.runOnce()

    expect(matches).toHaveLength(0)
  })

  it('produces multiple matches in one poll cycle', async () => {
    const bids = [yesBid('b1', 0.30), yesBid('b2', 0.28)]
    const asks = [yesAsk('a1', 0.25), yesAsk('a2', 0.27)]
    const engine = new MatchingEngine(staticClient({ bids, asks }), CONFIG)

    const matches = collectMatches(engine)
    await engine.runOnce()

    // b1@0.30 matches a1@0.25; b2@0.28 matches a2@0.27
    expect(matches).toHaveLength(2)
  })

  it('does not re-match the same orders on a second runOnce', async () => {
    const bid = yesBid('bid1', 0.30)
    const ask = yesAsk('ask1', 0.25)
    const engine = new MatchingEngine(staticClient({ bids: [bid], asks: [ask] }), CONFIG)

    const matches = collectMatches(engine)
    await engine.runOnce()
    await engine.runOnce()  // same book, orders still present client-side

    expect(matches).toHaveLength(1)  // second cycle skips pending-settlement orders
  })
})

// ─── Price-time priority ──────────────────────────────────────────────────────

describe('price-time priority', () => {
  beforeEach(resetIds)

  it('matches the earlier ask first when two asks have the same price', async () => {
    const now = Date.now()
    const ask1 = yesAsk('ask1', 0.25, now - 2000)  // older
    const ask2 = yesAsk('ask2', 0.25, now - 1000)  // newer
    const bid  = yesBid('bid1', 0.30, now)

    // Deliberately pass asks in reverse arrival order to confirm sorting
    const engine = new MatchingEngine(
      staticClient({ bids: [bid], asks: [ask2, ask1] }),
      CONFIG,
    )

    const matches = collectMatches(engine)
    await engine.runOnce()

    expect(matches).toHaveLength(1)
    expect(matches[0][0].id).toBe('ask1')  // earlier ask wins
  })

  it('matches the earlier bid first when two bids have the same price', async () => {
    const now = Date.now()
    const bid1 = yesBid('bid1', 0.30, now - 2000)  // older
    const bid2 = yesBid('bid2', 0.30, now - 1000)  // newer
    const ask  = yesAsk('ask1', 0.25, now)

    const engine = new MatchingEngine(
      staticClient({ bids: [bid2, bid1], asks: [ask] }),
      CONFIG,
    )

    const matches = collectMatches(engine)
    await engine.runOnce()

    expect(matches).toHaveLength(1)
    // earlier bid wins; it is also older than the ask, so it is the maker here
    expect(matches[0][0].id).toBe('bid1')
    expect(matches[0][1].id).toBe('ask1')
  })

  it('matches best price first when asks have different prices', async () => {
    const now = Date.now()
    const ask1 = yesAsk('ask-cheap', 0.22, now - 1000)  // better price, older
    const ask2 = yesAsk('ask-expensive', 0.28, now)
    const bid  = yesBid('bid1', 0.30, now)

    const engine = new MatchingEngine(
      staticClient({ bids: [bid], asks: [ask2, ask1] }),
      CONFIG,
    )

    const matches = collectMatches(engine)
    await engine.runOnce()

    expect(matches).toHaveLength(1)
    expect(matches[0][0].id).toBe('ask-cheap')  // cheaper ask matched first
  })
})

// ─── NO market ────────────────────────────────────────────────────────────────

describe('NO market matching', () => {
  beforeEach(resetIds)

  it('matches a NO buy against a NO sell at overlapping prices', async () => {
    const bid = noBid('no-bid', 0.70)
    const ask = noAsk('no-ask', 0.65)
    const engine = new MatchingEngine(staticClient({ bids: [bid], asks: [ask] }), CONFIG)

    const matches = collectMatches(engine)
    await engine.runOnce()

    expect(matches).toHaveLength(1)
    expect(matches[0][0].id).toBe('no-ask')
    expect(matches[0][1].id).toBe('no-bid')
  })

  it('does not match NO orders against YES orders', async () => {
    // YES ask should not be matched against a NO bid
    const noBidOrder = noBid('no-bid', 0.70)
    const yesAskOrder = yesAsk('yes-ask', 0.25)
    const engine = new MatchingEngine(
      staticClient({ bids: [noBidOrder], asks: [yesAskOrder] }),
      CONFIG,
    )

    const matches = collectMatches(engine)
    await engine.runOnce()

    expect(matches).toHaveLength(0)
  })

  it('does not match NO orders when bid < ask', async () => {
    const bid = noBid('no-bid', 0.60)
    const ask = noAsk('no-ask', 0.65)
    const engine = new MatchingEngine(staticClient({ bids: [bid], asks: [ask] }), CONFIG)

    const matches = collectMatches(engine)
    await engine.runOnce()

    expect(matches).toHaveLength(0)
  })
})

// ─── Whole-order compatibility (CLOBSettlement has no partial fills) ──────────

// Amounts are 6-decimal base units. A YES ask sells `tokens` for >= `usdc`; a YES
// bid pays `usdc` for >= `tokens`.
function sizedAsk(id: string, tokens: number, usdc: number, timestamp = Date.now()): StoredOrder {
  return makeOrder({
    id, price: usdc / tokens, timestamp, side: 'ask', tokenIn: YES, tokenOut: USDC,
    amountIn: String(tokens * 1e6), minAmountOut: String(Math.round(usdc * 1e6)),
  })
}
function sizedBid(id: string, tokens: number, usdc: number, timestamp = Date.now()): StoredOrder {
  return makeOrder({
    id, price: usdc / tokens, timestamp, side: 'bid', tokenIn: USDC, tokenOut: YES,
    amountIn: String(Math.round(usdc * 1e6)), minAmountOut: String(tokens * 1e6),
  })
}

describe('partial fills (batch 3)', () => {
  beforeEach(resetIds)
  afterEach(() => { vi.useRealTimers() })

  const fills = (ms: Array<[StoredOrder, StoredOrder, bigint]>) => ms.map(([m, t, q]) => [m.id, t.id, q])

  function collectFills(engine: MatchingEngine): Array<[StoredOrder, StoredOrder, bigint]> {
    const out: Array<[StoredOrder, StoredOrder, bigint]> = []
    engine.on('matched', (maker, taker, tokens) => out.push([maker, taker, tokens]))
    return out
  }

  it('a smaller crossing bid fills PART of a resting ask; the ask (older) is the maker', async () => {
    const ask = sizedAsk('ask4', 4, 0.96, 1)   // sells 4 @ 24¢, resting first
    const bid = sizedBid('bid1', 1, 0.24, 2)   // buys 1 @ 24¢
    const engine = new MatchingEngine(staticClient({ bids: [bid], asks: [ask] }), CONFIG)
    const out = collectFills(engine)
    await engine.runOnce()
    expect(fills(out)).toEqual([['ask4', 'bid1', 1_000_000n]])
  })

  it('a larger crossing bid fills the whole smaller ask; the older bid is the maker', async () => {
    const bid = sizedBid('bid4', 4, 0.96, 1)
    const ask = sizedAsk('ask1', 1, 0.24, 2)
    const engine = new MatchingEngine(staticClient({ bids: [bid], asks: [ask] }), CONFIG)
    const out = collectFills(engine)
    await engine.runOnce()
    expect(fills(out)).toEqual([['bid4', 'ask1', 1_000_000n]])
  })

  it('uses remaining size (size − filled), and skips fully filled orders', async () => {
    const ask = { ...sizedAsk('ask4', 4, 0.96, 1), filled: '3000000' }   // 1 left
    const done = { ...sizedAsk('done', 2, 0.40, 1), filled: '2000000' }  // nothing left
    const bid = sizedBid('bid4', 4, 0.96, 2)
    const engine = new MatchingEngine(staticClient({ bids: [bid], asks: [done, ask] }), CONFIG)
    const out = collectFills(engine)
    await engine.runOnce()
    expect(fills(out)).toEqual([['ask4', 'bid4', 1_000_000n]])
  })

  it('one fill per order per cycle: a big bid takes the best ask now, the next ask after the fill is recorded', async () => {
    const a1 = sizedAsk('a1', 1, 0.22, 1)
    const a2 = sizedAsk('a2', 1, 0.23, 2)
    const bid = sizedBid('bid', 2, 0.48, 3)
    const engine = new MatchingEngine(staticClient({ bids: [bid], asks: [a1, a2] }), CONFIG)
    const out = collectFills(engine)
    await engine.runOnce()
    expect(fills(out)).toEqual([['a1', 'bid', 1_000_000n]])
  })

  it('the griefing case is gone: a tiny bid takes only its own size and the rest of the ask stays', async () => {
    const ask = sizedAsk('ask4', 4, 0.96, 1)
    const tiny = sizedBid('tiny', 1, 0.24, 2)
    const engine = new MatchingEngine(staticClient({ bids: [tiny], asks: [ask] }), CONFIG)
    const out = collectFills(engine)
    await engine.runOnce()
    expect(fills(out)).toEqual([['ask4', 'tiny', 1_000_000n]])
  })

  it('markIncompatible: the pair (in either role) is skipped until the TTL lapses', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const ask = sizedAsk('ask', 1, 0.24, 1)
    const bid = sizedBid('bid', 1, 0.24, 2)
    const engine = new MatchingEngine(staticClient({ bids: [bid], asks: [ask] }), CONFIG)
    const out = collectFills(engine)

    engine.markIncompatible('bid', 'ask')   // reversed roles still count
    await engine.runOnce()
    expect(out).toHaveLength(0)

    vi.setSystemTime(1_000_000 + 10 * 60_000 + 1)
    await engine.runOnce()
    expect(out).toHaveLength(1)
  })
})

// ─── start / stop ─────────────────────────────────────────────────────────────

describe('start / stop', () => {
  it('stop() prevents further polling', async () => {
    let calls = 0
    const client: OrderBookClient = {
      fetchOrderBook: async () => { calls++; return { bids: [], asks: [] } },
    }
    const engine = new MatchingEngine(client, { ...CONFIG, pollIntervalMs: 50 })

    engine.start()
    await new Promise(r => setTimeout(r, 80))  // allow ~1 tick
    engine.stop()
    const snapshot = calls
    await new Promise(r => setTimeout(r, 100)) // wait to confirm no more calls
    expect(calls).toBe(snapshot)
  })

  it('stop() resolves immediately when no cycle is in flight', async () => {
    const client: OrderBookClient = { fetchOrderBook: async () => ({ bids: [], asks: [] }) }
    const engine = new MatchingEngine(client, { ...CONFIG, pollIntervalMs: 50 })
    // Never started — no timer, no in-flight cycle.
    await expect(engine.stop()).resolves.toBeUndefined()
  })

  it('stop() waits for an in-flight cycle (triggered by the timer) to finish before resolving', async () => {
    // Deferred fetchOrderBook — the cycle triggered by the interval timer
    // will be sitting inside `await this.client.fetchOrderBook()` when
    // stop() is called, exactly like a settlement whose tx receipt is still
    // pending during a SIGTERM.
    let releaseFetch: (() => void) | undefined
    let fetchStarted = false
    const client: OrderBookClient = {
      fetchOrderBook: () => {
        fetchStarted = true
        return new Promise(resolve => {
          releaseFetch = () => resolve({ bids: [], asks: [] })
        })
      },
    }
    const engine = new MatchingEngine(client, { ...CONFIG, pollIntervalMs: 20 })

    engine.start()
    // Wait for the timer to fire and enter the deferred fetch.
    await new Promise<void>(resolve => {
      const check = () => (fetchStarted ? resolve() : setTimeout(check, 5))
      check()
    })

    let stopped = false
    const stopPromise = engine.stop().then(() => { stopped = true })

    // stop() must NOT resolve while the in-flight cycle is still pending.
    await new Promise(r => setTimeout(r, 50))
    expect(stopped).toBe(false)

    // Release the in-flight cycle — NOW stop() should resolve.
    releaseFetch!()
    await stopPromise
    expect(stopped).toBe(true)
  })
})
