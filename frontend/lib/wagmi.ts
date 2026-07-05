import { createConfig, http } from 'wagmi'
import { baseSepolia } from 'wagmi/chains'
import { connectorsForWallets } from '@rainbow-me/rainbowkit'
import { metaMaskWallet, coinbaseWallet } from '@rainbow-me/rainbowkit/wallets'

const projectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? 'placeholder'

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
