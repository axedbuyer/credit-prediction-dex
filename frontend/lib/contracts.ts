// Base Sepolia USDC (Circle official): https://developers.circle.com/stablecoins/docs/usdc-on-test-networks
export const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`

// Populated by deploy scripts after contracts are deployed to Base Sepolia.
// Each address is env-overridable so a local demo stack (see scripts/demo/) can
// point the frontend at a fresh anvil deployment via frontend/.env.local without
// touching this file.
export const CONTRACT_ADDRESSES = {
  84532: {
    creditMarket:        (process.env.NEXT_PUBLIC_CREDIT_MARKET_ADDRESS      ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
    yesToken:            (process.env.NEXT_PUBLIC_YES_TOKEN_ADDRESS          ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
    noToken:             (process.env.NEXT_PUBLIC_NO_TOKEN_ADDRESS           ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
    clobSettlement:      (process.env.NEXT_PUBLIC_CLOB_SETTLEMENT_ADDRESS    ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
    oracleRouter:        (process.env.NEXT_PUBLIC_ORACLE_ROUTER_ADDRESS      ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
    liquidationEngine:   (process.env.NEXT_PUBLIC_LIQUIDATION_ENGINE_ADDRESS ?? '0x0000000000000000000000000000000000000000') as `0x${string}`,
    usdc:                (process.env.NEXT_PUBLIC_USDC_ADDRESS               ?? USDC_BASE_SEPOLIA) as `0x${string}`,
  },
} as const

export type SupportedChainId = keyof typeof CONTRACT_ADDRESSES
