import { describe, it, expect, beforeEach } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { recoverTypedDataAddress } from 'viem'
import type { Address, Hex } from 'viem'
import { ClobYesSeller } from '../clob-seller'

// ─── Fixtures ───────────────────────────────────────────────────────────────

const ACCOUNT = privateKeyToAccount(
  '0x32ad6637e18e3a9447244a671093800c27446a006985b21ae35f62d495b85fb8' as Hex,
)
const CHAIN_ID = 84532
const CLOB_SETTLEMENT = '0x77955F13DA6187a0F626443E5f548B2957e2bFDf' as Address
const YES = '0x1753cE2553986bB4eB3CbED17bF481aA30a775c9' as Address
const USDC = '0xACE84a190cbA6759615352B2f5944aEecbEC2Eb9' as Address
const OTHER_MAKER = '0xf231473b62b207940C32ED868EADAD44c1da3123' as Address

const WAD = 10n ** 18n
const MARK_23PCT = 230_000_000_000_000_000n // 0.23 * 1e18

const ORDER_TYPES = {
  Order: [
    { name: 'maker', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

const CANCEL_TYPES = {
  CancelOrder: [{ name: 'orderId', type: 'string' }],
} as const

function domain() {
  return { name: 'CLOBSettlement', version: '1', chainId: CHAIN_ID, verifyingContract: CLOB_SETTLEMENT } as const
}

interface StoredOrderFixture {
  id: string
  maker: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  minAmountOut: string
  expiry: string
  nonce: string
  signature: string
  side: 'bid' | 'ask'
  price: number
  timestamp: number
}

// Comfortably beyond STALE_EXPIRY_BUFFER_SEC (1h) so fixtures aren't
// accidentally right on the "expiring soon" boundary.
function futureExpiry(secs = 86_400): string {
  return String(Math.floor(Date.now() / 1000) + secs)
}

function fixture(overrides: Partial<StoredOrderFixture>): StoredOrderFixture {
  return {
    id: 'fixture-id',
    maker: OTHER_MAKER,
    tokenIn: USDC,
    tokenOut: YES,
    amountIn: '0',
    minAmountOut: '0',
    expiry: futureExpiry(),
    nonce: '1',
    signature: '0xdead' as string,
    side: 'bid',
    price: 0,
    timestamp: Date.now(),
    ...overrides,
  }
}

// YES bid: buying YES with USDC. price = amountIn/minAmountOut (per-YES, WAD).
function yesBid(qtyYes6: bigint, priceWad: bigint, overrides: Partial<StoredOrderFixture> = {}): StoredOrderFixture {
  const amountIn = mulFloor(qtyYes6, priceWad)
  return fixture({ tokenIn: USDC, tokenOut: YES, amountIn: amountIn.toString(), minAmountOut: qtyYes6.toString(), side: 'bid', ...overrides })
}

// Own resting YES ask.
function yesAsk(qtyYes6: bigint, priceWad: bigint, overrides: Partial<StoredOrderFixture> = {}): StoredOrderFixture {
  const minOut = mulFloor(qtyYes6, priceWad)
  return fixture({
    maker: ACCOUNT.address,
    tokenIn: YES,
    tokenOut: USDC,
    amountIn: qtyYes6.toString(),
    minAmountOut: minOut.toString(),
    side: 'ask',
    ...overrides,
  })
}

function mulFloor(amount: bigint, priceWad: bigint): bigint {
  return (amount * priceWad) / WAD
}

// ─── Fake fetch ─────────────────────────────────────────────────────────────

interface FakeResponse {
  status: number
  body?: unknown
  throws?: Error
}

class FakeFetch {
  calls: Array<{ url: string; init?: RequestInit }> = []
  orderbook: { bids: StoredOrderFixture[]; asks: StoredOrderFixture[] } = { bids: [], asks: [] }
  postQueue: FakeResponse[] = []
  deleteResponse: FakeResponse = { status: 200, body: { cancelled: true } }
  orderbookThrows: Error | null = null

  fetch = (async (url: string, init?: RequestInit) => {
    this.calls.push({ url, init })
    const method = init?.method ?? 'GET'

    if (url.endsWith('/orderbook') && method === 'GET') {
      if (this.orderbookThrows) throw this.orderbookThrows
      return makeResponse({ status: 200, body: this.orderbook })
    }
    if (url.endsWith('/order') && method === 'POST') {
      const next = this.postQueue.shift() ?? { status: 201, body: { orderId: 'default-order-id' } }
      if (next.throws) throw next.throws
      return makeResponse(next)
    }
    if (url.includes('/order/') && method === 'DELETE') {
      if (this.deleteResponse.throws) throw this.deleteResponse.throws
      return makeResponse(this.deleteResponse)
    }
    throw new Error(`FakeFetch: unhandled request ${method} ${url}`)
  }) as unknown as typeof fetch

  get postedOrders(): Array<Record<string, string>> {
    return this.calls
      .filter(c => c.url.endsWith('/order') && c.init?.method === 'POST')
      .map(c => JSON.parse(c.init!.body as string))
  }

  get deleteCalls(): Array<{ url: string; headers: Record<string, string> }> {
    return this.calls
      .filter(c => c.url.includes('/order/') && c.init?.method === 'DELETE')
      .map(c => ({ url: c.url, headers: c.init!.headers as Record<string, string> }))
  }
}

function makeResponse(r: FakeResponse): Response {
  return {
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    json: async () => r.body ?? {},
  } as Response
}

function makeSeller(fake: FakeFetch, overrides: Partial<ConstructorParameters<typeof ClobYesSeller>[0]> = {}) {
  return new ClobYesSeller({
    orderBookUrl: 'http://order-book.test',
    chainId: CHAIN_ID,
    clobSettlementAddress: CLOB_SETTLEMENT,
    yesTokenAddress: YES,
    usdcAddress: USDC,
    account: ACCOUNT,
    fetchImpl: fake.fetch,
    ...overrides,
  })
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('ClobYesSeller', () => {
  let fake: FakeFetch

  beforeEach(() => {
    fake = new FakeFetch()
  })

  it('crosses at the best bid when it is >= floor', async () => {
    // floor = 0.23 * 0.97 = 0.2231; bid at 0.25 clears it.
    fake.orderbook.bids = [yesBid(5_000_000n, 250_000_000_000_000_000n)]
    const seller = makeSeller(fake)

    const res = await seller.sell({ yesAmount: 5_000_000n, markWad: MARK_23PCT })

    expect(res.action).toBe('crossed')
    expect(res.priceWad).toBe(250_000_000_000_000_000n)
    expect(res.amount).toBe(5_000_000n)
    const posted = fake.postedOrders
    expect(posted).toHaveLength(1)
    expect(posted[0]!.tokenIn).toBe(YES)
    expect(posted[0]!.tokenOut).toBe(USDC)
    expect(posted[0]!.amountIn).toBe('5000000')
    expect(BigInt(posted[0]!.minAmountOut)).toBe(mulFloor(5_000_000n, 250_000_000_000_000_000n))
  })

  it('rests at the mark when the best bid is below the floor', async () => {
    // floor = 0.2231; bid at 0.20 is below it.
    fake.orderbook.bids = [yesBid(5_000_000n, 200_000_000_000_000_000n)]
    const seller = makeSeller(fake)

    const res = await seller.sell({ yesAmount: 5_000_000n, markWad: MARK_23PCT })

    expect(res.action).toBe('rested')
    expect(res.priceWad).toBe(MARK_23PCT)
    const posted = fake.postedOrders
    expect(BigInt(posted[0]!.minAmountOut)).toBe(mulFloor(5_000_000n, MARK_23PCT))
  })

  it('rests at the mark when there are no bids at all', async () => {
    fake.orderbook.bids = []
    const seller = makeSeller(fake)

    const res = await seller.sell({ yesAmount: 5_000_000n, markWad: MARK_23PCT })

    expect(res.action).toBe('rested')
    expect(res.priceWad).toBe(MARK_23PCT)
  })

  it('ignores bids for NO / other tokens and expired bids when finding the best YES bid', async () => {
    const NO = '0xfcEa6BB577E3ae2099F4FAFF798eEb669FE0c2e8' as Address
    fake.orderbook.bids = [
      fixture({ tokenIn: USDC, tokenOut: NO, amountIn: '900000000000000000', minAmountOut: '1000000' }), // NO bid — ignored
      yesBid(5_000_000n, 900_000_000_000_000_000n, { expiry: String(Math.floor(Date.now() / 1000) - 10) }), // expired
      yesBid(5_000_000n, 250_000_000_000_000_000n), // the real best YES bid
    ]
    const seller = makeSeller(fake)

    const res = await seller.sell({ yesAmount: 5_000_000n, markWad: MARK_23PCT })

    expect(res.action).toBe('crossed')
    expect(res.priceWad).toBe(250_000_000_000_000_000n)
  })

  it('returns unchanged when an existing own ask already covers the amount at the target price', async () => {
    fake.orderbook.bids = [] // rests at mark
    fake.orderbook.asks = [yesAsk(5_000_000n, MARK_23PCT)]
    const seller = makeSeller(fake)

    const res = await seller.sell({ yesAmount: 5_000_000n, markWad: MARK_23PCT })

    expect(res).toEqual({ action: 'unchanged', amount: 5_000_000n, priceWad: MARK_23PCT })
    expect(fake.postedOrders).toHaveLength(0)
    expect(fake.deleteCalls).toHaveLength(0)
  })

  it('cancels a stale own ask (wrong price) and replaces it, signing a valid cancel', async () => {
    fake.orderbook.bids = [] // target = rest at mark
    fake.orderbook.asks = [yesAsk(5_000_000n, 999_000_000_000_000_000n, { id: 'stale-ask-1' })]
    fake.deleteResponse = { status: 200, body: { cancelled: true } }
    const seller = makeSeller(fake)

    const res = await seller.sell({ yesAmount: 5_000_000n, markWad: MARK_23PCT })

    expect(res.action).toBe('rested')
    expect(fake.deleteCalls).toHaveLength(1)
    expect(fake.deleteCalls[0]!.url).toContain('/order/stale-ask-1')
    const headers = fake.deleteCalls[0]!.headers
    expect(headers['X-Maker']).toBe(ACCOUNT.address)

    const recovered = await recoverTypedDataAddress({
      domain: domain(),
      types: CANCEL_TYPES,
      primaryType: 'CancelOrder',
      message: { orderId: 'stale-ask-1' },
      signature: headers['X-Signature'] as Hex,
    })
    expect(recovered.toLowerCase()).toBe(ACCOUNT.address.toLowerCase())

    expect(fake.postedOrders).toHaveLength(1)
  })

  it('cancels a stale own ask (amount mismatch) and replaces it', async () => {
    fake.orderbook.bids = []
    fake.orderbook.asks = [yesAsk(3_000_000n, MARK_23PCT, { id: 'partial-ask' })] // covers less than yesAmount
    const seller = makeSeller(fake)

    const res = await seller.sell({ yesAmount: 5_000_000n, markWad: MARK_23PCT })

    expect(res.action).toBe('rested')
    expect(fake.deleteCalls).toHaveLength(1)
    expect(fake.deleteCalls[0]!.url).toContain('/order/partial-ask')
    expect(fake.postedOrders).toHaveLength(1)
  })

  it('treats an own ask expiring within ~1h as stale even if amount/price match', async () => {
    fake.orderbook.bids = []
    const soon = String(Math.floor(Date.now() / 1000) + 60) // expires in 1 minute
    fake.orderbook.asks = [yesAsk(5_000_000n, MARK_23PCT, { id: 'expiring-soon', expiry: soon })]
    const seller = makeSeller(fake)

    const res = await seller.sell({ yesAmount: 5_000_000n, markWad: MARK_23PCT })

    expect(res.action).toBe('rested')
    expect(fake.deleteCalls).toHaveLength(1)
  })

  it('does not post a replacement if cancelling a stale ask fails', async () => {
    fake.orderbook.bids = []
    fake.orderbook.asks = [yesAsk(5_000_000n, 1n, { id: 'stuck-ask' })]
    fake.deleteResponse = { status: 500, body: { error: 'boom' } }
    const seller = makeSeller(fake)

    const res = await seller.sell({ yesAmount: 5_000_000n, markWad: MARK_23PCT })

    expect(res.action).toBe('skipped')
    expect(res.reason).toContain('stuck-ask')
    expect(fake.postedOrders).toHaveLength(0)
  })

  it('returns skipped for a zero amount without touching the network', async () => {
    const seller = makeSeller(fake)
    const res = await seller.sell({ yesAmount: 0n, markWad: MARK_23PCT })
    expect(res).toEqual({ action: 'skipped', reason: 'no YES balance to sell' })
    expect(fake.calls).toHaveLength(0)
  })

  it('returns skipped for an invalid (zero) mark', async () => {
    const seller = makeSeller(fake)
    const res = await seller.sell({ yesAmount: 5_000_000n, markWad: 0n })
    expect(res.action).toBe('skipped')
    expect(fake.calls).toHaveLength(0)
  })

  describe('FundingShortfall', () => {
    it('re-prices at minSellProceeds and retries when the repriced price is >= floor', async () => {
      fake.orderbook.bids = []
      const minSellProceeds = mulFloor(5_000_000n, 250_000_000_000_000_000n) // implies 0.25, >= floor 0.2231
      fake.postQueue = [
        { status: 400, body: { error: 'FundingShortfall', minSellProceeds: minSellProceeds.toString() } },
        { status: 201, body: { orderId: 'reprice-order-id' } },
      ]
      const seller = makeSeller(fake)

      const res = await seller.sell({ yesAmount: 5_000_000n, markWad: MARK_23PCT })

      expect(res.action).toBe('rested')
      expect(res.orderId).toBe('reprice-order-id')
      expect(res.priceWad).toBe(250_000_000_000_000_000n)
      expect(fake.postedOrders).toHaveLength(2)
      expect(fake.postedOrders[1]!.minAmountOut).toBe(minSellProceeds.toString())
    })

    it('skips when minSellProceeds implies a price below the floor', async () => {
      fake.orderbook.bids = []
      const minSellProceeds = mulFloor(5_000_000n, 100_000_000_000_000_000n) // implies 0.10, < floor 0.2231
      fake.postQueue = [
        { status: 400, body: { error: 'FundingShortfall', minSellProceeds: minSellProceeds.toString() } },
      ]
      const seller = makeSeller(fake)

      const res = await seller.sell({ yesAmount: 5_000_000n, markWad: MARK_23PCT })

      expect(res.action).toBe('skipped')
      expect(res.reason).toMatch(/FundingShortfall/)
      expect(fake.postedOrders).toHaveLength(1) // no retry attempted
    })

    it('skips when the server returns FundingShortfall without minSellProceeds', async () => {
      fake.orderbook.bids = []
      fake.postQueue = [{ status: 400, body: { error: 'FundingShortfall' } }]
      const seller = makeSeller(fake)

      const res = await seller.sell({ yesAmount: 5_000_000n, markWad: MARK_23PCT })

      expect(res.action).toBe('skipped')
      expect(res.reason).toMatch(/FundingShortfall/)
    })
  })

  it('skips (without throwing) on PositionFrozen', async () => {
    fake.orderbook.bids = []
    fake.postQueue = [{ status: 400, body: { error: 'PositionFrozen' } }]
    const seller = makeSeller(fake)

    const res = await seller.sell({ yesAmount: 5_000_000n, markWad: MARK_23PCT })

    expect(res).toEqual({ action: 'skipped', reason: 'PositionFrozen' })
  })

  it('skips (without throwing) on a 429', async () => {
    fake.orderbook.bids = []
    fake.postQueue = [{ status: 429, body: { error: 'Too many requests — retry in 5s' } }]
    const seller = makeSeller(fake)

    const res = await seller.sell({ yesAmount: 5_000_000n, markWad: MARK_23PCT })

    expect(res.action).toBe('skipped')
    expect(res.reason).toMatch(/429/)
  })

  it('skips (without throwing) on a network error posting the order', async () => {
    fake.orderbook.bids = []
    fake.postQueue = [{ status: 0, throws: new Error('ECONNRESET') }]
    const seller = makeSeller(fake)

    const res = await seller.sell({ yesAmount: 5_000_000n, markWad: MARK_23PCT })

    expect(res.action).toBe('skipped')
    expect(res.reason).toMatch(/ECONNRESET/)
  })

  it('skips (without throwing) when the order book itself is unreachable', async () => {
    fake.orderbookThrows = new Error('network down')
    const seller = makeSeller(fake)

    const res = await seller.sell({ yesAmount: 5_000_000n, markWad: MARK_23PCT })

    expect(res).toEqual({ action: 'skipped', reason: 'order book unreachable' })
  })

  it('never throws even if fetchImpl throws synchronously', async () => {
    const seller = makeSeller(fake, {
      fetchImpl: (() => {
        throw new Error('totally broken')
      }) as unknown as typeof fetch,
    })

    await expect(seller.sell({ yesAmount: 5_000_000n, markWad: MARK_23PCT })).resolves.toMatchObject({
      action: 'skipped',
    })
  })

  it('computes the correct minAmountOut for a 6-decimal amount at a 23% mark', async () => {
    fake.orderbook.bids = []
    const seller = makeSeller(fake)
    // 12.5 YES (6-dec) at 23% mark: 12_500_000 * 0.23 = 2_875_000 USDC (6-dec)
    const yesAmount = 12_500_000n
    const res = await seller.sell({ yesAmount, markWad: MARK_23PCT })

    expect(res.action).toBe('rested')
    const posted = fake.postedOrders[0]!
    expect(posted.amountIn).toBe('12500000')
    expect(posted.minAmountOut).toBe('2875000')
    expect(BigInt(posted.minAmountOut)).toBe((yesAmount * MARK_23PCT) / WAD)
  })

  it('signs the order with the configured chainId + CLOB address, and it recovers to the account', async () => {
    fake.orderbook.bids = []
    const seller = makeSeller(fake)
    await seller.sell({ yesAmount: 5_000_000n, markWad: MARK_23PCT })

    const posted = fake.postedOrders[0]!
    expect(posted.maker.toLowerCase()).toBe(ACCOUNT.address.toLowerCase())
    expect(posted.tokenIn.toLowerCase()).toBe(YES.toLowerCase())
    expect(posted.tokenOut.toLowerCase()).toBe(USDC.toLowerCase())

    const recovered = await recoverTypedDataAddress({
      domain: domain(),
      types: ORDER_TYPES,
      primaryType: 'Order',
      message: {
        maker: posted.maker as Address,
        tokenIn: posted.tokenIn as Address,
        tokenOut: posted.tokenOut as Address,
        amountIn: BigInt(posted.amountIn),
        minAmountOut: BigInt(posted.minAmountOut),
        expiry: BigInt(posted.expiry),
        nonce: BigInt(posted.nonce),
      },
      signature: posted.signature as Hex,
    })
    expect(recovered.toLowerCase()).toBe(ACCOUNT.address.toLowerCase())
  })

  it('a signature signed for a different chainId does NOT recover correctly against our domain (sanity check)', async () => {
    fake.orderbook.bids = []
    const seller = makeSeller(fake, { chainId: 1 }) // sign against chainId 1
    await seller.sell({ yesAmount: 5_000_000n, markWad: MARK_23PCT })
    const posted = fake.postedOrders[0]!

    const recoveredWrongDomain = await recoverTypedDataAddress({
      domain: domain(), // CHAIN_ID = 84532, mismatched
      types: ORDER_TYPES,
      primaryType: 'Order',
      message: {
        maker: posted.maker as Address,
        tokenIn: posted.tokenIn as Address,
        tokenOut: posted.tokenOut as Address,
        amountIn: BigInt(posted.amountIn),
        minAmountOut: BigInt(posted.minAmountOut),
        expiry: BigInt(posted.expiry),
        nonce: BigInt(posted.nonce),
      },
      signature: posted.signature as Hex,
    })
    expect(recoveredWrongDomain.toLowerCase()).not.toBe(ACCOUNT.address.toLowerCase())
  })
})
