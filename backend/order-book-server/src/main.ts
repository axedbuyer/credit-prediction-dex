import path from 'path'
import fs from 'fs'
import { buildApp } from './server'
import { RedisOrderStore, createRedisClient } from './orderbook'
import { createChainReader } from './chain'
import type { AppConfig } from './types'
import type { IChainReader } from './chain'
import type { Address } from 'viem'

// CREDIT_MARKET_ADDRESS / YES_TOKEN_ADDRESS env vars take precedence over the
// deployments file, mirroring backend/keepers/*.ts.
function loadDeployments(): { creditMarket?: string; yesToken?: string } {
  try {
    // Path: src/ → order-book-server/ → backend/ → project root → contracts/deployments/
    const deploymentsPath = path.join(
      __dirname, '..', '..', '..', 'contracts', 'deployments', 'base-sepolia.json',
    )
    return JSON.parse(fs.readFileSync(deploymentsPath, 'utf8')) as {
      creditMarket?: string
      yesToken?: string
    }
  } catch {
    return {}
  }
}

async function main() {
  const deployments = loadDeployments()

  const config: AppConfig = {
    // Base Sepolia USDC (official Circle deployment)
    usdcAddress: process.env.USDC_ADDRESS ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    yesTokenAddress: process.env.YES_TOKEN_ADDRESS ?? deployments.yesToken ?? '0x0000000000000000000000000000000000000001',
    noTokenAddress: process.env.NO_TOKEN_ADDRESS ?? '0x0000000000000000000000000000000000000002',
    clobSettlementAddress: process.env.CLOB_SETTLEMENT_ADDRESS ?? '0x0000000000000000000000000000000000000003',
    creditMarketAddress: process.env.CREDIT_MARKET_ADDRESS ?? deployments.creditMarket,
    // CHAIN_ID env override lets a local Anvil node (31337) work without code changes.
    chainId: parseInt(process.env.CHAIN_ID ?? '84532'),
    port: parseInt(process.env.PORT ?? '3001'),
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL,
    // Must mirror CLOBSettlement.feeBps on-chain. Overstating is safe (NO bids
    // sort slightly low, marginal crosses are skipped); understating produces
    // deterministic SlippageExceeded reverts that the settler prunes.
    feeBps: parseInt(process.env.FEE_BPS ?? '50'),
  }

  const redis = createRedisClient(
    process.env.REDIS_HOST ?? 'localhost',
    parseInt(process.env.REDIS_PORT ?? '6379'),
  )

  await redis.connect()

  const store = new RedisOrderStore(redis)

  // Chain reader is optional — the freeze/funding pre-filter is UX guidance only
  // (the on-chain require/revert is the backstop). Without an RPC URL and a
  // known CreditMarket address, skip it entirely rather than block the server.
  let chainReader: IChainReader | undefined
  if (config.rpcUrl && config.creditMarketAddress) {
    chainReader = createChainReader({
      rpcUrl: config.rpcUrl,
      chainId: config.chainId,
      creditMarketAddress: config.creditMarketAddress as Address,
      yesTokenAddress: config.yesTokenAddress as Address,
    })
  } else {
    console.warn(
      '[order-book-server] chain reader disabled (missing BASE_SEPOLIA_RPC_URL or ' +
      'CREDIT_MARKET_ADDRESS/deployments file) — freeze/funding pre-filter checks skipped',
    )
  }

  const app = buildApp(store, config, chainReader)

  const address = await app.listen({ port: config.port ?? 3001, host: '0.0.0.0' })
  console.log(`Order book server listening at ${address}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
