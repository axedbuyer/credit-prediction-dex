import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import type { Address } from 'viem'
import { buildApp } from '../server'
import { MemoryOrderStore } from '../orderbook'
import { ORDER_TYPES } from '../validation'
import type { AppConfig, OrderWire } from '../types'
import type { IChainReader } from '../chain'

// ─── Test fixtures ────────────────────────────────────────────────────────────

// Anvil/Foundry deterministic test key #0
const MAKER_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
// Anvil/Foundry deterministic test key #1 (used to produce wrong-signer signatures)
const OTHER_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'

const MAKER = privateKeyToAccount(MAKER_KEY)
const OTHER = privateKeyToAccount(OTHER_KEY)

const MOCK_USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
const MOCK_YES  = '0x0000000000000000000000000000000000000001'
const MOCK_NO   = '0x0000000000000000000000000000000000000002'
const MOCK_CLOB = '0x0000000000000000000000000000000000000003' as Address
const CHAIN_ID  = 84532

const TEST_CONFIG: AppConfig = {
  usdcAddress: MOCK_USDC,
  yesTokenAddress: MOCK_YES,
  noTokenAddress: MOCK_NO,
  clobSettlementAddress: MOCK_CLOB,
  chainId: CHAIN_ID,
}

function eip712Domain() {
  return {
    name: 'CLOBSettlement',
    version: '1',
    chainId: CHAIN_ID,
    verifyingContract: MOCK_CLOB,
  } as const
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function futureExpiry(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) + 3600)
}

function pastExpiry(): bigint {
  return BigInt(Math.floor(Date.now() / 1000) - 60)
}

interface OrderParams {
  maker?: Address
  tokenIn?: Address
  tokenOut?: Address
  amountIn?: bigint
  minAmountOut?: bigint
  expiry?: bigint
  nonce?: bigint
}

async function signOrder(
  signer: typeof MAKER,
  params: Required<OrderParams>,
): Promise<`0x${string}`> {
  return signer.signTypedData({
    domain: eip712Domain(),
    types: ORDER_TYPES,
    primaryType: 'Order',
    message: params,
  })
}

async function buildOrderWire(
  signer: typeof MAKER,
  params: OrderParams = {},
  nonce: bigint = BigInt(1),
): Promise<OrderWire> {
  const full = {
    maker: params.maker ?? MAKER.address,
    tokenIn: params.tokenIn ?? (MOCK_USDC as Address),
    tokenOut: params.tokenOut ?? (MOCK_YES as Address),
    amountIn: params.amountIn ?? BigInt(230),
    minAmountOut: params.minAmountOut ?? BigInt(1000),
    expiry: params.expiry ?? futureExpiry(),
    nonce: params.nonce ?? nonce,
  }
  const sig = await signOrder(signer, full)
  return {
    maker: full.maker,
    tokenIn: full.tokenIn,
    tokenOut: full.tokenOut,
    amountIn: full.amountIn.toString(),
    minAmountOut: full.minAmountOut.toString(),
    expiry: full.expiry.toString(),
    nonce: full.nonce.toString(),
    signature: sig,
  }
}

// ─── Mock IChainReader (v1b1 pre-filter tests) ────────────────────────────────

interface MockChainReaderOpts {
  claimable?: boolean
  yesBalance?: bigint
  previewDelta?: bigint   // noCredit − yesOwed
  fundingDebt?: bigint
  throwOn?: 'isClaimable' | 'previewFunding' | 'fundingDebt' | 'yesBalanceOf'
}

function mockChainReader(opts: MockChainReaderOpts = {}): IChainReader {
  const {
    claimable = false,
    yesBalance = BigInt(0),
    previewDelta = BigInt(0),
    fundingDebt = BigInt(0),
    throwOn,
  } = opts

  return {
    isClaimable: vi.fn(async () => {
      if (throwOn === 'isClaimable') throw new Error('RPC down')
      return claimable
    }),
    previewFunding: vi.fn(async () => {
      if (throwOn === 'previewFunding') throw new Error('RPC down')
      return previewDelta
    }),
    fundingDebt: vi.fn(async () => {
      if (throwOn === 'fundingDebt') throw new Error('RPC down')
      return fundingDebt
    }),
    yesBalanceOf: vi.fn(async () => {
      if (throwOn === 'yesBalanceOf') throw new Error('RPC down')
      return yesBalance
    }),
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /order', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let store: MemoryOrderStore

  beforeEach(async () => {
    store = new MemoryOrderStore()
    app = await buildApp(store, TEST_CONFIG)
  })

  afterEach(async () => {
    await app.close()
  })

  it('accepts a valid order and stores it', async () => {
    const wire = await buildOrderWire(MAKER, {}, BigInt(1))

    const res = await app.inject({ method: 'POST', url: '/order', body: wire })

    expect(res.statusCode).toBe(201)
    const { orderId } = res.json<{ orderId: string }>()
    expect(typeof orderId).toBe('string')
    expect(orderId.length).toBeGreaterThan(0)

    const stored = await store.getOrder(orderId)
    expect(stored).not.toBeNull()
    expect(stored?.maker).toBe(MAKER.address)
    expect(stored?.side).toBe('bid')   // tokenIn = USDC → buying
    expect(stored?.price).toBeGreaterThan(0)
  })

  it('rejects an order signed by a different key than the maker', async () => {
    // Wire claims maker = MAKER.address but is signed by OTHER
    const full = {
      maker: MAKER.address,           // claimed maker
      tokenIn: MOCK_USDC as Address,
      tokenOut: MOCK_YES as Address,
      amountIn: BigInt(230),
      minAmountOut: BigInt(1000),
      expiry: futureExpiry(),
      nonce: BigInt(2),
    }
    const wrongSig = await signOrder(OTHER, full)  // signed by different key

    const wire: OrderWire = {
      ...full,
      amountIn: full.amountIn.toString(),
      minAmountOut: full.minAmountOut.toString(),
      expiry: full.expiry.toString(),
      nonce: full.nonce.toString(),
      signature: wrongSig,
    }

    const res = await app.inject({ method: 'POST', url: '/order', body: wire })

    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toBe('Invalid signature')
  })

  it('rejects an expired order', async () => {
    const wire = await buildOrderWire(MAKER, { expiry: pastExpiry() }, BigInt(3))

    const res = await app.inject({ method: 'POST', url: '/order', body: wire })

    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toBe('Order expired')
  })

  it('rejects a duplicate nonce from the same maker', async () => {
    const wire = await buildOrderWire(MAKER, {}, BigInt(42))
    await app.inject({ method: 'POST', url: '/order', body: wire })

    // Submit exact same nonce again (different signature but same nonce)
    const wire2 = await buildOrderWire(MAKER, { amountIn: BigInt(300) }, BigInt(42))
    // nonce 42 is already marked used; reuse even with fresh sig is rejected
    const res = await app.inject({ method: 'POST', url: '/order', body: wire2 })

    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toBe('Nonce already used')
  })
})

describe('POST /order — v1b1 chain pre-filter', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let store: MemoryOrderStore

  beforeEach(() => {
    store = new MemoryOrderStore()
  })

  afterEach(async () => {
    await app.close()
  })

  it('rejects a bid (buy) order from a flagged/frozen maker', async () => {
    const reader = mockChainReader({ claimable: true })
    app = await buildApp(store, TEST_CONFIG, reader)

    const wire = await buildOrderWire(MAKER, {}, BigInt(100))  // default: USDC in → bid
    const res = await app.inject({ method: 'POST', url: '/order', body: wire })

    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toBe('PositionFrozen')
  })

  it('rejects an ask (sell) order from a flagged/frozen maker', async () => {
    const reader = mockChainReader({ claimable: true })
    app = await buildApp(store, TEST_CONFIG, reader)

    const wire = await buildOrderWire(
      MAKER,
      { tokenIn: MOCK_YES as Address, tokenOut: MOCK_USDC as Address, amountIn: BigInt(100), minAmountOut: BigInt(40) },
      BigInt(101),
    )
    const res = await app.inject({ method: 'POST', url: '/order', body: wire })

    expect(res.statusCode).toBe(400)
    expect(res.json<{ error: string }>().error).toBe('PositionFrozen')
  })

  it('rejects a YES sell whose minAmountOut is below the seller net funding debit', async () => {
    // fundingDebt=50, previewDelta=-30 (i.e. yesOwed=30 net of noCredit) → D = 50 - (-30) = 80
    const reader = mockChainReader({ fundingDebt: BigInt(50), previewDelta: BigInt(-30) })
    app = await buildApp(store, TEST_CONFIG, reader)

    const wire = await buildOrderWire(
      MAKER,
      { tokenIn: MOCK_YES as Address, tokenOut: MOCK_USDC as Address, amountIn: BigInt(100), minAmountOut: BigInt(79) },
      BigInt(102),
    )
    const res = await app.inject({ method: 'POST', url: '/order', body: wire })

    expect(res.statusCode).toBe(400)
    const body = res.json<{ error: string; minSellProceeds: string }>()
    expect(body.error).toBe('FundingShortfall')
    expect(body.minSellProceeds).toBe('80')
  })

  it('accepts a YES sell whose minAmountOut covers the net funding debit', async () => {
    const reader = mockChainReader({ fundingDebt: BigInt(50), previewDelta: BigInt(-30) })  // D = 80
    app = await buildApp(store, TEST_CONFIG, reader)

    const wire = await buildOrderWire(
      MAKER,
      { tokenIn: MOCK_YES as Address, tokenOut: MOCK_USDC as Address, amountIn: BigInt(100), minAmountOut: BigInt(80) },
      BigInt(103),
    )
    const res = await app.inject({ method: 'POST', url: '/order', body: wire })

    expect(res.statusCode).toBe(201)
  })

  it('accepts a NO sell even with an outstanding funding debit (debit never blocks NO sales)', async () => {
    const reader = mockChainReader({ fundingDebt: BigInt(999), previewDelta: BigInt(-999) })
    app = await buildApp(store, TEST_CONFIG, reader)

    const wire = await buildOrderWire(
      MAKER,
      { tokenIn: MOCK_NO as Address, tokenOut: MOCK_USDC as Address, amountIn: BigInt(100), minAmountOut: BigInt(1) },
      BigInt(104),
    )
    const res = await app.inject({ method: 'POST', url: '/order', body: wire })

    expect(res.statusCode).toBe(201)
  })

  it('never runs the funding pre-filter on a bid (buy) order', async () => {
    const reader = mockChainReader({ fundingDebt: BigInt(999), previewDelta: BigInt(-999) })
    app = await buildApp(store, TEST_CONFIG, reader)

    const wire = await buildOrderWire(MAKER, {}, BigInt(105))  // default: USDC in → bid
    const res = await app.inject({ method: 'POST', url: '/order', body: wire })

    expect(res.statusCode).toBe(201)
    expect(reader.previewFunding).not.toHaveBeenCalled()
    expect(reader.fundingDebt).not.toHaveBeenCalled()
  })

  it('fails open (accepts the order) when the chain reader throws', async () => {
    const reader = mockChainReader({ throwOn: 'isClaimable' })
    app = await buildApp(store, TEST_CONFIG, reader)

    const wire = await buildOrderWire(MAKER, {}, BigInt(106))
    const res = await app.inject({ method: 'POST', url: '/order', body: wire })

    expect(res.statusCode).toBe(201)
  })

  it('fails open (accepts the order) when previewFunding throws on a YES sell', async () => {
    const reader = mockChainReader({ throwOn: 'previewFunding' })
    app = await buildApp(store, TEST_CONFIG, reader)

    const wire = await buildOrderWire(
      MAKER,
      { tokenIn: MOCK_YES as Address, tokenOut: MOCK_USDC as Address, amountIn: BigInt(100), minAmountOut: BigInt(1) },
      BigInt(107),
    )
    const res = await app.inject({ method: 'POST', url: '/order', body: wire })

    expect(res.statusCode).toBe(201)
  })

  it('skips all pre-filter checks when no chain reader is provided (existing tests keep passing)', async () => {
    app = await buildApp(store, TEST_CONFIG)  // no chainReader arg

    const wire = await buildOrderWire(
      MAKER,
      { tokenIn: MOCK_YES as Address, tokenOut: MOCK_USDC as Address, amountIn: BigInt(100), minAmountOut: BigInt(1) },
      BigInt(108),
    )
    const res = await app.inject({ method: 'POST', url: '/order', body: wire })

    expect(res.statusCode).toBe(201)
  })
})

describe('POST /order — trading fee (feeBps=50)', () => {
  const FEE_CONFIG: AppConfig = { ...TEST_CONFIG, feeBps: 50 }

  let app: Awaited<ReturnType<typeof buildApp>>
  let store: MemoryOrderStore

  beforeEach(() => {
    store = new MemoryOrderStore()
  })

  afterEach(async () => {
    await app.close()
  })

  it('stores a NO bid at its NET price (buyer amountIn is fee-inclusive)', async () => {
    app = await buildApp(store, FEE_CONFIG)

    // Gross 950e6 for 1000e6 NO → fee = min(950e6, 50e6) × 50/10000 = 250_000
    const wire = await buildOrderWire(
      MAKER,
      {
        tokenIn: MOCK_USDC as Address, tokenOut: MOCK_NO as Address,
        amountIn: BigInt(950_000_000), minAmountOut: BigInt(1_000_000_000),
      },
      BigInt(200),
    )
    const res = await app.inject({ method: 'POST', url: '/order', body: wire })
    expect(res.statusCode).toBe(201)

    const { orderId } = res.json<{ orderId: string }>()
    const stored = await store.getOrder(orderId)
    expect(stored?.price).toBeCloseTo(0.94975, 10) // net 949.75e6 / 1000e6, not gross 0.95
  })

  it('stores a YES bid at its GROSS price (YES buys are fee-free)', async () => {
    app = await buildApp(store, FEE_CONFIG)

    const wire = await buildOrderWire(
      MAKER,
      {
        tokenIn: MOCK_USDC as Address, tokenOut: MOCK_YES as Address,
        amountIn: BigInt(50_000_000), minAmountOut: BigInt(1_000_000_000),
      },
      BigInt(201),
    )
    const res = await app.inject({ method: 'POST', url: '/order', body: wire })
    expect(res.statusCode).toBe(201)

    const { orderId } = res.json<{ orderId: string }>()
    const stored = await store.getOrder(orderId)
    expect(stored?.price).toBeCloseTo(0.05, 10)
  })

  it('rejects a YES sell that covers the debit but not debit + fee', async () => {
    // D = 30e6; minAmountOut 30_000_001 clears D but not D + fee (150_000)
    const reader = mockChainReader({ fundingDebt: BigInt(30_000_000), previewDelta: BigInt(0) })
    app = await buildApp(store, FEE_CONFIG, reader)

    const wire = await buildOrderWire(
      MAKER,
      {
        tokenIn: MOCK_YES as Address, tokenOut: MOCK_USDC as Address,
        amountIn: BigInt(1_000_000_000), minAmountOut: BigInt(30_000_001),
      },
      BigInt(202),
    )
    const res = await app.inject({ method: 'POST', url: '/order', body: wire })

    expect(res.statusCode).toBe(400)
    const body = res.json<{ error: string; minSellProceeds: string }>()
    expect(body.error).toBe('FundingShortfall')
    // Exact inversion of net(G) = G − fee(G): ceil(30e6 × 10000 / 9950)
    expect(body.minSellProceeds).toBe('30150754')
  })

  it('accepts a YES sell priced at the minSellProceeds hint', async () => {
    const reader = mockChainReader({ fundingDebt: BigInt(30_000_000), previewDelta: BigInt(0) })
    app = await buildApp(store, FEE_CONFIG, reader)

    const wire = await buildOrderWire(
      MAKER,
      {
        tokenIn: MOCK_YES as Address, tokenOut: MOCK_USDC as Address,
        amountIn: BigInt(1_000_000_000), minAmountOut: BigInt(30_150_754),
      },
      BigInt(203),
    )
    const res = await app.inject({ method: 'POST', url: '/order', body: wire })
    expect(res.statusCode).toBe(201)
  })
})

describe('GET /health', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let store: MemoryOrderStore

  afterEach(async () => {
    await app.close()
  })

  it('returns 200 { status: "ok" } when the store is reachable', async () => {
    store = new MemoryOrderStore()
    app = await buildApp(store, TEST_CONFIG)

    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok' })
  })

  it('returns 503 { status: "error" } when the store ping fails', async () => {
    store = new MemoryOrderStore()
    vi.spyOn(store, 'ping').mockResolvedValue(false)
    app = await buildApp(store, TEST_CONFIG)

    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(503)
    expect(res.json<{ status: string }>().status).toBe('error')
  })

  it('returns 503 { status: "error" } when the store ping throws', async () => {
    store = new MemoryOrderStore()
    vi.spyOn(store, 'ping').mockRejectedValue(new Error('ECONNREFUSED'))
    app = await buildApp(store, TEST_CONFIG)

    const res = await app.inject({ method: 'GET', url: '/health' })

    expect(res.statusCode).toBe(503)
    expect(res.json<{ status: string }>().status).toBe('error')
  })
})

describe('CORS', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let store: MemoryOrderStore

  beforeEach(() => {
    store = new MemoryOrderStore()
  })

  afterEach(async () => {
    await app.close()
  })

  it('defaults to wildcard Access-Control-Allow-Origin when corsOrigins is unset', async () => {
    app = await buildApp(store, TEST_CONFIG)

    const res = await app.inject({
      method: 'GET', url: '/orderbook', headers: { origin: 'https://evil.example.com' },
    })

    expect(res.headers['access-control-allow-origin']).toBe('*')
    expect(res.headers['vary']).toBeUndefined()
  })

  it('defaults to wildcard when corsOrigins is an empty array', async () => {
    app = await buildApp(store, { ...TEST_CONFIG, corsOrigins: [] })

    const res = await app.inject({ method: 'GET', url: '/orderbook' })

    expect(res.headers['access-control-allow-origin']).toBe('*')
  })

  it('echoes back an allow-listed origin with Vary: Origin', async () => {
    app = await buildApp(store, {
      ...TEST_CONFIG,
      corsOrigins: ['https://credit-prediction-dex.vercel.app', 'http://localhost:3000'],
    })

    const res = await app.inject({
      method: 'GET', url: '/orderbook', headers: { origin: 'http://localhost:3000' },
    })

    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000')
    expect(res.headers['vary']).toBe('Origin')
  })

  it('omits Access-Control-Allow-Origin for a non-listed origin', async () => {
    app = await buildApp(store, { ...TEST_CONFIG, corsOrigins: ['https://credit-prediction-dex.vercel.app'] })

    const res = await app.inject({
      method: 'GET', url: '/orderbook', headers: { origin: 'https://evil.example.com' },
    })

    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('omits Access-Control-Allow-Origin when there is no Origin header and an allow-list is set', async () => {
    app = await buildApp(store, { ...TEST_CONFIG, corsOrigins: ['https://credit-prediction-dex.vercel.app'] })

    const res = await app.inject({ method: 'GET', url: '/orderbook' })

    expect(res.headers['access-control-allow-origin']).toBeUndefined()
  })

  it('keeps Allow-Methods/Allow-Headers and the OPTIONS preflight working with an allow-list configured', async () => {
    app = await buildApp(store, { ...TEST_CONFIG, corsOrigins: ['http://localhost:3000'] })

    const res = await app.inject({
      method: 'OPTIONS', url: '/order', headers: { origin: 'http://localhost:3000' },
    })

    expect(res.statusCode).toBe(204)
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000')
    expect(res.headers['access-control-allow-methods']).toBe('GET,POST,DELETE,OPTIONS')
    expect(res.headers['access-control-allow-headers']).toBe('Content-Type')
  })
})

describe('Rate limiting — POST /order + DELETE /order/:id (shared bucket)', () => {
  const RL_CONFIG: AppConfig = { ...TEST_CONFIG, orderRateLimitMax: 2, orderRateLimitWindowMs: 60_000 }

  let app: Awaited<ReturnType<typeof buildApp>>
  let store: MemoryOrderStore

  beforeEach(async () => {
    store = new MemoryOrderStore()
    app = await buildApp(store, RL_CONFIG)
  })

  afterEach(async () => {
    await app.close()
  })

  // The rate-limit hook runs onRequest, before body/signature validation —
  // so an intentionally-empty/invalid body still consumes the bucket. Only
  // the limiter's own behavior is under test here, not order validation.
  async function postJunk(remoteAddress: string, extraHeaders: Record<string, string> = {}) {
    return app.inject({
      method: 'POST', url: '/order', body: {}, remoteAddress,
      headers: extraHeaders,
    })
  }

  it('returns 429 with a JSON error body, retry-after, and rate-limit headers once the bucket is exhausted', async () => {
    await postJunk('20.0.0.1')
    await postJunk('20.0.0.1')

    const res = await postJunk('20.0.0.1')

    expect(res.statusCode).toBe(429)
    const body = res.json<{ error: string }>()
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
    expect(res.headers['retry-after']).toBeDefined()
    expect(res.headers['x-ratelimit-limit']).toBe('2')
    expect(res.headers['x-ratelimit-remaining']).toBe('0')
  })

  it('carries the CORS header on a 429 response (the onSend hook still runs)', async () => {
    await postJunk('20.0.0.2')
    await postJunk('20.0.0.2')

    const res = await postJunk('20.0.0.2', { origin: 'https://evil.example.com' })

    expect(res.statusCode).toBe(429)
    // TEST_CONFIG has no corsOrigins allow-list, so the wildcard default applies.
    expect(res.headers['access-control-allow-origin']).toBe('*')
  })

  it('gives separate client IPs separate buckets', async () => {
    await postJunk('21.0.0.1')
    await postJunk('21.0.0.1')
    const blocked = await postJunk('21.0.0.1')
    expect(blocked.statusCode).toBe(429)

    // A different IP has its own, unexhausted bucket.
    const other = await postJunk('21.0.0.2')
    expect(other.statusCode).not.toBe(429)
  })

  it('shares one bucket across POST /order and DELETE /order/:id', async () => {
    await postJunk('22.0.0.1')
    const del = await app.inject({
      method: 'DELETE', url: '/order/does-not-exist', remoteAddress: '22.0.0.1',
      headers: { 'x-maker': '0x1', 'x-signature': '0x1' },
    })
    expect(del.statusCode).not.toBe(429) // 2nd request, still within max=2

    const res = await postJunk('22.0.0.1') // 3rd request across both routes combined
    expect(res.statusCode).toBe(429)
  })

  it('never rate-limits GET /orderbook or GET /health, even after the mutation bucket is exhausted', async () => {
    await postJunk('23.0.0.1')
    await postJunk('23.0.0.1')
    const exhausted = await postJunk('23.0.0.1')
    expect(exhausted.statusCode).toBe(429)

    for (let i = 0; i < 5; i++) {
      const ob = await app.inject({ method: 'GET', url: '/orderbook', remoteAddress: '23.0.0.1' })
      expect(ob.statusCode).toBe(200)
      const health = await app.inject({ method: 'GET', url: '/health', remoteAddress: '23.0.0.1' })
      expect(health.statusCode).toBe(200)
    }
  })

  it('never rate-limits the OPTIONS preflight', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await app.inject({ method: 'OPTIONS', url: '/order', remoteAddress: '24.0.0.1' })
      expect(res.statusCode).toBe(204)
    }
  })

  it('ORDER_RATE_LIMIT_MAX=0 disables the limiter entirely', async () => {
    const disabledStore = new MemoryOrderStore()
    const disabledApp = await buildApp(disabledStore, { ...TEST_CONFIG, orderRateLimitMax: 0 })
    try {
      for (let i = 0; i < 10; i++) {
        const res = await disabledApp.inject({ method: 'POST', url: '/order', body: {}, remoteAddress: '25.0.0.1' })
        expect(res.statusCode).not.toBe(429)
      }
    } finally {
      await disabledApp.close()
    }
  })
})

describe('Rate limiting — TRUST_PROXY / X-Forwarded-For', () => {
  it('TRUST_PROXY unset (default false) ignores X-Forwarded-For — buckets key on the raw remote address', async () => {
    const store = new MemoryOrderStore()
    const app = await buildApp(store, { ...TEST_CONFIG, orderRateLimitMax: 1, orderRateLimitWindowMs: 60_000 })
    try {
      const first = await app.inject({
        method: 'POST', url: '/order', body: {}, remoteAddress: '30.0.0.1',
        headers: { 'x-forwarded-for': 'spoofed-a' },
      })
      expect(first.statusCode).not.toBe(429)

      // Different X-Forwarded-For, SAME remoteAddress: with trustProxy unset
      // the header is ignored entirely, so this still lands in the same
      // (already-exhausted) bucket.
      const second = await app.inject({
        method: 'POST', url: '/order', body: {}, remoteAddress: '30.0.0.1',
        headers: { 'x-forwarded-for': 'spoofed-b' },
      })
      expect(second.statusCode).toBe(429)
    } finally {
      await app.close()
    }
  })

  it('TRUST_PROXY=1 keys on X-Forwarded-For, and a spoofed left-most entry cannot bypass the 1-hop limit', async () => {
    const store = new MemoryOrderStore()
    const app = await buildApp(store, {
      ...TEST_CONFIG, orderRateLimitMax: 1, orderRateLimitWindowMs: 60_000, trustProxy: 1,
    })
    try {
      // remoteAddress stands in for Railway's single trusted proxy hop;
      // "real" is the actual client, "spoofed" is an attacker-controlled
      // value the client itself prepended to the header it sends.
      const first = await app.inject({
        method: 'POST', url: '/order', body: {}, remoteAddress: '31.0.0.1',
        headers: { 'x-forwarded-for': 'spoofed, real' },
      })
      expect(first.statusCode).not.toBe(429)

      // Same real client, DIFFERENT spoofed left-most entry. If Fastify used
      // trustProxy: true semantics (left-most wins), this would look like a
      // brand-new, unlimited client. With a 1-hop trust count it still
      // resolves to "real" (the right-most/nearest-to-proxy entry) and is
      // correctly blocked.
      const second = await app.inject({
        method: 'POST', url: '/order', body: {}, remoteAddress: '31.0.0.1',
        headers: { 'x-forwarded-for': 'a-different-spoof, real' },
      })
      expect(second.statusCode).toBe(429)
    } finally {
      await app.close()
    }
  })
})

describe('GET /orderbook', () => {
  let app: Awaited<ReturnType<typeof buildApp>>
  let store: MemoryOrderStore

  beforeEach(async () => {
    store = new MemoryOrderStore()
    app = await buildApp(store, TEST_CONFIG)
  })

  afterEach(async () => {
    await app.close()
  })

  async function postOrder(wire: OrderWire) {
    const res = await app.inject({ method: 'POST', url: '/order', body: wire })
    expect(res.statusCode).toBe(201)
    return res.json<{ orderId: string }>().orderId
  }

  it('returns bids sorted highest-price-first and asks sorted lowest-price-first', async () => {
    // Bids (tokenIn=USDC, tokenOut=YES): price = amountIn / minAmountOut
    // nonce 10: price = 30/100 = 0.30
    // nonce 11: price = 20/100 = 0.20
    // nonce 12: price = 25/100 = 0.25
    await postOrder(await buildOrderWire(MAKER, { amountIn: BigInt(30), minAmountOut: BigInt(100) }, BigInt(10)))
    await postOrder(await buildOrderWire(MAKER, { amountIn: BigInt(20), minAmountOut: BigInt(100) }, BigInt(11)))
    await postOrder(await buildOrderWire(MAKER, { amountIn: BigInt(25), minAmountOut: BigInt(100) }, BigInt(12)))

    // Asks (tokenIn=YES, tokenOut=USDC): price = minAmountOut / amountIn
    // nonce 20: price = 40/100 = 0.40
    // nonce 21: price = 35/100 = 0.35
    await postOrder(await buildOrderWire(
      MAKER,
      { tokenIn: MOCK_YES as Address, tokenOut: MOCK_USDC as Address, amountIn: BigInt(100), minAmountOut: BigInt(40) },
      BigInt(20),
    ))
    await postOrder(await buildOrderWire(
      MAKER,
      { tokenIn: MOCK_YES as Address, tokenOut: MOCK_USDC as Address, amountIn: BigInt(100), minAmountOut: BigInt(35) },
      BigInt(21),
    ))

    const res = await app.inject({ method: 'GET', url: '/orderbook' })
    expect(res.statusCode).toBe(200)

    const book = res.json<{ bids: Array<{ price: number }>; asks: Array<{ price: number }> }>()

    expect(book.bids).toHaveLength(3)
    expect(book.asks).toHaveLength(2)

    // Bids: 0.30, 0.25, 0.20 — descending
    expect(book.bids[0].price).toBeGreaterThan(book.bids[1].price)
    expect(book.bids[1].price).toBeGreaterThan(book.bids[2].price)
    expect(book.bids[0].price).toBeCloseTo(0.30)
    expect(book.bids[1].price).toBeCloseTo(0.25)
    expect(book.bids[2].price).toBeCloseTo(0.20)

    // Asks: 0.35, 0.40 — ascending
    expect(book.asks[0].price).toBeLessThan(book.asks[1].price)
    expect(book.asks[0].price).toBeCloseTo(0.35)
    expect(book.asks[1].price).toBeCloseTo(0.40)
  })

  it('returns empty book when no orders exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/orderbook' })
    expect(res.statusCode).toBe(200)
    const book = res.json<{ bids: unknown[]; asks: unknown[] }>()
    expect(book.bids).toHaveLength(0)
    expect(book.asks).toHaveLength(0)
  })
})
