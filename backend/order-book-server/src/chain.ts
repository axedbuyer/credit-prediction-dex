import { createPublicClient, defineChain, http } from 'viem'
import { baseSepolia } from 'viem/chains'
import type { Address } from 'viem'

// ─── CreditMarket ABI (minimal — read-only pre-filter surface) ───────────────

export const CREDIT_MARKET_ABI = [
  {
    name: 'claimable',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'previewFunding',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [
      { name: 'user', type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'isYes', type: 'bool' },
    ],
    outputs: [{ name: 'delta', type: 'int256' }],
  },
  {
    name: 'fundingDebt',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

export const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

// ─── Narrow client interface (real viem public client satisfies this) ────────

export interface IPublicClient {
  readContract(args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args?: readonly unknown[]
  }): Promise<unknown>
}

// ─── IChainReader — injectable interface consumed by server.ts ───────────────
//
// Deliberately narrow: only what the order-server pre-filter needs. All methods
// are best-effort reads — callers must treat any rejection as "unknown" and
// fail open (see "Off-chain pre-filter" in root CLAUDE.md — this is UX guidance
// only, the on-chain `require`/revert is the backstop).

export interface IChainReader {
  isClaimable(maker: Address): Promise<boolean>
  previewFunding(maker: Address, amount: bigint, isYes: boolean): Promise<bigint>
  fundingDebt(maker: Address): Promise<bigint>
  yesBalanceOf(maker: Address): Promise<bigint>
}

export interface ChainReaderConfig {
  creditMarketAddress: Address
  yesTokenAddress: Address
}

// ─── viem-backed implementation ───────────────────────────────────────────────

export class ViemChainReader implements IChainReader {
  constructor(
    private readonly publicClient: IPublicClient,
    private readonly config: ChainReaderConfig,
  ) {}

  async isClaimable(maker: Address): Promise<boolean> {
    return await this.publicClient.readContract({
      address:      this.config.creditMarketAddress,
      abi:          CREDIT_MARKET_ABI,
      functionName: 'claimable',
      args:         [maker],
    }) as boolean
  }

  async previewFunding(maker: Address, amount: bigint, isYes: boolean): Promise<bigint> {
    return await this.publicClient.readContract({
      address:      this.config.creditMarketAddress,
      abi:          CREDIT_MARKET_ABI,
      functionName: 'previewFunding',
      args:         [maker, amount, isYes],
    }) as bigint
  }

  async fundingDebt(maker: Address): Promise<bigint> {
    return await this.publicClient.readContract({
      address:      this.config.creditMarketAddress,
      abi:          CREDIT_MARKET_ABI,
      functionName: 'fundingDebt',
      args:         [maker],
    }) as bigint
  }

  async yesBalanceOf(maker: Address): Promise<bigint> {
    return await this.publicClient.readContract({
      address:      this.config.yesTokenAddress,
      abi:          ERC20_ABI,
      functionName: 'balanceOf',
      args:         [maker],
    }) as bigint
  }
}

// ─── Production factory ───────────────────────────────────────────────────────

export interface ChainReaderInit {
  rpcUrl: string
  chainId: number
  creditMarketAddress: Address
  yesTokenAddress: Address
}

export function createChainReader(init: ChainReaderInit): IChainReader {
  const transport = http(init.rpcUrl)

  // CHAIN_ID env override lets a local Anvil node (31337) work without code changes.
  const chain = init.chainId === baseSepolia.id
    ? baseSepolia
    : defineChain({
        id:             init.chainId,
        name:           'Local',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls:        { default: { http: [init.rpcUrl] } },
      })

  const publicClient = createPublicClient({ chain, transport })

  return new ViemChainReader(publicClient as unknown as IPublicClient, {
    creditMarketAddress: init.creditMarketAddress,
    yesTokenAddress:     init.yesTokenAddress,
  })
}
