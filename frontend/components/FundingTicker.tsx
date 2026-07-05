'use client'

import { useChainId, useReadContract } from 'wagmi'
import { CONTRACT_ADDRESSES, type SupportedChainId } from '@/lib/contracts'
import { CREDIT_MARKET_ABI } from '@/lib/creditMarketAbi'

// wad (1e18-scaled fraction, 1e18 == 100%) -> percent, as a float.
// Bigint division happens BEFORE the cast to Number so we never round-trip the
// full 1e18-scale value through a JS double (currentMark can sit well past
// Number.MAX_SAFE_INTEGER at that scale) — six decimal digits of resolution
// survive the conversion, far more than the UI ever displays.
function wadToPercent(wad: bigint | undefined): number | undefined {
  if (wad === undefined) return undefined
  return Number(wad / 10n ** 10n) / 1e6
}

export function FundingTicker() {
  const chainId = useChainId()
  const contracts = CONTRACT_ADDRESSES[chainId as SupportedChainId] ?? CONTRACT_ADDRESSES[84532]

  // Two individual reads rather than a single batched useReadContracts —
  // batching goes through a multicall3 contract, which real Base Sepolia/
  // mainnet have at the canonical address but a bare local `anvil` chain
  // (as used by scripts/demo) does not predeploy. On such a chain the
  // multicall call reverts with no fallback, so both values would come
  // back silently undefined ("—" placeholders in the ticker) even though
  // the underlying contract reads are perfectly healthy individually.
  const { data: currentMark } = useReadContract({
    address: contracts.creditMarket,
    abi: CREDIT_MARKET_ABI,
    functionName: 'currentMark',
    query: { refetchInterval: 10_000 },
  })
  const { data: cumFunding } = useReadContract({
    address: contracts.creditMarket,
    abi: CREDIT_MARKET_ABI,
    functionName: 'cumulativeFundingPerYES',
    query: { refetchInterval: 10_000 },
  })

  const annualPct  = wadToPercent(currentMark)
  const dailyPct   = annualPct !== undefined ? annualPct / 365 : undefined
  const cumCents   = wadToPercent(cumFunding)

  return (
    <div className="pari-b-card w-full">
      <p className="pari-b-card__header">Daily Carry</p>

      <p className="pari-b-card__value font-serif tabular">
        {dailyPct !== undefined ? `${dailyPct.toFixed(3)}%/day` : '—'}
      </p>

      <p className="pari-b-card__sub uppercase tracking-wide">
        Upbet pays Downbet ·{' '}
        {annualPct !== undefined ? `${annualPct.toFixed(1)}% annualized` : '— annualized'}
      </p>

      <p className="pari-b-card__sub mt-1 uppercase tracking-wide">
        {cumCents !== undefined
          ? `${cumCents.toFixed(1)}¢ accrued per $1 since inception`
          : '— accrued per $1 since inception'}
      </p>
    </div>
  )
}
