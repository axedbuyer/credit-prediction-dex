'use client'

import { useReadContracts } from 'wagmi'
import Link from 'next/link'
import { formatUnits } from 'viem'

// -- ABIs --------------------------------------------------------------------

const CREDIT_MARKET_V1B_ABI = [
  {
    name: 'costBasis',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'equity',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'int256' }],
  },
  {
    name: 'pnl',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'int256' }],
  },
  {
    name: 'breakevenMark',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'epochsToExpire',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'isSeizable',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

// -- Dev test values ---------------------------------------------------------
// Pass one of these as the `_dev` prop to PositionCard to preview UI states
// without a deployed contract.

export type DevValues = {
  costBasis?:      bigint
  equity?:         bigint
  pnl?:            bigint
  breakevenMark?:  bigint
  epochsToExpire?: bigint
  isSeizable?:     boolean
  yesBalance?:     bigint
  noBalance?:      bigint
}

export const DEV_YES_HEALTHY: DevValues = {
  costBasis:      234000000000000000n,  // 23.4%
  equity:         191000000000000000n,  // 19.1%
  pnl:            -43000000000000000n,  // -4.3%
  breakevenMark:  260000000000000000n,  // 26.0%
  epochsToExpire: 142n,                 // >30 → green
  isSeizable:     false,
  yesBalance:     500_000000n,
  noBalance:      0n,
}

export const DEV_YES_AMBER:    DevValues = { ...DEV_YES_HEALTHY, epochsToExpire: 14n }
export const DEV_YES_RED:      DevValues = { ...DEV_YES_HEALTHY, epochsToExpire: 3n }
export const DEV_YES_SEIZABLE: DevValues = {
  ...DEV_YES_HEALTHY,
  epochsToExpire: 0n,
  isSeizable:     true,
}

export const DEV_NO_HEALTHY: DevValues = {
  costBasis:     766000000000000000n,  // 76.6%
  equity:        812000000000000000n,  // 81.2%
  pnl:            46000000000000000n,  // +4.6%
  breakevenMark: 720000000000000000n,  // 72.0%
  epochsToExpire: 0n,
  isSeizable:    false,
  yesBalance:    0n,
  noBalance:     500_000000n,
}

// -- Types -------------------------------------------------------------------

type TxStatus = 'idle' | 'pending' | 'success' | 'error'

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const

interface PositionCardProps {
  side: 'YES' | 'NO'
  userAddress: `0x${string}`
  creditMarketAddress: `0x${string}`
  yesTokenAddress:     `0x${string}`
  noTokenAddress:      `0x${string}`
  creditEventConfirmed?: boolean
  onSell: () => void
  onSettle?: () => void
  settleStatus?: TxStatus
  _dev?: DevValues
}

// -- Formatters --------------------------------------------------------------

function wadToPct(wad: bigint | undefined): string {
  if (wad === undefined) return '—'
  // wad is 18-decimal WAD: 1e18 = 100%.
  // Divide by 1e15 to get tenths-of-percent, then divide by 10 for display.
  const tenths = Number(wad / 10n ** 15n)
  return (tenths / 10).toFixed(1) + '%'
}

function signedWadToPct(wad: bigint | undefined): { text: string; neg: boolean } {
  if (wad === undefined) return { text: '—', neg: false }
  const neg = wad < 0n
  const abs = neg ? -wad : wad
  const tenths = Number(abs / 10n ** 15n)
  return { text: (neg ? '−' : '+') + (tenths / 10).toFixed(1) + '%', neg }
}

function tokenAmount(raw: bigint | undefined, decimals = 6): string {
  if (raw === undefined) return '—'
  return parseFloat(formatUnits(raw, decimals)).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function epochsColorClass(epochs: bigint | undefined): string {
  if (epochs === undefined) return 'text-slate-400'
  if (epochs > 30n)  return 'text-emerald-400'
  if (epochs >= 7n)  return 'text-amber-400'
  return 'text-red-400'
}

// -- Component ---------------------------------------------------------------

export function PositionCard({
  side,
  userAddress,
  creditMarketAddress,
  yesTokenAddress,
  noTokenAddress,
  creditEventConfirmed = false,
  onSell,
  onSettle,
  settleStatus = 'idle',
  _dev,
}: PositionCardProps) {
  const isYES = side === 'YES'

  const { data } = useReadContracts({
    contracts: [
      { address: creditMarketAddress, abi: CREDIT_MARKET_V1B_ABI, functionName: 'costBasis',      args: [userAddress] },
      { address: creditMarketAddress, abi: CREDIT_MARKET_V1B_ABI, functionName: 'equity',         args: [userAddress] },
      { address: creditMarketAddress, abi: CREDIT_MARKET_V1B_ABI, functionName: 'pnl',            args: [userAddress] },
      { address: creditMarketAddress, abi: CREDIT_MARKET_V1B_ABI, functionName: 'breakevenMark',  args: [userAddress] },
      { address: creditMarketAddress, abi: CREDIT_MARKET_V1B_ABI, functionName: 'epochsToExpire', args: [userAddress] },
      { address: creditMarketAddress, abi: CREDIT_MARKET_V1B_ABI, functionName: 'isSeizable',     args: [userAddress] },
      { address: yesTokenAddress,     abi: ERC20_ABI,             functionName: 'balanceOf',       args: [userAddress] },
      { address: noTokenAddress,      abi: ERC20_ABI,             functionName: 'balanceOf',       args: [userAddress] },
    ],
    query: { enabled: !_dev && userAddress !== ZERO_ADDR },
  })

  const costBasis      = (_dev?.costBasis      ?? data?.[0]?.result) as bigint | undefined
  const equity         = (_dev?.equity         ?? data?.[1]?.result) as bigint | undefined
  const pnlRaw         = (_dev?.pnl            ?? data?.[2]?.result) as bigint | undefined
  const breakevenMark  = (_dev?.breakevenMark  ?? data?.[3]?.result) as bigint | undefined
  const epochsToExpire = (_dev?.epochsToExpire ?? data?.[4]?.result) as bigint | undefined
  const isSeizable     = (_dev?.isSeizable     ?? data?.[5]?.result) as boolean | undefined
  const yesBalance     = (_dev?.yesBalance     ?? data?.[6]?.result) as bigint | undefined
  const noBalance      = (_dev?.noBalance      ?? data?.[7]?.result) as bigint | undefined

  const balance = isYES ? yesBalance : noBalance
  const { text: pnlText, neg: pnlNeg } = signedWadToPct(pnlRaw)
  const pnlColor = pnlRaw === undefined ? 'text-slate-100' : pnlNeg ? 'text-red-400' : 'text-emerald-400'

  const borderColor = isYES ? 'border-emerald-900/50' : 'border-red-900/50'
  const labelColor  = isYES ? 'text-emerald-400' : 'text-red-400'

  return (
    <div className={`rounded-lg border ${borderColor} bg-slate-900 p-5`}>

      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <span className={`text-xs font-semibold uppercase tracking-wider ${labelColor}`}>
          {side} Position
        </span>
        {isYES && creditEventConfirmed && (
          <span className="rounded-full border border-emerald-700/50 bg-emerald-900/60 px-2 py-0.5 text-xs text-emerald-300">
            Credit event confirmed
          </span>
        )}
      </div>

      {/* Liquidatable banner (YES only) */}
      {isYES && isSeizable && (
        <div className="mb-4 flex items-center justify-between rounded-lg border border-red-700/60 bg-red-900/30 px-3 py-2.5">
          <p className="text-xs font-semibold text-red-400">
            This position is liquidatable now
          </p>
          <Link
            href="/liquidate"
            className="ml-3 shrink-0 text-xs font-semibold text-red-300 underline hover:text-red-200"
          >
            View →
          </Link>
        </div>
      )}

      {/* Metrics grid */}
      <div className="grid grid-cols-2 gap-x-6 gap-y-3 mb-4">
        <Stat label="Cost basis"     value={wadToPct(costBasis)} />
        <Stat label="Current equity" value={wadToPct(equity)} />
        <Stat label="P&L"            value={pnlText}              colorClass={pnlColor} />
        <Stat label="Breakeven"      value={wadToPct(breakevenMark)} />
        <Stat label="Tokens"         value={`${tokenAmount(balance)} ${side}`} />
      </div>

      {/* Days remaining — YES only, prominent */}
      {isYES && (
        <div className="mb-5 rounded-lg border border-slate-800 bg-slate-800/40 px-4 py-3">
          <p className="mb-0.5 text-xs text-slate-500">Days remaining</p>
          <p className={`text-lg font-bold ${epochsColorClass(epochsToExpire)}`}>
            {epochsToExpire !== undefined ? `${epochsToExpire} days` : '—'}
          </p>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={onSell}
          className="flex-1 rounded-lg border border-slate-700 bg-slate-800 py-2 text-sm font-medium text-slate-200 hover:bg-slate-700 transition-colors"
        >
          Sell {side}
        </button>
        {isYES && creditEventConfirmed && (
          <button
            onClick={onSettle}
            disabled={settleStatus === 'pending'}
            className="flex-1 rounded-lg bg-emerald-600 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50 transition-colors"
          >
            {settleStatus === 'pending' ? 'Settling…' : 'Settle YES for USDC'}
          </button>
        )}
      </div>

      {settleStatus === 'success' && (
        <p className="mt-2 text-xs text-emerald-400">YES tokens settled for USDC.</p>
      )}
    </div>
  )
}

// -- Stat sub-component ------------------------------------------------------

function Stat({
  label,
  value,
  colorClass = 'text-slate-100',
}: {
  label: string
  value: string
  colorClass?: string
}) {
  return (
    <div>
      <p className="mb-0.5 text-xs text-slate-500">{label}</p>
      <p className={`text-sm font-semibold ${colorClass}`}>{value}</p>
    </div>
  )
}
