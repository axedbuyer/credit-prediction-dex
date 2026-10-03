'use client'

import { useState, useCallback } from 'react'
import Link from 'next/link'
import { formatUnits } from 'viem'
import { useAccount, useWriteContract, usePublicClient } from 'wagmi'
import { waitForTransactionReceipt } from '@wagmi/core'
import { wagmiConfig } from '@/lib/wagmi'
import { ERC20_ABI } from '@/lib/creditMarketAbi'
import type { Market } from '@/lib/markets'

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
  market?: string      // market slug (absent on a pre-multi-market keeper → treated as 'mstr')
  creditMarket?: string
  liquidationEngine?: string
  user: string         // holder address
  notional: string     // YES token balance, 6-decimal, as bigint string
  owed: string         // owed(user) at poll time, 6-decimal — NOT fixed at flag time;
                        // grows every second the position waits to be claimed, so this
                        // (and claimPrice below) is a live quote that changes between polls
  tokenValue: string   // Q × currentMark / WAD, 6-decimal
  claimPrice: string   // min(owed, tokenValue), 6-decimal
  tailCase: boolean    // owed > tokenValue — insurance fund tops up
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
  // Resolved from the on-chain registry by the position's slug — the claim always goes
  // to THIS market's LiquidationEngine, never an address taken from the keeper response.
  market: Market
}

export function LiquidationCard({ position, market }: LiquidationCardProps) {
  const publicClient = usePublicClient()
  const { address: claimer } = useAccount()
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
      // The engine pulls the claim price in USDC — approve THIS market's engine first
      // (padded 1%: owed keeps accruing between quote and tx; the cap is min(owed, value)).
      const needed = claimPriceBig + claimPriceBig / 100n + 1n
      if (claimer && publicClient) {
        const current = await publicClient.readContract({
          address: market.usdc,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [claimer, market.liquidationEngine],
        })
        if (current < needed) {
          const approveHash = await writeContractAsync({
            address: market.usdc,
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [market.liquidationEngine, needed],
          })
          await waitForTransactionReceipt(wagmiConfig, { hash: approveHash })
        }
      }
      const hash = await writeContractAsync({
        address: market.liquidationEngine,
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
  }, [writeContractAsync, publicClient, claimer, market, claimPriceBig, position.user])

  return (
    <div className={`pari-b-card ${isFrozen ? 'opacity-50' : ''}`}>
      {/* Frozen banner */}
      {isFrozen && (
        <div className="mb-3 rounded-[1px] border border-subtle bg-surface-2 px-3 py-2">
          <span className="text-xs font-bold uppercase tracking-wider text-text-muted">
            Frozen — credit event under review
          </span>
        </div>
      )}

      {/* Header row */}
      <div className="mb-4 flex items-center justify-between">
        <div>
          <p className="text-xs font-semibold text-text-1">{market.entityName}</p>
          <span className="font-mono text-xs text-text-2">{shortAddr(position.user)}</span>
        </div>
        {position.tailCase && (
          <span className="pari-badge pari-badge--warning">Tail Case</span>
        )}
      </div>

      {/* Metrics grid */}
      <div className="mb-4 grid grid-cols-2 gap-x-6 gap-y-3">
        <BStat label="Upbet size"  value={`${tokenQty(position.notional)}`} />
        <BStat label="Position value" value={usdc(position.tokenValue)} />
      </div>

      {/* Claim price — large */}
      <div className="mb-4">
        <p className="pari-b-label">Claim price (P)</p>
        <p className="pari-b-card__value font-serif">{usdc(position.claimPrice)}</p>
      </div>

      {!position.tailCase && (
        <div className="mb-5">
          <BStat
            label="Est. profit (before resale)"
            value={`+${usdc(profitBig.toString())}`}
            colorClass="text-success"
          />
        </div>
      )}

      {/* Claim button / success */}
      {txStatus !== 'success' ? (
        <button
          onClick={handleClaim}
          disabled={isDisabled}
          className="pari-b-btn pari-b-btn--primary w-full"
        >
          {txStatus === 'pending'
            ? 'Claiming…'
            : `Claim — pay ${usdc(position.claimPrice)}`}
        </button>
      ) : (
        <div className="rounded-[1px] border border-success/30 bg-success/10 p-4">
          <p className="mb-1 text-sm font-bold uppercase tracking-wide text-success">
            Upbet position claimed successfully.
          </p>
          <p className="mb-3 text-xs text-text-2">
            The Upbet position is now in your wallet. Resell on the market to capture
            your ~{usdc(profitBig.toString())} profit.
          </p>
          <Link
            href={`/market/${market.slug}`}
            className="pari-b-btn pari-b-btn--secondary inline-flex"
          >
            Go to trade panel to sell Upbet →
          </Link>
        </div>
      )}

      {txStatus === 'error' && txError && (
        <p className="mt-2 text-xs text-danger">{txError}</p>
      )}
    </div>
  )
}

// ── Stat sub-component ────────────────────────────────────────────────────────

function BStat({
  label,
  value,
  colorClass = 'text-teal',
}: {
  label: string
  value: string
  colorClass?: string
}) {
  return (
    <div>
      <p className="pari-b-label">{label}</p>
      <p className={`text-sm tabular ${colorClass}`}>{value}</p>
    </div>
  )
}

// ── Dev fixtures ──────────────────────────────────────────────────────────────

export const DEV_POSITIONS: ClaimablePosition[] = [
  {
    user: '0xDeAdBeEf00000000000000000000000000000001',
    notional:   '500000000',   // 500 YES tokens (6-dec)
    owed:       '14550000',    // $14.55
    tokenValue: '15000000',    // $15.00 (mark ≈ 3%)
    claimPrice: '14550000',    // normal case: P = owed
    tailCase: false,
    frozen: false,
  },
  {
    user: '0xDeAdBeEf00000000000000000000000000000002',
    notional:   '1000000000',  // 1,000 YES tokens
    owed:       '31200000',    // $31.20 (tail: owed > mark)
    tokenValue: '30000000',    // $30.00
    claimPrice: '30000000',    // tail case: P = tokenValue
    tailCase: true,
    frozen: false,
  },
  {
    user: '0xDeAdBeEf00000000000000000000000000000003',
    notional:   '200000000',   // 200 YES tokens
    owed:       '5820000',     // $5.82
    tokenValue: '6000000',     // $6.00
    claimPrice: '5820000',
    tailCase: false,
    frozen: true,
    frozenReason: 'credit event under review',
  },
]
