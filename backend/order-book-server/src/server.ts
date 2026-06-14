import Fastify, { type FastifyInstance } from 'fastify'
import { v4 as uuidv4 } from 'uuid'
import type { Address, Hex } from 'viem'
import type { AppConfig, Order, OrderWire, StoredOrder } from './types'
import type { OrderStore } from './orderbook'
import { verifyOrderSignature, verifyCancelSignature } from './validation'

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
 */
function derivePrice(wire: OrderWire, usdcAddress: string): number {
  const isUsdcIn = wire.tokenIn.toLowerCase() === usdcAddress.toLowerCase()
  const amtIn = Number(BigInt(wire.amountIn))
  const minOut = Number(BigInt(wire.minAmountOut))
  if (isUsdcIn) return minOut === 0 ? 0 : amtIn / minOut
  return amtIn === 0 ? 0 : minOut / amtIn
}

function deriveSide(wire: OrderWire, usdcAddress: string): 'bid' | 'ask' {
  return wire.tokenIn.toLowerCase() === usdcAddress.toLowerCase() ? 'bid' : 'ask'
}

// ─── App factory ──────────────────────────────────────────────────────────────

export function buildApp(store: OrderStore, config: AppConfig): FastifyInstance {
  const app = Fastify({ logger: false })

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

    const orderId = uuidv4()
    const side = deriveSide(body, config.usdcAddress)
    const price = derivePrice(body, config.usdcAddress)

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
