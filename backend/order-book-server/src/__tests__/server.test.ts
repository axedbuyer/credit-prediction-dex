import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import type { Address } from 'viem'
import { buildApp } from '../server'
import { MemoryOrderStore } from '../orderbook'
import { ORDER_TYPES } from '../validation'
import type { AppConfig, OrderWire } from '../types'

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

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /order', () => {
  let app: ReturnType<typeof buildApp>
  let store: MemoryOrderStore

  beforeEach(() => {
    store = new MemoryOrderStore()
    app = buildApp(store, TEST_CONFIG)
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

describe('GET /orderbook', () => {
  let app: ReturnType<typeof buildApp>
  let store: MemoryOrderStore

  beforeEach(() => {
    store = new MemoryOrderStore()
    app = buildApp(store, TEST_CONFIG)
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
