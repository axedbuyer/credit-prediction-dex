import { describe, it, expect, beforeEach, afterEach } from 'vitest'
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
    const bid = yesBid('bid1', 0.30)
    const ask = yesAsk('ask1', 0.25)
    const engine = new MatchingEngine(staticClient({ bids: [bid], asks: [ask] }), CONFIG)

    const matches = collectMatches(engine)
    await engine.runOnce()

    expect(matches).toHaveLength(1)
    const [maker, taker] = matches[0]
    expect(maker.id).toBe('ask1')  // ask = maker (sets the limit price)
    expect(taker.id).toBe('bid1')  // bid = taker  (fills at ask price)
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
    expect(matches[0][1].id).toBe('bid1')  // earlier bid wins (taker slot)
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
})
