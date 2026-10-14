import { base, baseSepolia } from 'wagmi/chains'

// Chain selection. NEXT_PUBLIC_CHAIN_ID picks Base mainnet (8453) or Base Sepolia
// (84532, the default — unset env behaves exactly as before mainnet plumbing existed).
// Anything else is a config error, surfaced loudly by assertChainConfig().
export const SUPPORTED_CHAIN_IDS = [84532, 8453] as const
export type ActiveChainId = (typeof SUPPORTED_CHAIN_IDS)[number]

const rawChainId = process.env.NEXT_PUBLIC_CHAIN_ID?.trim()
const parsed = rawChainId ? Number(rawChainId) : 84532

export const ACTIVE_CHAIN_ID = parsed as ActiveChainId
export const ACTIVE_CHAIN = ACTIVE_CHAIN_ID === 8453 ? base : baseSepolia

/** Circle native USDC on Base mainnet. Fixed (not env-overridable) on 8453. */
export const USDC_BASE_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as `0x${string}`

const ZERO = '0x0000000000000000000000000000000000000000'

/**
 * Pure validator (returns a message, or null when OK). On mainnet there must be NO silent
 * fallback to testnet/zero addresses: either a market registry is configured, or every
 * legacy single-market address is set.
 */
export function chainConfigError(env: {
  chainId: number
  registry?: string
  legacy: Record<string, string | undefined>
}): string | null {
  if (!(SUPPORTED_CHAIN_IDS as readonly number[]).includes(env.chainId)) {
    return `NEXT_PUBLIC_CHAIN_ID=${env.chainId} is not supported (use 84532 or 8453).`
  }
  if (env.chainId !== 8453) return null
  if (env.registry && env.registry !== ZERO) return null
  const missing = Object.entries(env.legacy)
    .filter(([, v]) => !v || v === ZERO)
    .map(([k]) => k)
  return missing.length
    ? 'NEXT_PUBLIC_CHAIN_ID=8453 (Base mainnet) but no mainnet contracts are configured: set ' +
        'NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS (or all of: ' + missing.join(', ') + '). ' +
        'Refusing to fall back to testnet addresses.'
    : null
}

export function assertChainConfig(): void {
  const err = chainConfigError({
    chainId: parsed,
    registry: process.env.NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS,
    legacy: {
      NEXT_PUBLIC_CREDIT_MARKET_ADDRESS: process.env.NEXT_PUBLIC_CREDIT_MARKET_ADDRESS,
      NEXT_PUBLIC_YES_TOKEN_ADDRESS: process.env.NEXT_PUBLIC_YES_TOKEN_ADDRESS,
      NEXT_PUBLIC_NO_TOKEN_ADDRESS: process.env.NEXT_PUBLIC_NO_TOKEN_ADDRESS,
      NEXT_PUBLIC_CLOB_SETTLEMENT_ADDRESS: process.env.NEXT_PUBLIC_CLOB_SETTLEMENT_ADDRESS,
      NEXT_PUBLIC_ORACLE_ROUTER_ADDRESS: process.env.NEXT_PUBLIC_ORACLE_ROUTER_ADDRESS,
      NEXT_PUBLIC_LIQUIDATION_ENGINE_ADDRESS: process.env.NEXT_PUBLIC_LIQUIDATION_ENGINE_ADDRESS,
    },
  })
  if (err) throw new Error(`[config] ${err}`)
}
