'use client'

import { useChainId, useReadContract } from 'wagmi'
import { CONTRACT_ADDRESSES, type SupportedChainId } from '@/lib/contracts'
import { FEE_BPS as FEE_BPS_FALLBACK } from '@/lib/feeMath'

// Minimal ABI fragment — feeBps is a public uint256 state var on CLOBSettlement
// (contracts/src/CLOBSettlement.sol ~line 65), auto-generating a no-arg getter.
const CLOB_SETTLEMENT_FEE_ABI = [
  {
    name: 'feeBps',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

export type FeeBpsSource = 'chain' | 'env-fallback'

export interface UseFeeBpsResult {
  feeBps: bigint
  source: FeeBpsSource
  isLoading: boolean
}

// Live on-chain trading-fee rate. CLOBSettlement.feeBps is admin-editable
// (setFeeConfig), so the build-time NEXT_PUBLIC_FEE_BPS env value (feeMath.ts
// FEE_BPS) can drift from it — a stale env value mis-sizes the gross,
// fee-inclusive amountIn signed on Downbet (NO) buys, which then reverts
// SlippageExceeded on-chain against the fee-free seller's net minAmountOut.
//
// Polls every 60s so an admin fee change is picked up without a redeploy.
// Returns the chain value once loaded; while loading or on any read error,
// falls back to the env-based FEE_BPS so previews still render a number —
// callers that need certainty (e.g. signing a Downbet buy) must check
// `source === 'chain'` themselves rather than trusting the returned feeBps.
export function useFeeBps(): UseFeeBpsResult {
  const chainId = useChainId()
  const contracts = CONTRACT_ADDRESSES[chainId as SupportedChainId] ?? CONTRACT_ADDRESSES[84532]

  const { data, isLoading, isError } = useReadContract({
    address: contracts.clobSettlement,
    abi: CLOB_SETTLEMENT_FEE_ABI,
    functionName: 'feeBps',
    query: { refetchInterval: 60_000 },
  })

  if (data !== undefined && !isError) {
    return { feeBps: data, source: 'chain', isLoading: false }
  }
  return { feeBps: FEE_BPS_FALLBACK, source: 'env-fallback', isLoading }
}
