import path from 'path'
import fs from 'fs'
import { createPublicClient, defineChain, http } from 'viem'
import { baseSepolia } from 'viem/chains'
import { HttpOrderBookClient } from './client'
import { MatchingEngine } from './engine'
import { createSettler } from './settler'
import { createShutdownHandler } from './shutdown'
import { MarketDirectory, legacyMarket, type Hex, type IRegistryClient } from './registry'
import type { CreatedSettler } from './settler'
import type { MatchingEngineConfig } from './types'
import type { Address } from 'viem'

const ZERO = '0x0000000000000000000000000000000000000000'

// Contract addresses: env vars take precedence; the checked-in deployments JSON
// is a local-dev fallback only (it does not exist inside containers). Legacy
// mode only — registry mode gets everything from the MarketRegistry.
function loadDeployments(): { clobSettlement?: string; creditMarket?: string; yesToken?: string; usdc?: string } {
  try {
    // Path: src/ → matching-engine/ → backend/ → project root → contracts/deployments/
    const p = path.join(__dirname, '..', '..', '..', 'contracts', 'deployments', 'base-sepolia.json')
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return {}
  }
}

const usdcAddress = (process.env.USDC_ADDRESS ?? loadDeployments().usdc ?? '0x036CbD53842c5426634e7929541eC2318f3dCF7e') as Address

const config: MatchingEngineConfig = {
  yesTokenAddress: process.env.YES_TOKEN_ADDRESS ?? '0x0000000000000000000000000000000000000001',
  noTokenAddress:  process.env.NO_TOKEN_ADDRESS  ?? '0x0000000000000000000000000000000000000002',
  usdcAddress,
  pollIntervalMs:  parseInt(process.env.POLL_INTERVAL_MS ?? '500'),
}

// Registry mode (MARKET_REGISTRY_ADDRESS set): markets come from the on-chain
// MarketRegistry, refreshed every REGISTRY_REFRESH_MS. Legacy mode (unset): one
// market, `mstr`, built from today's single-set env vars — unchanged behaviour.
const registryAddress = process.env.MARKET_REGISTRY_ADDRESS as Hex | undefined
let directory: MarketDirectory
if (registryAddress) {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL
  if (!rpcUrl) throw new Error('MARKET_REGISTRY_ADDRESS requires BASE_SEPOLIA_RPC_URL')
  const chainId = parseInt(process.env.CHAIN_ID ?? String(baseSepolia.id))
  const chain = chainId === baseSepolia.id
    ? baseSepolia
    : defineChain({
        id: chainId, name: 'Local',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      })
  directory = new MarketDirectory({
    client: createPublicClient({ chain, transport: http(rpcUrl) }) as unknown as IRegistryClient,
    registryAddress,
    refreshMs: parseInt(process.env.REGISTRY_REFRESH_MS ?? '60000'),
  })
} else {
  const d = loadDeployments()
  if (process.env.SETTLER_PRIVATE_KEY && !(process.env.CLOB_SETTLEMENT_ADDRESS ?? d.clobSettlement)) {
    // Same hard failure the settler had before multi-market.
    throw new Error('settler: CLOB_SETTLEMENT_ADDRESS is not set and the deployments fallback has none')
  }
  directory = new MarketDirectory({
    legacy: legacyMarket({
      creditMarket:   process.env.CREDIT_MARKET_ADDRESS   ?? d.creditMarket ?? ZERO,
      yesToken:       config.yesTokenAddress,
      noToken:        config.noTokenAddress,
      clobSettlement: process.env.CLOB_SETTLEMENT_ADDRESS ?? d.clobSettlement,
    }),
  })
}
config.directory = directory

const orderBookUrl = process.env.ORDER_BOOK_URL ?? 'http://localhost:3001'
const client = new HttpOrderBookClient(orderBookUrl)
const engine = new MatchingEngine(client, config)

engine.on('matched', (maker, taker) => {
  console.log(
    `[match] market=${maker.market ?? 'mstr'} maker=${maker.id} (ask @ ${maker.price}) <-> taker=${taker.id} (bid @ ${taker.price})`,
  )
})

async function start() {
  await directory.start()
  console.log(
    `[matching-engine] ${directory.mode} mode — markets: ` +
    (directory.list().map(m => `${m.slug}${m.active ? '' : '(inactive)'}`).join(', ') || '(none yet)'),
  )

  // The settler subscribes to 'matched' in its constructor and submits
  // CLOBSettlement.verifyAndSettle() on-chain (to the pair's own market's CLOB).
  // Without credentials, matches are only logged (useful for dry-running the
  // engine against a book) — in that mode there's no settlement queue or Redis
  // connection for shutdown to drain.
  let created: CreatedSettler | undefined
  if (process.env.SETTLER_PRIVATE_KEY && process.env.BASE_SEPOLIA_RPC_URL) {
    created = createSettler(engine, directory, usdcAddress)
    console.log('[settler] wired — matched pairs will be settled on-chain')
  } else {
    console.warn('[settler] SETTLER_PRIVATE_KEY or BASE_SEPOLIA_RPC_URL not set — matches will be logged only')
  }

  engine.start()
  console.log(`Matching engine polling ${orderBookUrl}/orderbook every ${config.pollIntervalMs ?? 500}ms`)

  // ─── Graceful shutdown ──────────────────────────────────────────────────────
  // Every git push redeploys this service (e.g. on Railway) by signalling the
  // running process — without this, a redeploy can land mid-settlement: after a
  // verifyAndSettle tx is submitted but before its receipt is processed and the
  // filled orders are pruned from Redis. Draining here (stop polling → await the
  // in-flight cycle → await the settler's queue → quit Redis) closes that window;
  // see src/shutdown.ts for the sequence and SHUTDOWN_TIMEOUT_MS for the bound.
  const shutdownHandler = createShutdownHandler({
    log: (msg) => console.log(msg),
    stopEngine: async () => { directory.stop(); await engine.stop() },
    drainSettler: created ? () => created!.settler.whenIdle() : undefined,
    describePending: created ? () => created!.settler.describePending() : undefined,
    closeRedis: created ? () => created!.redis.quit().then(() => {}) : undefined,
    timeoutMs: parseInt(process.env.SHUTDOWN_TIMEOUT_MS ?? '25000'),
  })

  process.on('SIGTERM', () => shutdownHandler('SIGTERM'))
  process.on('SIGINT', () => shutdownHandler('SIGINT'))
}

start().catch(err => {
  console.error(err)
  process.exit(1)
})
