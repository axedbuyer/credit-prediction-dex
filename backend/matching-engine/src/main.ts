import { HttpOrderBookClient } from './client'
import { MatchingEngine } from './engine'
import { createSettler } from './settler'
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
  console.log(
    `[match] maker=${maker.id} (ask @ ${maker.price}) <-> taker=${taker.id} (bid @ ${taker.price})`,
  )
})

// The settler subscribes to 'matched' in its constructor and submits
// CLOBSettlement.verifyAndSettle() on-chain. Without credentials, matches are
// only logged (useful for dry-running the engine against a book).
if (process.env.SETTLER_PRIVATE_KEY && process.env.BASE_SEPOLIA_RPC_URL) {
  createSettler(engine)
  console.log('[settler] wired — matched pairs will be settled on-chain')
} else {
  console.warn('[settler] SETTLER_PRIVATE_KEY or BASE_SEPOLIA_RPC_URL not set — matches will be logged only')
}

engine.start()
console.log(`Matching engine polling ${orderBookUrl}/orderbook every ${config.pollIntervalMs ?? 500}ms`)
