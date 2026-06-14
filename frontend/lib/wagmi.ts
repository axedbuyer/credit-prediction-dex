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
    appName: 'Credit Prediction DEX',
    projectId,
  }
)

export const wagmiConfig = createConfig({
  chains: [baseSepolia],
  connectors,
  transports: {
    [baseSepolia.id]: http(),
  },
  ssr: true,
})
