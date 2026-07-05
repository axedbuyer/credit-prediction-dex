'use client'

import { useCallback, useState } from 'react'
import { useReadContract, useReadContracts, useWriteContract } from 'wagmi'
import { waitForTransactionReceipt } from '@wagmi/core'
import Link from 'next/link'
import { formatUnits } from 'viem'
import { wagmiConfig } from '@/lib/wagmi'
import { CREDIT_MARKET_ABI, ERC20_ABI } from '@/lib/creditMarketAbi'

// -- Constants -----------------------------------------------------------------

const ONE_E18       = 10n ** 18n
const YEAR_SECONDS  = 365n * 24n * 3600n
const CURE_PAD_BPS  = 5n // ~+0.5% padding on the cure approval (accrual moves between quote and tx)

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
  claimable?:      boolean
  cureCost?:       bigint
  carryNet?:       bigint // signed: positive = carry earned, negative = carry owed
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
  claimable:      false,
  carryNet:       -1_250000n, // owes $1.25
}

export const DEV_YES_AMBER:    DevValues = { ...DEV_YES_HEALTHY, epochsToExpire: 14n }
export const DEV_YES_RED:      DevValues = { ...DEV_YES_HEALTHY, epochsToExpire: 3n }
export const DEV_YES_SEIZABLE: DevValues = {
  ...DEV_YES_HEALTHY,
  epochsToExpire: 0n,
  isSeizable:     true,
}
export const DEV_YES_FROZEN: DevValues = {
  ...DEV_YES_HEALTHY,
  epochsToExpire: 0n,
  isSeizable:     true,
  claimable:      true,
  cureCost:       14_550000n, // $14.55 — frozen obligation net of pending NO credit
  carryNet:       undefined,
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
  claimable:     false,
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
  usdcAddress?:        `0x${string}`
  creditEventConfirmed?: boolean
  onSell: () => void
  onSettle?: () => void
  settleStatus?: TxStatus
  onCured?: () => void
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

function usdcDisplay(raw: bigint): string {
  return `$${parseFloat(formatUnits(raw, 6)).toFixed(2)}`
}

function epochsColorClass(epochs: bigint | undefined): string {
  if (epochs === undefined) return 'text-text-2'
  if (epochs > 30n)  return 'text-success'
  if (epochs >= 7n)  return 'text-warning'
  return 'text-danger'
}

// -- Component ---------------------------------------------------------------

export function PositionCard({
  side,
  userAddress,
  creditMarketAddress,
  yesTokenAddress,
  noTokenAddress,
  usdcAddress,
  creditEventConfirmed = false,
  onSell,
  onSettle,
  settleStatus = 'idle',
  onCured,
  _dev,
}: PositionCardProps) {
  const isYES = side === 'YES'
  const sideLabel = isYES ? 'Upbet' : 'Downbet'
  const isReal = !_dev && userAddress !== ZERO_ADDR

  const { data, refetch } = useReadContracts({
    contracts: [
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'costBasis',      args: [userAddress] },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'equity',         args: [userAddress] },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'pnl',            args: [userAddress] },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'breakevenMark',  args: [userAddress] },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'epochsToExpire', args: [userAddress] },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'isSeizable',     args: [userAddress] },
      { address: yesTokenAddress,     abi: ERC20_ABI,         functionName: 'balanceOf',       args: [userAddress] },
      { address: noTokenAddress,      abi: ERC20_ABI,         functionName: 'balanceOf',       args: [userAddress] },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'claimable',      args: [userAddress] },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'frozenFunding',  args: [userAddress] },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'fundingDebt',    args: [userAddress] },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'currentMark' },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'cumFundingPerNO' },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'lastFundingTime' },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'snapNO',         args: [userAddress] },
    ],
    query: { enabled: isReal },
  })

  const costBasis      = (_dev?.costBasis      ?? data?.[0]?.result) as bigint | undefined
  const equity         = (_dev?.equity         ?? data?.[1]?.result) as bigint | undefined
  const pnlRaw         = (_dev?.pnl            ?? data?.[2]?.result) as bigint | undefined
  const breakevenMark  = (_dev?.breakevenMark  ?? data?.[3]?.result) as bigint | undefined
  const epochsToExpire = (_dev?.epochsToExpire ?? data?.[4]?.result) as bigint | undefined
  const isSeizable     = (_dev?.isSeizable     ?? data?.[5]?.result) as boolean | undefined
  const yesBalance     = (_dev?.yesBalance     ?? data?.[6]?.result) as bigint | undefined
  const noBalance      = (_dev?.noBalance      ?? data?.[7]?.result) as bigint | undefined
  const isClaimable    = (_dev?.claimable      ?? data?.[8]?.result) as boolean | undefined
  const frozenFunding  = data?.[9]?.result as bigint | undefined
  const fundingDebt    = data?.[10]?.result as bigint | undefined
  const currentMark    = data?.[11]?.result as bigint | undefined
  const cumFundingPerNO = data?.[12]?.result as bigint | undefined
  const lastFundingTime = data?.[13]?.result as bigint | undefined
  const snapNO         = data?.[14]?.result as bigint | undefined

  const balance = isYES ? yesBalance : noBalance

  // ── Live carry preview (unflagged only — previewFunding is NOT freeze-aware) ──
  const { data: previewDelta } = useReadContract({
    address: creditMarketAddress,
    abi: CREDIT_MARKET_ABI,
    functionName: 'previewFunding',
    args: [userAddress, yesBalance ?? 0n, true],
    query: { enabled: isReal && isClaimable === false && yesBalance !== undefined },
  })

  const carryNet =
    _dev?.carryNet ??
    (isClaimable === false && previewDelta !== undefined && fundingDebt !== undefined
      ? (previewDelta as bigint) - fundingDebt
      : undefined)

  // ── Cure cost (client-side estimate, only meaningful while flagged) ──────────
  // debit = fundingDebt + frozenFunding × yesBal / 1e18 − pendingNOCredit
  // pendingNOCredit = noBal × (projected cumFundingPerNO − snapNO) / 1e18
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  const elapsed = lastFundingTime !== undefined && nowSec > lastFundingTime ? nowSec - lastFundingTime : 0n
  const projectedCumFundingPerNO =
    cumFundingPerNO !== undefined && currentMark !== undefined
      ? cumFundingPerNO + (currentMark * elapsed) / YEAR_SECONDS
      : undefined

  const pendingNOCredit =
    projectedCumFundingPerNO !== undefined && snapNO !== undefined && noBalance !== undefined
      ? (noBalance * (projectedCumFundingPerNO > snapNO ? projectedCumFundingPerNO - snapNO : 0n)) / ONE_E18
      : 0n

  const debitRaw = (fundingDebt ?? 0n) + ((frozenFunding ?? 0n) * (yesBalance ?? 0n)) / ONE_E18
  const cureCostRaw = debitRaw > pendingNOCredit ? debitRaw - pendingNOCredit : 0n
  const cureCost = _dev?.cureCost ?? cureCostRaw
  const paddedApproval = cureCost + (cureCost * CURE_PAD_BPS) / 1000n + 1n

  // ── Cure flow: approve(creditMarket, paddedApproval) → cure() → refetch ──────
  const { writeContractAsync } = useWriteContract()
  const [cureStatus, setCureStatus] = useState<TxStatus>('idle')
  const [cureError, setCureError]   = useState('')

  const handleCure = useCallback(async () => {
    if (!isReal || !usdcAddress) return
    setCureStatus('pending')
    setCureError('')
    try {
      // Skip the approval step entirely when the client-side estimate shows nothing
      // due (e.g. pending NO credit already covers the frozen debit) — cure() still
      // needs calling to clear the flag, but it won't attempt a transferFrom.
      if (cureCost > 0n) {
        const approveHash = await writeContractAsync({
          address: usdcAddress,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [creditMarketAddress, paddedApproval],
        })
        await waitForTransactionReceipt(wagmiConfig, { hash: approveHash })
      }

      const cureHash = await writeContractAsync({
        address: creditMarketAddress,
        abi: CREDIT_MARKET_ABI,
        functionName: 'cure',
        args: [],
      })
      await waitForTransactionReceipt(wagmiConfig, { hash: cureHash })

      setCureStatus('success')
      refetch()
      onCured?.()
    } catch (e: unknown) {
      setCureStatus('error')
      const msg = e instanceof Error ? e.message : 'Transaction failed'
      setCureError(msg.includes('User rejected') || msg.includes('4001') ? 'Rejected' : msg)
    }
  }, [isReal, usdcAddress, cureCost, paddedApproval, creditMarketAddress, writeContractAsync, refetch, onCured])

  const { text: pnlText, neg: pnlNeg } = signedWadToPct(pnlRaw)
  const pnlColor = pnlRaw === undefined ? 'text-text-1' : pnlNeg ? 'text-danger' : 'text-success'

  const isFrozen = isYES && isClaimable

  const carryLabel = carryNet === undefined
    ? null
    : carryNet >= 0n
    ? `Carry earned: ${usdcDisplay(carryNet)}`
    : `Carry owed: ${usdcDisplay(-carryNet)}`

  return (
    <div
      className="pari-a-card"
      style={isFrozen ? { borderColor: 'var(--color-warning)' } : undefined}
    >

      {/* Header */}
      <div className="flex items-center justify-between mb-4 gap-2">
        <span className={`pari-badge ${isYES ? 'pari-badge--danger' : 'pari-badge--teal'}`}>
          {sideLabel} position
        </span>
        <div className="flex items-center gap-2">
          {isFrozen && (
            <span className="pari-badge pari-badge--warning">Frozen — cure required</span>
          )}
          {isYES && creditEventConfirmed && (
            <span className="pari-badge pari-badge--success">Credit event confirmed</span>
          )}
        </div>
      </div>

      {/* Frozen state (YES only) — takes priority over the plain seizable warning */}
      {isFrozen && (
        <div className="mb-4 rounded border border-warning/30 bg-warning/10 px-3 py-2.5">
          <p className="mb-1 text-xs font-semibold text-warning">
            Position frozen — flagged for liquidation
          </p>
          <p className="mb-2 text-[11px] leading-relaxed text-text-2">
            Trading and redeeming are locked until this is cured or claimed. Cure now to
            keep your {sideLabel} and resume normally — you keep the position and pay only
            the frozen carry owed.
          </p>
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="text-text-2">Cure cost</span>
            <span className="font-serif tabular text-text-1">{usdcDisplay(cureCost)}</span>
          </div>
          <button
            onClick={handleCure}
            disabled={cureStatus === 'pending' || cureStatus === 'success' || !isReal}
            className="pari-a-btn pari-a-btn--primary w-full"
          >
            {cureStatus === 'pending'
              ? 'Curing…'
              : cureStatus === 'success'
              ? 'Cured'
              : cureCost > 0n
              ? `Cure — pay ${usdcDisplay(cureCost)}`
              : 'Cure — no payment due'}
          </button>
          {cureStatus === 'error' && cureError && (
            <p className="mt-2 text-xs text-danger">{cureError}</p>
          )}
        </div>
      )}

      {/* Liquidatable banner (YES only, not yet flagged) */}
      {isYES && !isClaimable && isSeizable && (
        <div className="mb-4 flex items-center justify-between rounded border border-danger-a28 bg-danger-a10 px-3 py-2.5">
          <p className="text-xs font-semibold text-danger">
            This position is liquidatable now
          </p>
          <Link
            href="/liquidate"
            className="ml-3 shrink-0 text-xs font-semibold text-danger underline hover:opacity-80"
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
        <Stat label="Size"           value={`${tokenAmount(balance)} ${sideLabel}`} />
        {carryLabel && (
          <Stat
            label="Carry"
            value={carryLabel}
            colorClass={carryNet !== undefined && carryNet < 0n ? 'text-danger' : 'text-success'}
          />
        )}
      </div>

      {/* Epochs to expire — YES only, prominent */}
      {isYES && (
        <div className="mb-5 rounded border border-subtle bg-surface-2 px-4 py-3">
          <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-text-muted">
            Days remaining
          </p>
          <p className={`font-serif text-lg tabular ${epochsColorClass(epochsToExpire)}`}>
            {epochsToExpire !== undefined ? `${epochsToExpire} days` : '—'}
          </p>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        <button
          onClick={onSell}
          className="pari-a-btn pari-a-btn--secondary flex-1"
        >
          Sell {sideLabel}
        </button>
        {isYES && creditEventConfirmed && (
          <button
            onClick={onSettle}
            disabled={settleStatus === 'pending'}
            className="pari-a-btn pari-a-btn--primary flex-1"
          >
            {settleStatus === 'pending' ? 'Settling…' : `Settle ${sideLabel} for USDC`}
          </button>
        )}
      </div>

      {settleStatus === 'success' && (
        <p className="mt-2 text-xs text-success">{sideLabel} settled for USDC.</p>
      )}
    </div>
  )
}

// -- Stat sub-component ------------------------------------------------------

function Stat({
  label,
  value,
  colorClass = 'text-text-1',
}: {
  label: string
  value: string
  colorClass?: string
}) {
  return (
    <div>
      <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-text-muted">
        {label}
      </p>
      <p className={`font-serif text-sm tabular ${colorClass}`}>{value}</p>
    </div>
  )
}
