'use client'

import { useState, useCallback } from 'react'
import Link from 'next/link'
import { formatUnits } from 'viem'
import { useWriteContract, useChainId } from 'wagmi'
import { waitForTransactionReceipt } from '@wagmi/core'
import { wagmiConfig } from '@/lib/wagmi'
import { CONTRACT_ADDRESSES, type SupportedChainId } from '@/lib/contracts'

// ── ABI ───────────────────────────────────────────────────────────────────────

const LIQUIDATION_ENGINE_ABI = [
  {
    name: 'claim',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [],
  },
] as const

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ClaimablePosition {
  user: string         // holder address
  notional: string     // YES token balance, 6-decimal, as bigint string
  frozenFunding: string // total funding owed at flag time, 6-decimal
  tokenValue: string   // Q × currentMark / WAD, 6-decimal
  claimPrice: string   // min(frozenFunding, tokenValue), 6-decimal
  tailCase: boolean    // frozenFunding > tokenValue — insurance fund tops up
  frozen: boolean      // true when motionPending — claim() will revert
  frozenReason?: string
}

type TxStatus = 'idle' | 'pending' | 'success' | 'error'

// ── Formatters ────────────────────────────────────────────────────────────────

function usdc(raw: string): string {
  return `$${parseFloat(formatUnits(BigInt(raw), 6)).toFixed(2)}`
}

function tokenQty(raw: string): string {
  return parseFloat(formatUnits(BigInt(raw), 6)).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

// ── Component ─────────────────────────────────────────────────────────────────

interface LiquidationCardProps {
  position: ClaimablePosition
}

export function LiquidationCard({ position }: LiquidationCardProps) {
  const chainId = useChainId()
  const addrs = CONTRACT_ADDRESSES[chainId as SupportedChainId] ?? CONTRACT_ADDRESSES[84532]
  const { writeContractAsync } = useWriteContract()

  const [txStatus, setTxStatus] = useState<TxStatus>('idle')
  const [txError, setTxError] = useState('')

  const tokenValueBig = BigInt(position.tokenValue)
  const claimPriceBig = BigInt(position.claimPrice)
  const profitBig = tokenValueBig > claimPriceBig ? tokenValueBig - claimPriceBig : 0n

  const isFrozen = position.frozen
  const isDisabled = isFrozen || txStatus === 'pending' || txStatus === 'success'

  const handleClaim = useCallback(async () => {
    setTxStatus('pending')
    setTxError('')
    try {
      const hash = await writeContractAsync({
        address: addrs.liquidationEngine,
        abi: LIQUIDATION_ENGINE_ABI,
        functionName: 'claim',
        args: [position.user as `0x${string}`],
      })
      await waitForTransactionReceipt(wagmiConfig, { hash })
      setTxStatus('success')
    } catch (e: unknown) {
      setTxStatus('error')
      const msg = e instanceof Error ? e.message : 'Transaction failed'
      setTxError(
        msg.includes('User rejected') || msg.includes('4001')
          ? 'Rejected'
          : msg.slice(0, 100),
      )
    }
  }, [writeContractAsync, addrs, position.user])

  const outerClass = isFrozen
    ? 'rounded-lg border border-slate-700 bg-slate-900/40 p-5 opacity-60'
    : 'rounded-lg border border-amber-900/50 bg-slate-900 p-5'

  return (
    <div className={outerClass}>
      {/* Frozen banner */}
      {isFrozen && (
        <div className="mb-3 rounded-md border border-slate-600 bg-slate-800 px-3 py-2">
          <span className="text-xs font-semibold text-slate-400">
            Frozen — credit event under review
          </span>
        </div>
      )}

      {/* Header row */}
      <div className="mb-4 flex items-center justify-between">
        <span className="font-mono text-xs text-slate-400">{shortAddr(position.user)}</span>
        {position.tailCase && (
          <span className="rounded-full border border-blue-700/50 bg-blue-900/40 px-2 py-0.5 text-[10px] font-medium text-blue-300">
            Backstopped by insurance fund
          </span>
        )}
      </div>

      {/* Metrics grid */}
      <div className="mb-5 grid grid-cols-2 gap-x-6 gap-y-3">
        <Stat label="YES tokens"     value={`${tokenQty(position.notional)} YES`} />
        <Stat label="Token value"    value={usdc(position.tokenValue)} />
        <Stat label="Claim price (P)" value={usdc(position.claimPrice)} colorClass="text-amber-300" />
        {!position.tailCase && (
          <Stat label="Est. profit (before resale)" value={`+${usdc(profitBig.toString())}`} colorClass="text-emerald-400" />
        )}
      </div>

      {/* Claim button / success */}
      {txStatus !== 'success' ? (
        <button
          onClick={handleClaim}
          disabled={isDisabled}
          className="w-full rounded-lg bg-amber-600 py-2.5 text-sm font-semibold text-white hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
        >
          {txStatus === 'pending'
            ? 'Claiming…'
            : `Claim — pay ${usdc(position.claimPrice)}`}
        </button>
      ) : (
        <div className="rounded-lg border border-emerald-800 bg-emerald-900/30 p-4">
          <p className="mb-1 text-sm font-semibold text-emerald-300">
            YES position claimed successfully.
          </p>
          <p className="mb-3 text-xs text-emerald-400/80">
            The YES tokens are now in your wallet. Resell on the market to capture
            your ~{usdc(profitBig.toString())} profit.
          </p>
          <Link
            href="/market/mstr"
            className="inline-block rounded-lg border border-emerald-700 bg-emerald-800 px-4 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-700 transition-colors"
          >
            Go to trade panel to sell YES →
          </Link>
        </div>
      )}

      {txStatus === 'error' && txError && (
        <p className="mt-2 text-xs text-red-400">{txError}</p>
      )}
    </div>
  )
}

// ── Stat sub-component ────────────────────────────────────────────────────────

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

// ── Dev fixtures ──────────────────────────────────────────────────────────────

export const DEV_POSITIONS: ClaimablePosition[] = [
  {
    user: '0xDeAdBeEf00000000000000000000000000000001',
    notional:      '500000000',   // 500 YES tokens (6-dec)
    frozenFunding: '14550000',    // $14.55
    tokenValue:    '15000000',    // $15.00 (mark ≈ 3%)
    claimPrice:    '14550000',    // normal case: P = frozenFunding
    tailCase: false,
    frozen: false,
  },
  {
    user: '0xDeAdBeEf00000000000000000000000000000002',
    notional:      '1000000000',  // 1,000 YES tokens
    frozenFunding: '31200000',    // $31.20 (tail: funded > mark)
    tokenValue:    '30000000',    // $30.00
    claimPrice:    '30000000',    // tail case: P = tokenValue
    tailCase: true,
    frozen: false,
  },
  {
    user: '0xDeAdBeEf00000000000000000000000000000003',
    notional:      '200000000',   // 200 YES tokens
    frozenFunding: '5820000',     // $5.82
    tokenValue:    '6000000',     // $6.00
    claimPrice:    '5820000',
    tailCase: false,
    frozen: true,
    frozenReason: 'credit event under review',
  },
]
