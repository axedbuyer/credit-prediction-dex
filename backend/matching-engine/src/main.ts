import { HttpOrderBookClient } from './client'
import { MatchingEngine } from './engine'
import type { MatchingEngineConfig } from './types'

const config: MatchingEngineConfig = {
  yesTokenAddress: process.env.YES_TOKEN_ADDRESS ?? '0x0000000000000000000000000000000000000001',
  noTokenAddress:  process.env.NO_TOKEN_ADDRESS  ?? '0x0000000000000000000000000000000000000002',
  usdcAddress:     process.env.USDC_ADDRESS      ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  pollIntervalMs:  parseInt(process.env.POLL_INTERVAL_MS ?? '500'),
}

const orderBookUrl = process.env.ORDER_BOOK_URL ?? 'http://localhost:3001'
const client = new HttpOrderBookClient(orderBookUrl)
const engine = new MatchingEngine(client, config)

engine.on('matched', (maker, taker) => {
  // Task 12 will hook here and call CLOBSettlement.verifyAndSettle()
  console.log(
    `[match] maker=${maker.id} (ask @ ${maker.price}) <-> taker=${taker.id} (bid @ ${taker.price})`,
  )
})

engine.start()
console.log(`Matching engine polling ${orderBookUrl}/orderbook every ${config.pollIntervalMs ?? 500}ms`)
