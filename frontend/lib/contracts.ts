// Base Sepolia USDC (Circle official): https://developers.circle.com/stablecoins/docs/usdc-on-test-networks
export const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as `0x${string}`

// Populated by deploy scripts after contracts are deployed to Base Sepolia
export const CONTRACT_ADDRESSES = {
  84532: {
    creditMarket:   '0x0000000000000000000000000000000000000000' as `0x${string}`,
    yesToken:       '0x0000000000000000000000000000000000000000' as `0x${string}`,
    noToken:        '0x0000000000000000000000000000000000000000' as `0x${string}`,
    clobSettlement: '0x0000000000000000000000000000000000000000' as `0x${string}`,
    oracleRouter:   '0x0000000000000000000000000000000000000000' as `0x${string}`,
    usdc:           USDC_BASE_SEPOLIA,
  },
} as const

export type SupportedChainId = keyof typeof CONTRACT_ADDRESSES
