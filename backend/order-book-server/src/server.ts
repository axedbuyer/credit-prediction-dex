import Fastify, { type FastifyInstance } from 'fastify'
import { v4 as uuidv4 } from 'uuid'
import type { Address, Hex } from 'viem'
import type { AppConfig, Order, OrderWire, StoredOrder } from './types'
import type { OrderStore } from './orderbook'
import type { IChainReader } from './chain'
import { verifyOrderSignature, verifyCancelSignature } from './validation'
import { tradeFee, netNoBidProceeds, minGrossForNet } from './fee'

// ─── Helpers ──────────────────────────────────────────────────────────────────

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
function derivePrice(wire: OrderWire, config: AppConfig): number {
  const isUsdcIn = wire.tokenIn.toLowerCase() === config.usdcAddress.toLowerCase()
  const amtIn = BigInt(wire.amountIn)
  const minOut = BigInt(wire.minAmountOut)
  if (isUsdcIn) {
    if (minOut === 0n) return 0
    const isNoBid = wire.tokenOut.toLowerCase() === config.noTokenAddress.toLowerCase()
    const usdcLeg = isNoBid
      ? netNoBidProceeds(minOut, amtIn, BigInt(config.feeBps ?? 0))
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
  config: AppConfig,
  chainReader: IChainReader,
): Promise<PreFilterResult> {
  try {
    if (await chainReader.isClaimable(order.maker)) {
      return { rejected: true, status: 400, body: { error: 'PositionFrozen' } }
    }

    const isYesSell = order.tokenIn.toLowerCase() === config.yesTokenAddress.toLowerCase()
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
      const feeBps = BigInt(config.feeBps ?? 0)
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

export function buildApp(store: OrderStore, config: AppConfig, chainReader?: IChainReader): FastifyInstance {
  const app = Fastify({ logger: false })

  // Permissive CORS — this is a local-first dev/demo API (no auth, no cookies)
  // consumed directly by the frontend's browser fetch() calls. Without this,
  // GET /orderbook succeeds for server-side/curl callers but is silently
  // blocked by the browser's CORS check, leaving the UI's order book empty
  // even though the data is there. No credentials are used, so a wildcard
  // origin is safe here.
  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('Access-Control-Allow-Origin', '*')
    reply.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
    reply.header('Access-Control-Allow-Headers', 'Content-Type')
    return payload
  })
  app.options('*', async (_request, reply) => {
    reply.status(204).send()
  })

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

    const nowSecs = BigInt(Math.floor(Date.now() / 1000))
    if (order.expiry <= nowSecs) {
      return reply.status(400).send({ error: 'Order expired' })
    }

    if (await store.isNonceUsed(order.maker, order.nonce.toString())) {
      return reply.status(400).send({ error: 'Nonce already used' })
    }

    const valid = await verifyOrderSignature(
      order,
      config.chainId,
      config.clobSettlementAddress as Address,
    )
    if (!valid) {
      return reply.status(400).send({ error: 'Invalid signature' })
    }

    if (chainReader) {
      const preFilter = await runChainPreFilter(order, config, chainReader)
      if (preFilter.rejected) {
        return reply.status(preFilter.status).send(preFilter.body)
      }
    }

    const orderId = uuidv4()
    const side = deriveSide(body, config.usdcAddress)
    const price = derivePrice(body, config)

    const stored: StoredOrder = { ...body, id: orderId, side, price, timestamp: Date.now() }
    await store.saveOrder(orderId, stored)
    await store.markNonceUsed(order.maker, order.nonce.toString())
    if (side === 'bid') {
      await store.addBid(orderId, price)
    } else {
      await store.addAsk(orderId, price)
    }

    return reply.status(201).send({ orderId })
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

    const valid = await verifyCancelSignature(
      maker as Address,
      id,
      signature as Hex,
      config.chainId,
      config.clobSettlementAddress as Address,
    )
    if (!valid) {
      return reply.status(400).send({ error: 'Invalid cancellation signature' })
    }

    await store.deleteOrder(id)
    if (order.side === 'bid') await store.removeBid(id)
    else await store.removeAsk(id)

    return reply.status(200).send({ cancelled: true })
  })

  // GET /orderbook — sorted bids (high→low) and asks (low→high)
  app.get('/orderbook', async () => {
    const [bidIds, askIds] = await Promise.all([store.getBidIds(), store.getAskIds()])

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
