'use client'

import { useCallback, useState } from 'react'
import { useReadContract, useReadContracts, useWriteContract } from 'wagmi'
import { waitForTransactionReceipt } from '@wagmi/core'
import Link from 'next/link'
import { formatUnits } from 'viem'
import { wagmiConfig } from '@/lib/wagmi'
import { CREDIT_MARKET_ABI, ERC20_ABI } from '@/lib/creditMarketAbi'
import { healthRatio, healthLevel, HEALTH_COPY, useIsBatch4 } from '@/lib/positionHealth'
import type { HealthLevel } from '@/lib/positionHealth'

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
  motionPending?:  boolean
  heldCarry?:      bigint // Downbet carry held since a DC question opened
  batch4?:         boolean
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

export const DEV_YES_AMBER:    DevValues = { ...DEV_YES_HEALTHY, epochsToExpire: 14n, batch4: true, cureCost: 1_250000n }
export const DEV_YES_RED:      DevValues = { ...DEV_YES_HEALTHY, epochsToExpire: 3n, batch4: true, cureCost: 4_100000n, motionPending: true }
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
  cureCost:       14_550000n, // $14.55 — live owed() net of pending NO credit (a snapshot; grows while locked)
  carryNet:       undefined,
}

export const DEV_NO_MOTION: DevValues = {
  costBasis:     766000000000000000n,
  equity:        812000000000000000n,
  pnl:            46000000000000000n,
  breakevenMark: 720000000000000000n,
  epochsToExpire: 0n,
  isSeizable:    false,
  yesBalance:    0n,
  noBalance:     500_000000n,
  claimable:     false,
  motionPending: true,
  heldCarry:     2_400000n, // $2.40 held since the DC question opened
  batch4:        true,
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
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'owed',           args: [userAddress] },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'fundingDebt',    args: [userAddress] },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'currentCarryRate' },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'cumFundingPerNO' },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'lastFundingTime' },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'snapNO',         args: [userAddress] },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'motionPending' },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'currentMark' },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'epochLength' },
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
  const owed           = data?.[9]?.result as bigint | undefined
  const fundingDebt    = data?.[10]?.result as bigint | undefined
  const carryRate      = data?.[11]?.result as bigint | undefined // −(1 − m)·ln(1 − m) a year — NOT the mark
  const cumFundingPerNO = data?.[12]?.result as bigint | undefined
  const lastFundingTime = data?.[13]?.result as bigint | undefined
  const snapNO         = data?.[14]?.result as bigint | undefined
  const motionPending  = (_dev?.motionPending ?? data?.[15]?.result) as boolean | undefined
  const currentMark    = data?.[16]?.result as bigint | undefined
  const epochLength    = data?.[17]?.result as bigint | undefined

  // Batch 4: Pay carry is open to every Upbet holder and post-EDD carry is held.
  const batch4Probe = useIsBatch4(isReal ? creditMarketAddress : undefined)
  const batch4 = _dev?.batch4 ?? batch4Probe === true

  // Held-carry record (batch 4 only): escrowedCredit, motionDebt, refundable, motion id.
  const { data: escrowData } = useReadContracts({
    contracts: [
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'escrowOf', args: [userAddress] },
      { address: creditMarketAddress, abi: CREDIT_MARKET_ABI, functionName: 'motionId' },
    ],
    query: { enabled: isReal && batch4 },
  })
  const escrow = escrowData?.[0]?.result as readonly [bigint, bigint, bigint, bigint] | undefined
  const motionId = escrowData?.[1]?.result as bigint | undefined
  const { data: eddIndexData } = useReadContract({
    address: creditMarketAddress,
    abi: CREDIT_MARKET_ABI,
    functionName: 'motionIndex',
    args: [motionId ?? 0n],
    query: { enabled: isReal && batch4 && motionId !== undefined && motionId > 0n },
  })
  const eddIndex = eddIndexData as bigint | undefined

  const balance = isYES ? yesBalance : noBalance

  // ── Live carry preview (unflagged only — previewFunding is NOT freeze-aware) ──
  const { data: previewDelta } = useReadContract({
    address: creditMarketAddress,
    abi: CREDIT_MARKET_ABI,
    functionName: 'previewFunding',
    args: [userAddress, yesBalance ?? 0n, true],
    // Batch 4: previewFunding is exact for flagged holders too (no accounting freeze).
    query: { enabled: isReal && yesBalance !== undefined && (isClaimable === false || batch4) },
  })

  const carryNet =
    _dev?.carryNet ??
    ((isClaimable === false || batch4) && previewDelta !== undefined && fundingDebt !== undefined
      ? (previewDelta as bigint) - fundingDebt
      : undefined)

  // ── Cure cost (client-side estimate, only meaningful while flagged) ──────────
  // debit = owed(user) − pendingNOCredit, clamped at 0. There is no freeze — owed()
  // is the live obligation (ledger debt + accrual on the current balance projected
  // to now) and keeps growing every second the position waits to be cured or
  // claimed, so this estimate goes stale between polls/refetches just like the
  // unflagged carry preview does.
  // pendingNOCredit = noBal × (projected cumFundingPerNO − snapNO) / 1e18
  const nowSec = BigInt(Math.floor(Date.now() / 1000))
  const elapsed = lastFundingTime !== undefined && nowSec > lastFundingTime ? nowSec - lastFundingTime : 0n
  const projectedCumFundingPerNO =
    cumFundingPerNO !== undefined && carryRate !== undefined
      ? cumFundingPerNO + (carryRate * elapsed) / YEAR_SECONDS
      : undefined

  const pendingNOCredit =
    projectedCumFundingPerNO !== undefined && snapNO !== undefined && noBalance !== undefined
      ? (noBalance * (projectedCumFundingPerNO > snapNO ? projectedCumFundingPerNO - snapNO : 0n)) / ONE_E18
      : 0n

  // Downbet carry held since the DC question opened (shown while a motion is open):
  // the recorded escrow for THIS motion + live accrual since max(snapshot, EDD).
  const recordedHeld = escrow && motionId !== undefined && escrow[3] === motionId ? escrow[0] : 0n
  const liveHeld =
    motionPending && projectedCumFundingPerNO !== undefined && snapNO !== undefined && eddIndex !== undefined && noBalance !== undefined
      ? (() => {
          const from = snapNO > eddIndex ? snapNO : eddIndex
          return projectedCumFundingPerNO > from ? (noBalance * (projectedCumFundingPerNO - from)) / ONE_E18 : 0n
        })()
      : 0n
  const heldCarry = _dev?.heldCarry ?? recordedHeld + liveHeld
  // After a DC Yes: post-EDD carry this address paid in cash comes back at settlement.
  const refundDue = creditEventConfirmed && escrow && motionId !== undefined && escrow[3] === motionId ? escrow[2] : 0n

  const debitRaw = owed ?? 0n
  const cureCostRaw = debitRaw > pendingNOCredit ? debitRaw - pendingNOCredit : 0n
  const cureEstimate = _dev?.cureCost ?? cureCostRaw
  // Exact quote when previewFunding is available: cure() collects
  // max(0, fundingDebt − previewFunding(user, yesBal, true)) — i.e. −carryNet. It
  // nets Downbet credit exactly as settlement does (incl. carry held during a motion,
  // which the client-side estimate above can't see). Fallback: the estimate.
  const cureCost = _dev?.cureCost ?? (carryNet !== undefined ? (carryNet < 0n ? -carryNet : 0n) : cureEstimate)
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
      // due (e.g. pending NO credit already covers owed()) — cure() still needs
      // calling to clear the flag, but it won't attempt a transferFrom.
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

  // ── Health (Upbet only; on-site alerts) ───────────────────────────────────────
  const health =
    isYES && yesBalance !== undefined && owed !== undefined && currentMark !== undefined && carryRate !== undefined && epochLength !== undefined
      ? healthRatio({ mark: currentMark, balance: yesBalance, owed, carryRate, epochLength })
      : null
  const level: HealthLevel | null =
    !isYES || creditEventConfirmed || !balance
      ? null
      : _dev
      ? healthLevel(null, epochsToExpire)
      : health === null
      ? null
      : healthLevel(health, epochsToExpire)

  // Pay carry: every Upbet holder on batch 4 (flagged holders on batch 3 via the locked
  // panel). Not after a confirmed event — settlement pays it from the $1 instead.
  const showPayCarry = isYES && batch4 && !creditEventConfirmed && !isClaimable && (cureCost > 0n)

  const { text: pnlText, neg: pnlNeg } = signedWadToPct(pnlRaw)
  const pnlColor = pnlRaw === undefined ? 'text-text-1' : pnlNeg ? 'text-danger' : 'text-success'

  // Named isLocked, not isFrozen: flagging LOCKS trading/redeeming, but funding
  // keeps accruing on the position until it's cured or claimed — no accounting freeze.
  const isLocked = isYES && isClaimable

  const carryLabel = carryNet === undefined
    ? null
    : carryNet >= 0n
    ? `Carry earned: ${usdcDisplay(carryNet)}`
    : `Carry owed: ${usdcDisplay(-carryNet)}`

  return (
    <div
      className="pari-a-card"
      style={isLocked ? { borderColor: 'var(--color-warning)' } : undefined}
    >

      {/* Header */}
      <div className="flex items-center justify-between mb-4 gap-2">
        <span className={`pari-badge ${isYES ? 'pari-badge--danger' : 'pari-badge--teal'}`}>
          {sideLabel} position
        </span>
        <div className="flex items-center gap-2">
          {isLocked && (
            <span className="pari-badge pari-badge--warning">Locked — pay carry to unlock</span>
          )}
          {!isLocked && level && (
            <span className={`pari-badge ${HEALTH_COPY[level].badge}`} title="Position health: how close this Upbet is to liquidation">
              {HEALTH_COPY[level].label}
            </span>
          )}
          {isYES && creditEventConfirmed && (
            <span className="pari-badge pari-badge--success">Credit event confirmed</span>
          )}
        </div>
      </div>

      {/* Locked state (YES only) — takes priority over the plain seizable warning.
          Not "frozen": daily carry keeps accruing while locked, so the cure cost
          below keeps rising the longer this waits — it is a live quote, not a
          fixed bill from the moment it was flagged. */}
      {isLocked && (
        <div className="mb-4 rounded border border-warning-a40 bg-warning-a10 px-3 py-2.5">
          <p className="mb-1 text-xs font-semibold text-warning">
            Position locked — flagged for liquidation
          </p>
          <p className="mb-2 text-[11px] leading-relaxed text-text-2">
            Trading and redeeming are locked until you pay carry or a liquidator claims
            it, and daily carry keeps accruing while you wait — the amount below rises the
            longer you leave it. Pay now to unlock and keep your {sideLabel}.
          </p>
          <div className="mb-2 flex items-center justify-between text-xs">
            <span className="text-text-2">Carry due (live)</span>
            <span className="font-serif tabular text-text-1">{usdcDisplay(cureCost)}</span>
          </div>
          <button
            onClick={handleCure}
            disabled={cureStatus === 'pending' || cureStatus === 'success' || !isReal}
            className="pari-a-btn pari-a-btn--primary w-full"
          >
            {cureStatus === 'pending'
              ? 'Paying…'
              : cureStatus === 'success'
              ? 'Paid'
              : cureCost > 0n
              ? `Pay carry — ${usdcDisplay(cureCost)}`
              : 'Unlock — no payment due'}
          </button>
          {cureStatus === 'error' && cureError && (
            <p className="mt-2 text-xs text-danger">{cureError}</p>
          )}
        </div>
      )}

      {/* DC question open (batch 4: informational — nothing is blocked) */}
      {motionPending && !creditEventConfirmed && (
        <div className="mb-4 rounded border border-warning-a40 bg-warning-a10 px-3 py-2.5">
          <p className="mb-1 text-xs font-semibold text-warning">A DC question is open on this market</p>
          {isYES ? (
            <p className="text-[11px] leading-relaxed text-text-2">
              Keep your carry paid: liquidations continue until the ruling. Carry you pay from
              the day the question opened is refunded to you if the DC rules a credit event
              happened.
            </p>
          ) : (
            <>
              <p className="mb-2 text-[11px] leading-relaxed text-text-2">
                Carry earned since the question opened is held: it is paid to you if the DC
                rules No, and cancelled if it rules a credit event happened.
              </p>
              {batch4 && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-text-2">Pending carry, paid if the DC rules No</span>
                  <span className="font-serif tabular text-text-1">{usdcDisplay(heldCarry)}</span>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {/* Health warning (Upbet, not yet flagged) */}
      {!isLocked && (level === 'warning' || level === 'critical') && (
        <div className="mb-4 rounded border border-danger-a28 bg-danger-a10 px-3 py-2.5">
          <p className="mb-1 text-xs font-semibold text-danger">
            {level === 'critical' ? 'Close to liquidation' : 'Liquidation getting closer'}
          </p>
          <p className="text-[11px] leading-relaxed text-text-2">
            {epochsToExpire !== undefined ? `About ${epochsToExpire} day${epochsToExpire === 1n ? '' : 's'} of carry left before this Upbet can be liquidated at today\u2019s chance. ` : ''}
            Paying carry resets the clock{batch4 ? '' : ' (available once flagged on this market)'}. A falling chance
            brings liquidation closer at once.
          </p>
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
        {refundDue > 0n && (
          <Stat label="Carry refund" value={`${usdcDisplay(refundDue)} at settlement`} colorClass="text-success" />
        )}
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

      {/* Pay carry (batch 4: any Upbet holder, any time — resets the liquidation clock) */}
      {showPayCarry && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded border border-subtle bg-surface-2 px-3 py-2.5">
          <div>
            <p className="text-xs font-semibold text-text-1">Carry due {usdcDisplay(cureCost)}</p>
            <p className="text-[11px] text-text-2">Pay it now to reset your liquidation clock.</p>
          </div>
          <button
            onClick={handleCure}
            disabled={cureStatus === 'pending' || !isReal}
            className={`pari-a-btn ${level === 'warning' || level === 'critical' ? 'pari-a-btn--primary' : 'pari-a-btn--secondary'} shrink-0`}
          >
            {cureStatus === 'pending' ? 'Paying…' : 'Pay carry'}
          </button>
        </div>
      )}
      {showPayCarry && cureStatus === 'error' && cureError && (
        <p className="-mt-2 mb-3 text-xs text-danger">{cureError}</p>
      )}
      {!isLocked && cureStatus === 'success' && (
        <p className="-mt-2 mb-3 text-xs text-success">Carry paid.</p>
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

      {!creditEventConfirmed && (
        <p className="mt-3 text-[11px] leading-relaxed text-text-muted">
          To close this position, sell your {sideLabel}. Buying {isYES ? 'Downbets' : 'Upbets'} doesn&rsquo;t
          close it{isYES ? ': your Upbet keeps owing carry and can still be liquidated, unless you then redeem the pair' : ' unless you then redeem the pair'}.
        </p>
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
