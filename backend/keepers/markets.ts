// Keeper-side wiring for the multi-market registry (shared by all three keeper
// services). The registry reader itself is registry.ts (canonical copy in
// backend/shared — do not edit here).
//
//   MARKET_REGISTRY_ADDRESS  set  -> registry mode: every market comes from
//                                    MarketRegistry.allMarkets(), refreshed every
//                                    REGISTRY_REFRESH_MS (default 60000).
//   MARKET_REGISTRY_ADDRESS  unset -> LEGACY mode: exactly one market, `mstr`,
//                                    from the pre-multi-market single-set env vars
//                                    (hosted Railway services run this until cutover).

import fs from 'fs'
import path from 'path'
import { MarketDirectory, legacyMarket, MARKET_REGISTRY_ABI } from './registry'
import type { Hex, IRegistryClient, MarketInfo, LegacyMarketEnv } from './registry'

export const DEFAULT_DEPLOYMENTS_PATH = path.join(
  __dirname, '..', '..', 'contracts', 'deployments', 'base-sepolia.json',
)

/** Lenient read of the local-dev deployments file ({} if absent — hosted images don't ship it). */
function readDeployments(deploymentsPath: string): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(deploymentsPath, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * The legacy single market (`mstr`) from env, with the deployments file as a
 * local-dev fallback for any address env doesn't set. Returns null unless the
 * CreditMarket and YES token resolve. startBlock = HOLDER_INDEX_FROM_BLOCK.
 */
export function legacyMarketFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  deploymentsPath: string = DEFAULT_DEPLOYMENTS_PATH,
): MarketInfo | null {
  const needFile = !env.CREDIT_MARKET_ADDRESS || !env.YES_TOKEN_ADDRESS
    || !env.LIQUIDATION_ENGINE_ADDRESS || !env.CLOB_SETTLEMENT_ADDRESS
  const file = needFile ? readDeployments(deploymentsPath) : {}
  const legacyEnv: LegacyMarketEnv = {
    creditMarket:      env.CREDIT_MARKET_ADDRESS || file.creditMarket,
    yesToken:          env.YES_TOKEN_ADDRESS || file.yesToken,
    noToken:           env.NO_TOKEN_ADDRESS || file.noToken,
    clobSettlement:    env.CLOB_SETTLEMENT_ADDRESS || file.clobSettlement,
    oracleRouter:      env.ORACLE_ROUTER_ADDRESS || file.oracleRouter,
    liquidationEngine: env.LIQUIDATION_ENGINE_ADDRESS || file.liquidationEngine,
    startBlock:        /^\d+$/.test(env.HOLDER_INDEX_FROM_BLOCK?.trim() ?? '') ? env.HOLDER_INDEX_FROM_BLOCK!.trim() : undefined,
  }
  return legacyMarket(legacyEnv)
}

export interface BuildDirectoryOptions {
  client: IRegistryClient
  env?: NodeJS.ProcessEnv
  deploymentsPath?: string
  /** Overrides legacyMarketFromEnv (services that already resolved/validated their addresses). */
  legacy?: MarketInfo | null
  log?: (msg: string) => void
}

export function buildDirectory(opts: BuildDirectoryOptions): MarketDirectory {
  const env = opts.env ?? process.env
  const registryAddress = env.MARKET_REGISTRY_ADDRESS?.trim()
  const refreshMs = env.REGISTRY_REFRESH_MS ? parseInt(env.REGISTRY_REFRESH_MS) : undefined
  return new MarketDirectory({
    client: opts.client,
    registryAddress: registryAddress ? (registryAddress as Hex) : undefined,
    legacy: opts.legacy !== undefined ? opts.legacy : legacyMarketFromEnv(env, opts.deploymentsPath),
    refreshMs: refreshMs && refreshMs > 0 ? refreshMs : undefined,
    log: opts.log,
  })
}

/** Shared registry addresses (registry mode only): the USDC token and the shared InsuranceFund. */
export async function readRegistryShared(
  client: { readContract(args: { address: Hex; abi: typeof MARKET_REGISTRY_ABI; functionName: 'usdc' | 'insuranceFund' }): Promise<unknown> },
  registry: Hex,
): Promise<{ usdc: Hex; insuranceFund: Hex }> {
  const [usdc, insuranceFund] = await Promise.all([
    client.readContract({ address: registry, abi: MARKET_REGISTRY_ABI, functionName: 'usdc' }),
    client.readContract({ address: registry, abi: MARKET_REGISTRY_ABI, functionName: 'insuranceFund' }),
  ])
  return { usdc: usdc as Hex, insuranceFund: insuranceFund as Hex }
}
