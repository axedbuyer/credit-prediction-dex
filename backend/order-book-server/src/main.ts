import path from 'path'
import fs from 'fs'
import { buildApp } from './server'
import { RedisOrderStore, createRedisClient } from './orderbook'
import { createPublicClient, http } from 'viem'
import { createChainReader, resolveViemChain } from './chain'
import { MarketDirectory, type IRegistryClient, type Hex } from './registry'
import { MarketServicesRegistry } from './marketServices'
import { migrateLegacyKeys, type MigrationRedis } from './migration'
import { createFeeSource, parseEnvFeeBps, envFeeBpsWasSet, parseFeeRefreshMs } from './feeSource'
import type { AppConfig } from './types'
import type { IChainReader } from './chain'
import type { Address } from 'viem'
import { parseOrderRateLimitMax, parseOrderRateLimitWindowMs, parseTrustProxy } from './rateLimit'
import { installShutdownHandlers } from './shutdown'

// CREDIT_MARKET_ADDRESS / YES_TOKEN_ADDRESS / CLOB_SETTLEMENT_ADDRESS env vars
// take precedence over the deployments file, mirroring backend/keepers/*.ts.
function loadDeployments(): { creditMarket?: string; yesToken?: string; clobSettlement?: string } {
  try {
    // Path: src/ → order-book-server/ → backend/ → project root → contracts/deployments/
    const deploymentsPath = path.join(
      __dirname, '..', '..', '..', 'contracts', 'deployments', 'base-sepolia.json',
    )
    return JSON.parse(fs.readFileSync(deploymentsPath, 'utf8')) as {
      creditMarket?: string
      yesToken?: string
      clobSettlement?: string
    }
  } catch {
    return {}
  }
}

// CORS_ORIGINS: comma-separated allow-list of exact origins (e.g.
// "https://credit-prediction-dex.vercel.app,http://localhost:3000"). Unset,
// empty, or "*" preserves the wildcard default — see buildApp's CORS hook.
function parseCorsOrigins(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === '*') return undefined
  const origins = trimmed.split(',')
    .map(o => o.trim().replace(/\/+$/, ''))
    .filter(o => o.length > 0)
  return origins.length > 0 ? origins : undefined
}

async function main() {
  const deployments = loadDeployments()

  // CLOB_SETTLEMENT_ADDRESS env takes precedence over the deployments file,
  // same pattern as creditMarketAddress/yesTokenAddress below. Only treated as
  // "configured" (see clobSettlementConfigured, used to gate the live fee
  // reader) when one of those two actually resolves — the hardcoded
  // placeholder fallback below must never be mistaken for a real address.
  const clobSettlementAddress = process.env.CLOB_SETTLEMENT_ADDRESS ?? deployments.clobSettlement
  const clobSettlementConfigured = Boolean(clobSettlementAddress)

  const config: AppConfig = {
    // Base Sepolia USDC (official Circle deployment)
    usdcAddress: process.env.USDC_ADDRESS ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    yesTokenAddress: process.env.YES_TOKEN_ADDRESS ?? deployments.yesToken ?? '0x0000000000000000000000000000000000000001',
    noTokenAddress: process.env.NO_TOKEN_ADDRESS ?? '0x0000000000000000000000000000000000000002',
    clobSettlementAddress: clobSettlementAddress ?? '0x0000000000000000000000000000000000000003',
    creditMarketAddress: process.env.CREDIT_MARKET_ADDRESS ?? deployments.creditMarket,
    // CHAIN_ID env override lets a local Anvil node (31337) work without code changes.
    chainId: parseInt(process.env.CHAIN_ID ?? '84532'),
    port: parseInt(process.env.PORT ?? '3001'),
    rpcUrl: process.env.BASE_SEPOLIA_RPC_URL,
    // STATIC fallback only — see feeSource below, which is the live rate
    // server.ts actually reads per-request. Kept here for any caller that
    // still inspects config.feeBps directly (defensive; buildApp prefers
    // config.feeSource when both are set).
    feeBps: parseEnvFeeBps(process.env.FEE_BPS),
    corsOrigins: parseCorsOrigins(process.env.CORS_ORIGINS),
    // Rate limiting for POST /order + DELETE /order/:id (see src/rateLimit.ts).
    orderRateLimitMax: parseOrderRateLimitMax(process.env.ORDER_RATE_LIMIT_MAX),
    orderRateLimitWindowMs: parseOrderRateLimitWindowMs(process.env.ORDER_RATE_LIMIT_WINDOW_MS),
    // TRUST_PROXY=2 on Railway (two proxy hops, measured) — see parseTrustProxy's
    // doc comment for why a hop count beats bare "true".
    trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
  }

  const redis = createRedisClient(
    process.env.REDIS_HOST ?? 'localhost',
    parseInt(process.env.REDIS_PORT ?? '6379'),
  )

  // Live, on-chain-backed fee rate (src/feeSource.ts) — the source of truth
  // for feeBps is CLOBSettlement.feeBps() on-chain when RPC + the contract
  // address are configured; FEE_BPS becomes a fallback (startup RPC failure,
  // or no chain configured at all — e.g. local demo/tests). `start()` is
  // bounded by an internal per-read timeout, so it can't hang server startup.
  const feeSource = createFeeSource({
    rpcUrl: clobSettlementConfigured ? config.rpcUrl : undefined,
    chainId: config.chainId,
    clobSettlementAddress: clobSettlementConfigured ? (clobSettlementAddress as Address) : undefined,
    envFeeBps: config.feeBps ?? 50,
    envFeeBpsWasSet: envFeeBpsWasSet(process.env.FEE_BPS),
    refreshMs: parseFeeRefreshMs(process.env.FEE_REFRESH_MS),
  })
  config.feeSource = feeSource

  await Promise.all([redis.connect(), feeSource.start()])

  // One-time key migration (single-market -> per-slug keys); idempotent, flag-guarded.
  await migrateLegacyKeys(redis as unknown as MigrationRedis)

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

  // Registry mode (MARKET_REGISTRY_ADDRESS set): the market list, per-market chain
  // readers and per-market fee sources come from the on-chain MarketRegistry.
  // Legacy mode (unset): buildApp builds a one-market (`mstr`) directory from
  // `config` and keeps using the single-set chainReader/feeSource above — exactly
  // the pre-multi-market behaviour.
  const registryAddress = process.env.MARKET_REGISTRY_ADDRESS as Hex | undefined
  let directory: MarketDirectory | undefined
  let marketServices: MarketServicesRegistry | undefined
  let syncTimer: ReturnType<typeof setInterval> | undefined
  if (registryAddress) {
    if (!config.rpcUrl) throw new Error('MARKET_REGISTRY_ADDRESS requires BASE_SEPOLIA_RPC_URL')
    const registryClient = createPublicClient({
      chain: resolveViemChain(config.chainId, config.rpcUrl),
      transport: http(config.rpcUrl),
    })
    const refreshMs = parseInt(process.env.REGISTRY_REFRESH_MS ?? '60000')
    directory = new MarketDirectory({
      client: registryClient as unknown as IRegistryClient,
      registryAddress,
      refreshMs,
    })
    await directory.start()
    marketServices = new MarketServicesRegistry({
      rpcUrl: config.rpcUrl,
      chainId: config.chainId,
      envFeeBps: config.feeBps ?? 50,
      envFeeBpsWasSet: envFeeBpsWasSet(process.env.FEE_BPS),
      feeRefreshMs: parseFeeRefreshMs(process.env.FEE_REFRESH_MS),
    })
    await marketServices.sync(directory.list())
    // Pick up markets added to the registry at runtime (fee source + reader).
    syncTimer = setInterval(() => { void marketServices!.sync(directory!.list()) }, refreshMs)
    syncTimer.unref?.()
    console.log(`[order-book-server] registry mode: ${directory.list().map(m => m.slug).join(', ') || '(no markets yet)'}`)
  }

  const app = await buildApp(
    store, config, chainReader,
    directory && marketServices
      ? { directory, services: (m) => marketServices!.get(m) }
      : {},
  )

  const address = await app.listen({ port: config.port ?? 3001, host: '0.0.0.0' })
  console.log(`Order book server listening at ${address}`)

  // Graceful shutdown: every Railway redeploy sends SIGTERM to this process
  // (it's PID 1 under the exec-form CMD) — without this, an in-flight
  // POST /order or DELETE /order/:id is killed mid-request. Order matters:
  // stop accepting new HTTP work and let in-flight requests finish first
  // (app.close()), THEN release the resources those requests might still be
  // using (feeSource's refresh timer, the Redis connection).
  installShutdownHandlers('order-book-server', [
    { name: 'fastify', run: () => app.close() },
    {
      name: 'registry',
      run: async () => {
        if (syncTimer) clearInterval(syncTimer)
        directory?.stop()
        marketServices?.stop()
      },
    },
    { name: 'fee-source', run: async () => { feeSource.stop() } },
    {
      name: 'redis',
      run: async () => {
        try {
          await redis.quit()
        } catch (err) {
          console.error('[order-book-server] redis.quit() failed, forcing disconnect:', err)
          redis.disconnect()
        }
      },
    },
  ])
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
