import { buildApp } from './server'
import { RedisOrderStore, createRedisClient } from './orderbook'
import type { AppConfig } from './types'

async function main() {
  const config: AppConfig = {
    // Base Sepolia USDC (official Circle deployment)
    usdcAddress: process.env.USDC_ADDRESS ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    yesTokenAddress: process.env.YES_TOKEN_ADDRESS ?? '0x0000000000000000000000000000000000000001',
    noTokenAddress: process.env.NO_TOKEN_ADDRESS ?? '0x0000000000000000000000000000000000000002',
    clobSettlementAddress: process.env.CLOB_SETTLEMENT_ADDRESS ?? '0x0000000000000000000000000000000000000003',
    chainId: parseInt(process.env.CHAIN_ID ?? '84532'),
    port: parseInt(process.env.PORT ?? '3001'),
  }

  const redis = createRedisClient(
    process.env.REDIS_HOST ?? 'localhost',
    parseInt(process.env.REDIS_PORT ?? '6379'),
  )

  await redis.connect()

  const store = new RedisOrderStore(redis)
  const app = buildApp(store, config)

  const address = await app.listen({ port: config.port ?? 3001, host: '0.0.0.0' })
  console.log(`Order book server listening at ${address}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
