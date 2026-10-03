import Fastify, { type FastifyInstance } from 'fastify'
import rateLimit from '@fastify/rate-limit'
import { v4 as uuidv4 } from 'uuid'
import type { Address, Hex } from 'viem'
import type { AppConfig, Order, OrderWire, StoredOrder } from './types'
import type { OrderStore } from './orderbook'
import type { IChainReader } from './chain'
import { verifyOrderSignature, verifyCancelSignature } from './validation'
import { tradeFee, netNoBidProceeds, minGrossForNet } from './fee'
import { DEFAULT_ORDER_RATE_LIMIT_MAX, DEFAULT_ORDER_RATE_LIMIT_WINDOW_MS } from './rateLimit'
import type { FeeSourceSnapshot, FeeSourceReader } from './feeSource'
import { MarketDirectory, legacyMarket, type MarketInfo } from './registry'

// Per-market live dependencies. In registry mode main.ts supplies these for
// every market (see marketServices.ts); in legacy mode / tests buildApp falls
// back to the single-set `chainReader` argument + `config.feeSource` for mstr.
export interface MarketServices {
  chainReader?: IChainReader
  feeSource?: FeeSourceReader
}

export interface BuildAppOptions {
  /** Absent ⇒ a legacy one-market (`mstr`) directory built from `config`. */
  directory?: MarketDirectory
  services?: (market: MarketInfo) => MarketServices
}

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const LEGACY_SLUG = 'mstr'

// ─── Helpers ──────────────────────────────────────────────────────────────────

// The CURRENT fee rate for a market: its live feeSource (on-chain-backed — see
// src/feeSource.ts) when present, else the static `config.feeBps` (tests /
// legacy callers). Read fresh on every call — never cached — so an admin
// `setFeeConfig` change (picked up by the periodic refresh) is reflected on the
// very next request without a restart.
function feeBpsOf(svc: MarketServices, config: AppConfig): number {
  return svc.feeSource ? svc.feeSource.getFeeBps() : (config.feeBps ?? 0)
}

function feeSnapshotOf(svc: MarketServices, config: AppConfig): FeeSourceSnapshot {
  if (svc.feeSource) return svc.feeSource.getSnapshot()
  return { feeBps: config.feeBps ?? 0, source: 'env-fallback', lastRefreshAt: null }
}

function wireToOrder(wire: OrderWire): Order {
  return {
    maker: wire.maker as Address,
    tokenIn: wire.tokenIn as Address,
    tokenOut: wire.tokenOut as Address,
    amountIn: BigInt(wire.amountIn),
    minAmountOut: BigInt(wire.minAmountOut),
    expiry: BigInt(wire.expiry),
    nonce: BigInt(wire.nonce),
    signature: wire.signature as Hex,
  }
}

/**
 * Price in "USDC-units per token-units" (raw wei ratio, consistent for sorting).
 *
 * bid (tokenIn=USDC):  amountIn_USDC / minAmountOut_TOKEN
 * ask (tokenIn=TOKEN): minAmountOut_USDC / amountIn_TOKEN
 *
 * Both ratios are comparable within the same token pair and give a monotonic
 * ordering that matches the human price — higher bid = more USDC offered per token.
 *
 * NO bids are the one fee-adjusted case: the NO buyer's signed amountIn is
 * gross (fee-inclusive), but on-chain the fee-free seller receives — and has
 * their limit checked against — the NET amount. Pricing NO bids gross would
 * cross pairs the contract then rejects with SlippageExceeded, so the stored
 * price uses net proceeds. YES bids are fee-free; on asks the fee (YES side)
 * is the seller's own burden and never moves the crossing price.
 */
function derivePrice(wire: OrderWire, usdcAddress: string, market: MarketInfo, feeBps: number): number {
  const isUsdcIn = wire.tokenIn.toLowerCase() === usdcAddress.toLowerCase()
  const amtIn = BigInt(wire.amountIn)
  const minOut = BigInt(wire.minAmountOut)
  if (isUsdcIn) {
    if (minOut === 0n) return 0
    const isNoBid = wire.tokenOut.toLowerCase() === market.noToken.toLowerCase()
    const usdcLeg = isNoBid
      ? netNoBidProceeds(minOut, amtIn, BigInt(feeBps))
      : amtIn
    return Number(usdcLeg) / Number(minOut)
  }
  return amtIn === 0n ? 0 : Number(minOut) / Number(amtIn)
}

function deriveSide(wire: OrderWire, usdcAddress: string): 'bid' | 'ask' {
  return wire.tokenIn.toLowerCase() === usdcAddress.toLowerCase() ? 'bid' : 'ask'
}

// ─── Chain pre-filter ─────────────────────────────────────────────────────────
//
// v1b1: rejects orders that would deterministically revert on-chain (see root
// CLAUDE.md, "Off-chain pre-filter"). This is UX guidance only — the on-chain
// `require`/revert remains the backstop — so any chain-read error is caught
// and logged, and the order is accepted rather than blocked.

type PreFilterResult =
  | { rejected: false }
  | { rejected: true; status: number; body: Record<string, unknown> }

async function runChainPreFilter(
  order: Order,
  market: MarketInfo,
  feeBpsNow: number,
  chainReader: IChainReader,
): Promise<PreFilterResult> {
  try {
    if (await chainReader.isClaimable(order.maker)) {
      return { rejected: true, status: 400, body: { error: 'PositionFrozen' } }
    }

    const isYesSell = order.tokenIn.toLowerCase() === market.yesToken.toLowerCase()
    if (isYesSell) {
      const yesBal = await chainReader.yesBalanceOf(order.maker)
      const [previewDelta, debt] = await Promise.all([
        chainReader.previewFunding(order.maker, yesBal, true),
        chainReader.fundingDebt(order.maker),
      ])

      // Net debit D = fundingDebt − previewDelta (previewDelta = noCredit − yesOwed,
      // mirroring settleFunding's `debit = fundingDebt + yesOwed` netted against
      // noCredit). Only relevant when positive. The on-chain check is
      // tradePrice ≥ debit + fee, so the trading fee on this YES sell joins the
      // required proceeds; minSellProceeds inverts net(G) = G − fee(G) exactly.
      const netDebit = debt - previewDelta
      const feeBps = BigInt(feeBpsNow)
      const fee = tradeFee(order.amountIn, order.minAmountOut, feeBps)
      if (netDebit > 0n && order.minAmountOut < netDebit + fee) {
        return {
          rejected: true,
          status: 400,
          body: {
            error: 'FundingShortfall',
            minSellProceeds: minGrossForNet(netDebit, order.amountIn, feeBps).toString(),
          },
        }
      }
    }

    return { rejected: false }
  } catch (err) {
    console.error(`[order-book-server] chain pre-filter failed for maker=${order.maker}, accepting order:`, err)
    return { rejected: false }
  }
}

// ─── App factory ──────────────────────────────────────────────────────────────

export async function buildApp(
  store: OrderStore,
  config: AppConfig,
  chainReader?: IChainReader,
  opts: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const directory = opts.directory ?? new MarketDirectory({
    legacy: legacyMarket({
      creditMarket: config.creditMarketAddress ?? ZERO_ADDRESS,
      yesToken: config.yesTokenAddress,
      noToken: config.noTokenAddress,
      clobSettlement: config.clobSettlementAddress,
    }),
  })
  const servicesFor = (m: MarketInfo): MarketServices => {
    if (opts.services) return opts.services(m)
    return m.slug === LEGACY_SLUG ? { chainReader, feeSource: config.feeSource } : {}
  }
  const usdc = config.usdcAddress.toLowerCase()

  // trustProxy governs request.ip (X-Forwarded-For handling) — see
  // src/rateLimit.ts#parseTrustProxy. false (default) is correct for local
  // dev / anvil demo stack with no reverse proxy in front.
  const app = Fastify({ logger: false, trustProxy: config.trustProxy ?? false })

  // ─── Rate limiting: POST /order + DELETE /order/:id ONLY ───────────────────
  //
  // These are the only routes that mutate shared state (the order book /
  // nonce set) on behalf of an arbitrary caller, so they're the only ones
  // worth throttling per client IP. GET /orderbook is polled continuously by
  // both the frontend and the matching-engine (backend/matching-engine/src/
  // client.ts's HttpOrderBookClient — every pollIntervalMs, default 500ms)
  // and GET /health is a liveness probe; neither must ever be rate-limited.
  // The matching engine never calls POST /order or DELETE /order/:id itself
  // — it reads GET /orderbook and removes filled/pruned orders directly in
  // Redis (backend/matching-engine/src/settler.ts's sorted-set removal), so
  // it never contends with real users for this limiter's bucket.
  //
  // Registered with `global: true` so POST /order and DELETE /order/:id
  // (which set no per-route config) fall back to this single top-level
  // limiter/store — i.e. ONE shared bucket per client IP across both routes,
  // per the spec. GET /orderbook, GET /health, and the OPTIONS preflight
  // opt out explicitly via `config: { rateLimit: false }` (see `noRateLimit`
  // below).
  //
  // Storage: @fastify/rate-limit's default in-memory LRU store — fine for a
  // single instance. Running multiple replicas (e.g. Railway horizontal
  // scale) would need the plugin's `redis` store option so buckets are
  // shared across instances instead of one-per-process.
  const orderRateLimitMax = config.orderRateLimitMax ?? DEFAULT_ORDER_RATE_LIMIT_MAX
  const orderRateLimitWindowMs = config.orderRateLimitWindowMs ?? DEFAULT_ORDER_RATE_LIMIT_WINDOW_MS
  const rateLimitEnabled = orderRateLimitMax > 0

  if (rateLimitEnabled) {
    // Awaited (not fire-and-forget): the plugin's `onRoute` hook — which is
    // what makes `global: true` apply the limiter to the routes declared
    // below, and what makes each route's `config.rateLimit` mean anything —
    // is only attached once this plugin's own async setup has run. Routes
    // declared before that would see neither behavior (avvio only guarantees
    // relative ordering between queued `.register()` calls of unawaited
    // plugins/routes, not that an unawaited plugin has finished loading by
    // the time a subsequent synchronous `.get()/.post()` call runs).
    await app.register(rateLimit, {
      global: true,
      max: orderRateLimitMax,
      timeWindow: orderRateLimitWindowMs,
      // Match the shape of the app's other 4xx bodies ({ error: string }) so
      // the frontend's existing `body?.error` handling (TradePanel.tsx)
      // displays this sensibly too. `statusCode` is required for Fastify's
      // default error handler to actually reply 429 instead of 500 — it
      // rides along in the body as a harmless extra field.
      errorResponseBuilder: (_request, context) => ({
        statusCode: 429,
        error: `Too many requests — retry in ${Math.ceil(context.ttl / 1000)}s`,
      }),
    })
  }

  // Route option to opt a route out of the global rate limiter above. Safe
  // to pass even when rate limiting is disabled (no plugin registered ⇒ no
  // onRoute hook reads it ⇒ no-op).
  const noRateLimit = { config: { rateLimit: false as const } }

  // CORS — this API is consumed directly by the frontend's browser fetch()
  // calls; without an ACAO header, GET /orderbook succeeds for server-side/curl
  // callers but is silently blocked by the browser's CORS check, leaving the
  // UI's order book empty even though the data is there. No credentials are
  // used, so a bare wildcard is safe and remains the default.
  //
  // config.corsOrigins (from CORS_ORIGINS env, see main.ts) lets an operator
  // lock this down to an exact allow-list instead: unset/empty ⇒ unchanged
  // wildcard behaviour; otherwise only an exact Origin match gets echoed back
  // (with Vary: Origin) and a non-matching/missing Origin gets no ACAO header
  // at all.
  app.addHook('onSend', async (request, reply, payload) => {
    const allowList = config.corsOrigins
    if (!allowList || allowList.length === 0) {
      reply.header('Access-Control-Allow-Origin', '*')
    } else {
      const origin = request.headers.origin
      if (origin && allowList.includes(origin.trim().replace(/\/+$/, ''))) {
        reply.header('Access-Control-Allow-Origin', origin)
        reply.header('Vary', 'Origin')
      }
      // no match (or no Origin header) ⇒ omit Access-Control-Allow-Origin entirely
    }
    reply.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
    reply.header('Access-Control-Allow-Headers', 'Content-Type')
    return payload
  })
  app.options('*', noRateLimit, async (_request, reply) => {
    reply.status(204).send()
  })

  // GET /health — liveness + cheap store (Redis) reachability check. Never
  // touches the chain/RPC — chain reads are best-effort and the public RPC is
  // flaky, so health must not depend on it (see runChainPreFilter's fail-open).
  app.get('/health', noRateLimit, async (_request, reply) => {
    // Fee snapshots are in-memory reads (no RPC) — safe to include unconditionally.
    // Top-level `fee` is mstr's (back-compat: uptime.yml + older readers); the
    // per-market view is under `markets`.
    const all = directory.list()
    const primary = directory.bySlug(LEGACY_SLUG) ?? all[0]
    const fee = feeSnapshotOf(primary ? servicesFor(primary) : {}, config)
    const markets: Record<string, { fee: { bps: number; source: string } }> = {}
    for (const m of all) {
      const snap = feeSnapshotOf(servicesFor(m), config)
      markets[m.slug] = { fee: { bps: snap.feeBps, source: snap.source } }
    }
    const registry = directory.status()
    try {
      const reachable = await store.ping()
      if (!reachable) {
        return reply.status(503).send({ status: 'error', error: 'Store unreachable', fee, registry, markets })
      }
      return reply.status(200).send({ status: 'ok', fee, registry, markets })
    } catch (err) {
      console.error('[order-book-server] /health store check failed:', err)
      return reply.status(503).send({ status: 'error', error: 'Store unreachable', fee, registry, markets })
    }
  })

  // GET /markets — the directory (registry or legacy). Never rate-limited.
  app.get('/markets', noRateLimit, async () => ({
    mode: directory.mode,
    markets: directory.list().map(m => ({
      slug: m.slug,
      entityName: m.entityName,
      entityType: m.entityType,
      active: m.active,
      creditMarket: m.creditMarket,
      yesToken: m.yesToken,
      noToken: m.noToken,
      clobSettlement: m.clobSettlement,
      oracleRouter: m.oracleRouter,
      liquidationEngine: m.liquidationEngine,
      startBlock: m.startBlock.toString(),
    })),
  }))

  // POST /order — validate EIP-712 sig, add to order book
  app.post<{ Body: OrderWire }>('/order', async (request, reply) => {
    const body = request.body

    if (
      !body?.maker || !body.tokenIn || !body.tokenOut ||
      body.amountIn == null || body.minAmountOut == null ||
      body.expiry == null || body.nonce == null || !body.signature
    ) {
      return reply.status(400).send({ error: 'Missing required fields' })
    }

    let order: Order
    try {
      order = wireToOrder(body)
    } catch {
      return reply.status(400).send({ error: 'Invalid numeric fields' })
    }

    // ── Market routing + token validation (before any signature/chain work) ──
    // Exactly one leg must be USDC; the other must be a YES/NO token of a known
    // market. The market (and with it the EIP-712 domain, fee rate and chain
    // pre-filter) is derived from that token — never trusted from the body.
    const inIsUsdc = order.tokenIn.toLowerCase() === usdc
    const outIsUsdc = order.tokenOut.toLowerCase() === usdc
    if (inIsUsdc === outIsUsdc) {
      return reply.status(400).send({ error: 'InvalidTokenPair' })
    }
    const outcomeToken = (inIsUsdc ? order.tokenOut : order.tokenIn).toLowerCase()
    const market = directory.byAddress(outcomeToken)
    if (!market) {
      return reply.status(400).send({ error: 'UnknownMarket' })
    }
    if (outcomeToken !== market.yesToken.toLowerCase() && outcomeToken !== market.noToken.toLowerCase()) {
      return reply.status(400).send({ error: 'InvalidTokenPair' })
    }
    if (!market.active) {
      return reply.status(400).send({ error: 'MarketInactive' })
    }
    const svc = servicesFor(market)

    const nowSecs = BigInt(Math.floor(Date.now() / 1000))
    if (order.expiry <= nowSecs) {
      return reply.status(400).send({ error: 'Order expired' })
    }

    if (await store.isNonceUsed(market.slug, order.maker, order.nonce.toString())) {
      return reply.status(400).send({ error: 'Nonce already used' })
    }

    const valid = await verifyOrderSignature(
      order,
      config.chainId,
      market.clobSettlement as Address,
    )
    if (!valid) {
      return reply.status(400).send({ error: 'Invalid signature' })
    }

    const feeNow = feeBpsOf(svc, config)
    if (svc.chainReader) {
      const preFilter = await runChainPreFilter(order, market, feeNow, svc.chainReader)
      if (preFilter.rejected) {
        return reply.status(preFilter.status).send(preFilter.body)
      }
    }

    const orderId = uuidv4()
    const side = deriveSide(body, config.usdcAddress)
    const price = derivePrice(body, config.usdcAddress, market, feeNow)

    const stored: StoredOrder = { ...body, id: orderId, market: market.slug, side, price, timestamp: Date.now() }
    await store.saveOrder(orderId, stored)
    await store.markNonceUsed(market.slug, order.maker, order.nonce.toString())
    if (side === 'bid') {
      await store.addBid(market.slug, orderId, price)
    } else {
      await store.addAsk(market.slug, orderId, price)
    }

    return reply.status(201).send({ orderId, market: market.slug })
  })

  // DELETE /order/:id — cancel order; maker + signature passed in headers
  // X-Maker: <address>   X-Signature: <EIP-712 CancelOrder sig>
  app.delete<{ Params: { id: string } }>('/order/:id', async (request, reply) => {
    const { id } = request.params
    const maker = request.headers['x-maker'] as string | undefined
    const signature = request.headers['x-signature'] as string | undefined

    if (!maker || !signature) {
      return reply.status(400).send({ error: 'Missing X-Maker or X-Signature header' })
    }

    const order = await store.getOrder(id)
    if (!order) {
      return reply.status(404).send({ error: 'Order not found' })
    }

    if (order.maker.toLowerCase() !== maker.toLowerCase()) {
      return reply.status(403).send({ error: 'Not the order maker' })
    }

    // Pre-migration orders carry no `market` — they are mstr's.
    const orderMarket = directory.bySlug(order.market ?? LEGACY_SLUG)
    if (!orderMarket) {
      return reply.status(400).send({ error: 'UnknownMarket' })
    }

    const valid = await verifyCancelSignature(
      maker as Address,
      id,
      signature as Hex,
      config.chainId,
      orderMarket.clobSettlement as Address,
    )
    if (!valid) {
      return reply.status(400).send({ error: 'Invalid cancellation signature' })
    }

    await store.deleteOrder(id)
    if (order.side === 'bid') await store.removeBid(orderMarket.slug, id)
    else await store.removeAsk(orderMarket.slug, id)

    return reply.status(200).send({ cancelled: true })
  })

  // GET /orderbook — sorted bids (high→low) and asks (low→high). Polled
  // continuously (frontend + matching-engine) — never rate-limited.
  app.get<{ Querystring: { market?: string } }>('/orderbook', noRateLimit, async (request, reply) => {
    // No `market` param => mstr (back-compat alias for pre-multi-market callers).
    const slug = request.query.market ?? LEGACY_SLUG
    if (!directory.bySlug(slug)) {
      return reply.status(404).send({ error: 'UnknownMarket' })
    }
    const [bidIds, askIds] = await Promise.all([store.getBidIds(slug), store.getAskIds(slug)])

    const [bidResults, askResults] = await Promise.all([
      Promise.all(bidIds.map(id => store.getOrder(id))),
      Promise.all(askIds.map(id => store.getOrder(id))),
    ])

    return {
      bids: bidResults.filter((o): o is StoredOrder => o !== null),
      asks: askResults.filter((o): o is StoredOrder => o !== null),
    }
  })

  return app
}
