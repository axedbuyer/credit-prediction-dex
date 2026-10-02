import { describe, it, expect, beforeEach, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import type { Address } from 'viem'
import { buildApp, type MarketServices } from '../server'
import { MemoryOrderStore } from '../orderbook'
import { ORDER_TYPES } from '../validation'
import { MarketDirectory } from '../registry'
import type { IRegistryClient, MarketInfo } from '../registry'
import type { AppConfig, OrderWire } from '../types'
import type { IChainReader } from '../chain'

const MAKER = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
const CHAIN_ID = 84532
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address

// market ids: mstr 0x1_, turkey 0x2_, dead (inactive) 0x3_
function raw(slug: string, base: number, active = true) {
  return {
    slug, entityName: slug.toUpperCase(), entityType: slug === 'turkey' ? 1 : 0,
    creditMarket: a(base), yesToken: a(base + 1), noToken: a(base + 2), clobSettlement: a(base + 3),
    oracleRouter: a(base + 4), liquidationEngine: a(base + 5),
    active, registeredAt: 1n, startBlock: 12345n,
  }
}
const MSTR = { yes: a(0x101), no: a(0x102), clob: a(0x103) }
const TURKEY = { yes: a(0x201), no: a(0x202), clob: a(0x203) }
const DEAD = { yes: a(0x301) }

const REGISTRY = a(0x999)

async function makeDirectory(): Promise<MarketDirectory> {
  const client: IRegistryClient = {
    readContract: async () => [raw('mstr', 0x100), raw('turkey', 0x200), raw('dead', 0x300, false)],
  }
  const d = new MarketDirectory({ client, registryAddress: REGISTRY, log: () => {} })
  await d.refresh()
  return d
}

const CONFIG: AppConfig = {
  usdcAddress: USDC,
  yesTokenAddress: MSTR.yes, noTokenAddress: MSTR.no, clobSettlementAddress: MSTR.clob,
  chainId: CHAIN_ID,
  orderRateLimitMax: 0,
}

function sign(clob: Address, m: { tokenIn: Address; tokenOut: Address; amountIn: bigint; minAmountOut: bigint; nonce: bigint }) {
  const full = { maker: MAKER.address, expiry: BigInt(Math.floor(Date.now() / 1000) + 3600), ...m }
  return MAKER.signTypedData({
    domain: { name: 'CLOBSettlement', version: '1', chainId: CHAIN_ID, verifyingContract: clob },
    types: ORDER_TYPES, primaryType: 'Order', message: full,
  }).then((signature): OrderWire => ({
    maker: full.maker, tokenIn: full.tokenIn, tokenOut: full.tokenOut,
    amountIn: full.amountIn.toString(), minAmountOut: full.minAmountOut.toString(),
    expiry: full.expiry.toString(), nonce: full.nonce.toString(), signature,
  }))
}

const yesBid = (clob: Address, yes: Address, nonce = 1n, amountIn = 230n) =>
  sign(clob, { tokenIn: USDC as Address, tokenOut: yes, amountIn, minAmountOut: 1000n, nonce })
const yesAsk = (clob: Address, yes: Address, nonce = 1n) =>
  sign(clob, { tokenIn: yes, tokenOut: USDC as Address, amountIn: 1000n, minAmountOut: 200n, nonce })

function reader(opts: { claimable?: boolean } = {}): IChainReader {
  return {
    isClaimable: vi.fn(async () => opts.claimable ?? false),
    previewFunding: vi.fn(async () => 0n),
    fundingDebt: vi.fn(async () => 0n),
    yesBalanceOf: vi.fn(async () => 1000n),
  }
}

describe('multi-market server (registry mode)', () => {
  let store: MemoryOrderStore
  let directory: MarketDirectory
  let svc: Record<string, MarketServices>
  let app: Awaited<ReturnType<typeof buildApp>>

  beforeEach(async () => {
    store = new MemoryOrderStore()
    directory = await makeDirectory()
    svc = {
      mstr: { chainReader: reader(), feeSource: { getFeeBps: () => 50, getSnapshot: () => ({ feeBps: 50, source: 'chain', lastRefreshAt: 1 }) } },
      turkey: { chainReader: reader({ claimable: true }), feeSource: { getFeeBps: () => 0, getSnapshot: () => ({ feeBps: 0, source: 'chain', lastRefreshAt: 1 }) } },
    }
    app = await buildApp(store, CONFIG, undefined, { directory, services: (m: MarketInfo) => svc[m.slug] ?? {} })
  })

  it('GET /markets lists every market with decimal startBlock', async () => {
    const res = await app.inject({ method: 'GET', url: '/markets' })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.mode).toBe('registry')
    expect(body.markets.map((m: { slug: string }) => m.slug)).toEqual(['mstr', 'turkey', 'dead'])
    expect(body.markets[1]).toMatchObject({
      slug: 'turkey', entityType: 'sovereign', active: true, yesToken: TURKEY.yes,
      noToken: TURKEY.no, clobSettlement: TURKEY.clob, startBlock: '12345',
    })
    expect(body.markets[2].active).toBe(false)
  })

  it('POST routes to the market of the token and returns market', async () => {
    const wire = await yesBid(MSTR.clob, MSTR.yes)
    const res = await app.inject({ method: 'POST', url: '/order', payload: wire })
    expect(res.statusCode).toBe(201)
    expect(res.json().market).toBe('mstr')
    expect((await store.getOrder(res.json().orderId))!.market).toBe('mstr')
  })

  it('per-market /orderbook isolates books; no param aliases mstr; unknown slug 404s', async () => {
    const m = await app.inject({ method: 'POST', url: '/order', payload: await yesBid(MSTR.clob, MSTR.yes) })
    // turkey chain reader reports claimable, so use a clean one for this test
    svc.turkey.chainReader = reader()
    const t = await app.inject({ method: 'POST', url: '/order', payload: await yesBid(TURKEY.clob, TURKEY.yes) })
    expect(t.statusCode).toBe(201)

    const mstrBook = (await app.inject({ method: 'GET', url: '/orderbook?market=mstr' })).json()
    const turkeyBook = (await app.inject({ method: 'GET', url: '/orderbook?market=turkey' })).json()
    const alias = (await app.inject({ method: 'GET', url: '/orderbook' })).json()
    expect(mstrBook.bids.map((o: { id: string }) => o.id)).toEqual([m.json().orderId])
    expect(turkeyBook.bids.map((o: { id: string }) => o.id)).toEqual([t.json().orderId])
    expect(alias).toEqual(mstrBook)

    const nope = await app.inject({ method: 'GET', url: '/orderbook?market=nope' })
    expect(nope.statusCode).toBe(404)
    expect(nope.json()).toEqual({ error: 'UnknownMarket' })
  })

  it('400 InvalidTokenPair: neither or both legs USDC, or a non-token address of a market', async () => {
    const neither = await sign(MSTR.clob, { tokenIn: MSTR.yes, tokenOut: MSTR.no, amountIn: 1n, minAmountOut: 1n, nonce: 1n })
    expect((await app.inject({ method: 'POST', url: '/order', payload: neither })).json()).toEqual({ error: 'InvalidTokenPair' })
    const both = await sign(MSTR.clob, { tokenIn: USDC as Address, tokenOut: USDC as Address, amountIn: 1n, minAmountOut: 1n, nonce: 1n })
    expect((await app.inject({ method: 'POST', url: '/order', payload: both })).statusCode).toBe(400)
    // creditMarket address is "in" the market but is not YES/NO
    const cm = await sign(MSTR.clob, { tokenIn: USDC as Address, tokenOut: a(0x100), amountIn: 1n, minAmountOut: 1n, nonce: 1n })
    const res = await app.inject({ method: 'POST', url: '/order', payload: cm })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'InvalidTokenPair' })
  })

  it('400 UnknownMarket for a token in no market', async () => {
    const w = await sign(MSTR.clob, { tokenIn: USDC as Address, tokenOut: a(0xdead), amountIn: 1n, minAmountOut: 1n, nonce: 1n })
    const res = await app.inject({ method: 'POST', url: '/order', payload: w })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'UnknownMarket' })
  })

  it('400 MarketInactive for a deactivated market', async () => {
    const w = await sign(a(0x303), { tokenIn: USDC as Address, tokenOut: DEAD.yes, amountIn: 1n, minAmountOut: 1n, nonce: 1n })
    const res = await app.inject({ method: 'POST', url: '/order', payload: w })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'MarketInactive' })
  })

  it("rejects an order signed for market A's CLOB that names market B's token", async () => {
    const wire = await yesBid(MSTR.clob, TURKEY.yes)   // signed for mstr's domain, turkey token
    svc.turkey.chainReader = reader()
    const res = await app.inject({ method: 'POST', url: '/order', payload: wire })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'Invalid signature' })
    expect((await app.inject({ method: 'GET', url: '/orderbook?market=turkey' })).json().bids).toHaveLength(0)
  })

  it('nonces are namespaced per market (same nonce in two markets is fine; reuse within one is not)', async () => {
    svc.turkey.chainReader = reader()
    const r1 = await app.inject({ method: 'POST', url: '/order', payload: await yesBid(MSTR.clob, MSTR.yes, 7n) })
    const r2 = await app.inject({ method: 'POST', url: '/order', payload: await yesBid(TURKEY.clob, TURKEY.yes, 7n) })
    expect(r1.statusCode).toBe(201)
    expect(r2.statusCode).toBe(201)
    const dup = await app.inject({ method: 'POST', url: '/order', payload: await yesBid(MSTR.clob, MSTR.yes, 7n, 231n) })
    expect(dup.statusCode).toBe(400)
    expect(dup.json().error).toBe('Nonce already used')
  })

  it("chain pre-filter uses the order's own market reader (turkey claimable, mstr not)", async () => {
    const ok = await app.inject({ method: 'POST', url: '/order', payload: await yesBid(MSTR.clob, MSTR.yes) })
    expect(ok.statusCode).toBe(201)
    const frozen = await app.inject({ method: 'POST', url: '/order', payload: await yesBid(TURKEY.clob, TURKEY.yes) })
    expect(frozen.statusCode).toBe(400)
    expect(frozen.json()).toEqual({ error: 'PositionFrozen' })
    expect(svc.mstr.chainReader!.isClaimable).toHaveBeenCalledTimes(1)
    expect(svc.turkey.chainReader!.isClaimable).toHaveBeenCalledTimes(1)
  })

  it("fee rate is per market: NO-bid price nets mstr's 50 bps but not turkey's 0", async () => {
    svc.turkey.chainReader = reader()
    const mk = (clob: Address, no: Address) =>
      sign(clob, { tokenIn: USDC as Address, tokenOut: no, amountIn: 500n, minAmountOut: 1000n, nonce: 1n })
    const m = await app.inject({ method: 'POST', url: '/order', payload: await mk(MSTR.clob, MSTR.no) })
    const t = await app.inject({ method: 'POST', url: '/order', payload: await mk(TURKEY.clob, TURKEY.no) })
    const mp = (await store.getOrder(m.json().orderId))!.price
    const tp = (await store.getOrder(t.json().orderId))!.price
    expect(tp).toBeCloseTo(0.5)        // gross, fee 0
    expect(mp).toBeLessThan(0.5)       // net of 50 bps fee
  })

  it('DELETE cancels from the order market book', async () => {
    const wire = await yesAsk(MSTR.clob, MSTR.yes)
    const res = await app.inject({ method: 'POST', url: '/order', payload: wire })
    const id = res.json().orderId as string
    const sig = await MAKER.signTypedData({
      domain: { name: 'CLOBSettlement', version: '1', chainId: CHAIN_ID, verifyingContract: MSTR.clob },
      types: { CancelOrder: [{ name: 'orderId', type: 'string' }] },
      primaryType: 'CancelOrder', message: { orderId: id },
    })
    const del = await app.inject({ method: 'DELETE', url: `/order/${id}`, headers: { 'x-maker': MAKER.address, 'x-signature': sig } })
    expect(del.statusCode).toBe(200)
    expect((await app.inject({ method: 'GET', url: '/orderbook?market=mstr' })).json().asks).toHaveLength(0)
  })

  it('GET /health keeps top-level fee and adds registry + per-market fee', async () => {
    const h = (await app.inject({ method: 'GET', url: '/health' })).json()
    expect(h.status).toBe('ok')
    expect(h.fee.feeBps).toBe(50)
    expect(h.registry).toMatchObject({ mode: 'registry', marketCount: 3 })
    expect(h.markets.mstr.fee).toEqual({ bps: 50, source: 'chain' })
    expect(h.markets.turkey.fee).toEqual({ bps: 0, source: 'chain' })
  })
})

describe('legacy mode (no registry)', () => {
  it('serves exactly one market, mstr, from the single-set config', async () => {
    const app = await buildApp(new MemoryOrderStore(), { ...CONFIG, creditMarketAddress: a(0x100) })
    const m = (await app.inject({ method: 'GET', url: '/markets' })).json()
    expect(m.mode).toBe('legacy')
    expect(m.markets).toHaveLength(1)
    expect(m.markets[0]).toMatchObject({ slug: 'mstr', yesToken: MSTR.yes, noToken: MSTR.no, clobSettlement: MSTR.clob })
    const wire = await yesBid(MSTR.clob, MSTR.yes)
    const res = await app.inject({ method: 'POST', url: '/order', payload: wire })
    expect(res.statusCode).toBe(201)
    expect((await app.inject({ method: 'GET', url: '/orderbook' })).json().bids).toHaveLength(1)
    const h = (await app.inject({ method: 'GET', url: '/health' })).json()
    expect(h.registry.mode).toBe('legacy')
    expect(h.markets.mstr.fee).toBeDefined()
  })
})
