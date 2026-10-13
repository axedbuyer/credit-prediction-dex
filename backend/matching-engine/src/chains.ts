import { defineChain } from 'viem'
import { base, baseSepolia } from 'viem/chains'

// Chain selection shared by every call site in this package. 8453 = Base mainnet,
// 84532 = Base Sepolia (default everywhere); any other id (e.g. 31337 anvil) gets
// a custom "Local" chain pointed at rpcUrl — identical to the pre-mainnet behaviour.
export function chainFor(chainId: number, rpcUrl: string) {
  if (chainId === base.id) return base
  if (chainId === baseSepolia.id) return baseSepolia
  return defineChain({
    id: chainId,
    name: 'Local',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  })
}

// Generic RPC_URL takes precedence; BASE_SEPOLIA_RPC_URL keeps working as-is.
export function rpcUrlFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.RPC_URL?.trim() || env.BASE_SEPOLIA_RPC_URL || undefined
}
