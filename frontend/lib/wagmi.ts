import { createConfig, http } from 'wagmi'
import { baseSepolia } from 'wagmi/chains'
import { connectorsForWallets } from '@rainbow-me/rainbowkit'
import { metaMaskWallet, coinbaseWallet } from '@rainbow-me/rainbowkit/wallets'

const rawProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID

let projectId: string
if (rawProjectId) {
  projectId = rawProjectId
} else if (process.env.NODE_ENV === 'production') {
  // Shipping without a real project ID silently breaks WalletConnect (the QR/deep-link
  // connector) in production — fail loudly at config creation instead of shipping it broken.
  throw new Error(
    'NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set. Get a project ID from ' +
    'https://cloud.walletconnect.com and set it before building for production.',
  )
} else {
  console.warn(
    'NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set — using a placeholder for local ' +
    'development. WalletConnect will not work; set this env var before deploying.',
  )
  projectId = 'placeholder'
}

const connectors = connectorsForWallets(
  [
    {
      groupName: 'Recommended',
      wallets: [metaMaskWallet, coinbaseWallet],
    },
  ],
  {
    appName: 'Pari',
    projectId,
  }
)

export const wagmiConfig = createConfig({
  chains: [baseSepolia],
  connectors,
  transports: {
    [baseSepolia.id]: http(process.env.NEXT_PUBLIC_RPC_URL),
  },
  ssr: true,
  // wagmi batches concurrent contract reads (useReadContract/useReadContracts)
  // into a single Multicall3 call by default. Real Base Sepolia/mainnet have
  // Multicall3 predeployed at its canonical address, but a bare local `anvil`
  // chain (scripts/demo's target) does not — the batched eth_call there hits
  // an address with no code, silently returns empty data, and every read in
  // the batch comes back undefined (UI shows blank/"—" values even though
  // each read works fine individually). Disable batching so every read goes
  // out as its own eth_call, which works on both local anvil and real chains.
  batch: { multicall: false },
})
