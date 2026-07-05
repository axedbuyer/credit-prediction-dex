'use client'

import { useState, useCallback } from 'react'
import { useAccount, useReadContract, useReadContracts, useWriteContract, useChainId } from 'wagmi'
import { waitForTransactionReceipt } from '@wagmi/core'
import { formatUnits } from 'viem'
import Link from 'next/link'
import { wagmiConfig } from '@/lib/wagmi'
import { CONTRACT_ADDRESSES, type SupportedChainId } from '@/lib/contracts'
import { CREDIT_MARKET_ABI, ERC20_ABI, netFundingDebit } from '@/lib/creditMarketAbi'
import { TradePanel } from '@/components/TradePanel'
import { MSTR_MARKET } from '@/lib/constants'
import {
  PositionCard,
  DEV_YES_HEALTHY,
  DEV_YES_AMBER,
  DEV_YES_RED,
  DEV_YES_SEIZABLE,
  DEV_YES_FROZEN,
  DEV_NO_HEALTHY,
} from '@/components/PositionCard'

// ── Helpers ───────────────────────────────────────────────────────────────────

const ONE_E18 = 10n ** 18n
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const

function sideLabel(side: 'YES' | 'NO'): string {
  return side === 'YES' ? 'Upbet' : 'Downbet'
}

function usdcDisplay(raw: bigint): string {
  return `$${parseFloat(formatUnits(raw, 6)).toFixed(2)}`
}

function tokenDisplay(raw: bigint): string {
  return parseFloat(formatUnits(raw, 6)).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

type TxStatus = 'idle' | 'pending' | 'success' | 'error'

// ── Component ─────────────────────────────────────────────────────────────────

export default function PortfolioPage() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const addrs =
    CONTRACT_ADDRESSES[chainId as SupportedChainId] ?? CONTRACT_ADDRESSES[84532]

  const [tradeModal, setTradeModal] = useState<'YES' | 'NO' | null>(null)
  const [redeemStatus, setRedeemStatus] = useState<TxStatus>('idle')
  const [settleStatus, setSettleStatus] = useState<TxStatus>('idle')
  const [txError, setTxError] = useState('')

  const { writeContractAsync } = useWriteContract()

  // ── Batched reads ──────────────────────────────────────────────────────────
  const userAddr = address ?? ZERO_ADDR

  const { data, isLoading, refetch } = useReadContracts({
    contracts: [
      {
        address: addrs.yesToken,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [userAddr],
      },
      {
        address: addrs.noToken,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [userAddr],
      },
      {
        address: addrs.creditMarket,
        abi: CREDIT_MARKET_ABI,
        functionName: 'fundingDebt',
        args: [userAddr],
      },
      {
        address: addrs.creditMarket,
        abi: CREDIT_MARKET_ABI,
        functionName: 'currentMark',
      },
      {
        address: addrs.creditMarket,
        abi: CREDIT_MARKET_ABI,
        functionName: 'creditEventConfirmed',
      },
      {
        address: addrs.creditMarket,
        abi: CREDIT_MARKET_ABI,
        functionName: 'claimable',
        args: [userAddr],
      },
    ],
    query: { enabled: !!address },
  })

  const yesBalance      = data?.[0]?.result as bigint | undefined
  const noBalance       = data?.[1]?.result as bigint | undefined
  const fundingDebt     = data?.[2]?.result as bigint | undefined
  const currentMark     = data?.[3]?.result as bigint | undefined
  const creditConfirmed = data?.[4]?.result as boolean | undefined
  const isClaimable     = data?.[5]?.result as boolean | undefined

  // Live net carry (unflagged only — previewFunding is NOT freeze-aware): nets the
  // YES-side owed carry against the persistent fundingDebt ledger, same math as
  // CLOBSettlement's Option B check. Positive = carry earned (credit), negative = owed.
  const { data: previewDelta } = useReadContract({
    address: addrs.creditMarket,
    abi: CREDIT_MARKET_ABI,
    functionName: 'previewFunding',
    args: [userAddr, yesBalance ?? 0n, true],
    query: { enabled: !!address && isClaimable === false && yesBalance !== undefined },
  })

  // ── Derived values ─────────────────────────────────────────────────────────
  const mark    = currentMark ?? 0n
  const yesRaw  = yesBalance  ?? 0n
  const noRaw   = noBalance   ?? 0n
  const debtRaw = fundingDebt ?? 0n

  const hasYES  = yesRaw > 0n
  const hasNO   = noRaw  > 0n
  const hasBoth = hasYES && hasNO

  // YES value  = balance × mark / 1e18  (result in 6-dec USDC units)
  // NO  value  = balance × (1e18 − mark) / 1e18
  const yesValue = mark > 0n ? yesRaw * mark / ONE_E18 : 0n
  const noValue  = mark > 0n ? noRaw * (ONE_E18 - mark) / ONE_E18 : 0n

  const yesNetValue = yesValue > debtRaw ? yesValue - debtRaw : 0n
  const noNetValue  = noValue // NO holders don't owe funding in this contract

  // Signed net carry: positive = "Carry earned", negative = "Carry owed".
  const carryNet =
    isClaimable === false && previewDelta !== undefined
      ? (previewDelta as bigint) - debtRaw
      : undefined
  // netFundingDebit clamps to the owed side only (0 when there's a net credit instead) —
  // used for the "Carry owed" case; carryNet's sign covers the "Carry earned" case.
  const carryOwed =
    isClaimable === false && previewDelta !== undefined
      ? netFundingDebit(previewDelta as bigint, debtRaw)
      : 0n

  const redeemable    = yesRaw < noRaw ? yesRaw : noRaw   // min(YES, NO)
  const redeemableNet = redeemable > debtRaw ? redeemable - debtRaw : 0n

  // ── Transactions ───────────────────────────────────────────────────────────
  const handleRedeem = useCallback(async () => {
    if (!address || redeemable === 0n) return
    setRedeemStatus('pending')
    setTxError('')
    try {
      const hash = await writeContractAsync({
        address: addrs.creditMarket,
        abi: CREDIT_MARKET_ABI,
        functionName: 'redeem',
        args: [redeemable],
      })
      await waitForTransactionReceipt(wagmiConfig, { hash })
      setRedeemStatus('success')
      refetch()
    } catch (e: unknown) {
      setRedeemStatus('error')
      const msg = e instanceof Error ? e.message : 'Transaction failed'
      setTxError(msg.includes('User rejected') || msg.includes('4001') ? 'Rejected' : msg)
    }
  }, [address, redeemable, addrs, writeContractAsync, refetch])

  const handleSettleYES = useCallback(async () => {
    if (!address || yesRaw === 0n) return
    setSettleStatus('pending')
    setTxError('')
    try {
      const hash = await writeContractAsync({
        address: addrs.creditMarket,
        abi: CREDIT_MARKET_ABI,
        functionName: 'settleYES',
        args: [yesRaw],
      })
      await waitForTransactionReceipt(wagmiConfig, { hash })
      setSettleStatus('success')
      refetch()
    } catch (e: unknown) {
      setSettleStatus('error')
      const msg = e instanceof Error ? e.message : 'Transaction failed'
      setTxError(msg.includes('User rejected') || msg.includes('4001') ? 'Rejected' : msg)
    }
  }, [address, yesRaw, addrs, writeContractAsync, refetch])

  // ── Not connected ──────────────────────────────────────────────────────────
  if (!isConnected) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8">
        <h1 className="font-serif text-2xl text-text-1">Portfolio</h1>
        <div className="mt-8 pari-a-card text-center">
          <p className="text-text-2">Connect your wallet to view positions.</p>
        </div>
        {/* Dev preview — all PositionCard states (only in development) */}
        {process.env.NODE_ENV === 'development' && (
          <div className="mt-10 border-t border-dashed border-subtle pt-6 space-y-4">
            <p className="text-[10px] font-mono uppercase tracking-widest text-text-muted">
              ↓ dev preview — position card states
            </p>
            <PositionCard side="YES" _dev={DEV_YES_HEALTHY}
              userAddress={ZERO_ADDR} creditMarketAddress={ZERO_ADDR}
              yesTokenAddress={ZERO_ADDR} noTokenAddress={ZERO_ADDR}
              onSell={() => {}} />
            <PositionCard side="YES" _dev={DEV_YES_AMBER}
              userAddress={ZERO_ADDR} creditMarketAddress={ZERO_ADDR}
              yesTokenAddress={ZERO_ADDR} noTokenAddress={ZERO_ADDR}
              onSell={() => {}} />
            <PositionCard side="YES" _dev={DEV_YES_RED}
              userAddress={ZERO_ADDR} creditMarketAddress={ZERO_ADDR}
              yesTokenAddress={ZERO_ADDR} noTokenAddress={ZERO_ADDR}
              onSell={() => {}} />
            <PositionCard side="YES" _dev={DEV_YES_SEIZABLE}
              userAddress={ZERO_ADDR} creditMarketAddress={ZERO_ADDR}
              yesTokenAddress={ZERO_ADDR} noTokenAddress={ZERO_ADDR}
              onSell={() => {}} />
            <PositionCard side="YES" _dev={DEV_YES_FROZEN}
              userAddress={ZERO_ADDR} creditMarketAddress={ZERO_ADDR}
              yesTokenAddress={ZERO_ADDR} noTokenAddress={ZERO_ADDR}
              usdcAddress={ZERO_ADDR}
              onSell={() => {}} />
            <PositionCard side="NO" _dev={DEV_NO_HEALTHY}
              userAddress={ZERO_ADDR} creditMarketAddress={ZERO_ADDR}
              yesTokenAddress={ZERO_ADDR} noTokenAddress={ZERO_ADDR}
              onSell={() => {}} />
          </div>
        )}
      </div>
    )
  }

  const hasNoPositions = !hasYES && !hasNO && !isLoading

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="font-serif text-2xl text-text-1">Portfolio</h1>
      <p className="mt-1 text-sm text-text-2">
        Will MicroStrategy have a credit event in the next 12 months?
      </p>

      {/* Loading skeletons */}
      {isLoading && (
        <div className="mt-6 space-y-4">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-40 rounded border border-subtle bg-surface-1 animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {hasNoPositions && (
        <div className="mt-8 pari-a-card text-center">
          <p className="text-text-2">No positions yet.</p>
          <Link
            href="/market/mstr"
            className="pari-a-btn pari-a-btn--primary mt-4 inline-flex"
          >
            Go to market to trade
          </Link>
        </div>
      )}

      {/* Position cards */}
      {!isLoading && (hasYES || hasNO) && (
        <div className="mt-6 space-y-4">

          {hasYES && (
            <PositionCard
              side="YES"
              userAddress={userAddr}
              creditMarketAddress={addrs.creditMarket}
              yesTokenAddress={addrs.yesToken}
              noTokenAddress={addrs.noToken}
              usdcAddress={addrs.usdc}
              creditEventConfirmed={creditConfirmed ?? false}
              onSell={() => setTradeModal('YES')}
              onSettle={handleSettleYES}
              settleStatus={settleStatus}
              onCured={refetch}
            />
          )}

          {hasNO && (
            <PositionCard
              side="NO"
              userAddress={userAddr}
              creditMarketAddress={addrs.creditMarket}
              yesTokenAddress={addrs.yesToken}
              noTokenAddress={addrs.noToken}
              usdcAddress={addrs.usdc}
              onSell={() => setTradeModal('NO')}
            />
          )}

          {/* Position value summary — net of carry */}
          {(hasYES || hasNO) && (
            <div className="grid grid-cols-2 gap-x-6 gap-y-3 pari-a-card">
              {hasYES && (
                <Stat
                  label="Upbet value (net of carry)"
                  value={usdcDisplay(yesNetValue)}
                />
              )}
              {hasNO && (
                <Stat label="Downbet value" value={usdcDisplay(noNetValue)} />
              )}
              {hasYES && carryNet !== undefined && (
                <Stat
                  label="Carry"
                  value={carryNet >= 0n ? `Earned ${usdcDisplay(carryNet)}` : `Owed ${usdcDisplay(carryOwed)}`}
                  highlight={carryNet >= 0n}
                  warn={carryNet < 0n}
                />
              )}
            </div>
          )}

          {/* Redeem section */}
          {hasBoth && (
            <div className="pari-a-card">
              <h2 className="mb-1 font-serif text-lg text-text-1">Redeem</h2>
              <p className="mb-4 text-xs text-text-2">
                Redeem {tokenDisplay(redeemable)} matched Upbet + Downbet pairs for{' '}
                {usdcDisplay(redeemable)} USDC
              </p>
              <div className="mb-4 flex items-center justify-between text-sm">
                <span className="text-text-2">You receive (net of carry owed)</span>
                <span className="font-serif tabular text-text-1">
                  {usdcDisplay(redeemableNet)}
                </span>
              </div>
              {isClaimable && (
                <p className="mb-3 text-xs text-danger">
                  Redeem is disabled while your position is frozen — cure it above first.
                </p>
              )}
              <button
                onClick={handleRedeem}
                disabled={redeemStatus === 'pending' || redeemable === 0n || !!isClaimable}
                title={isClaimable ? 'Redeem is disabled while frozen — cure first' : undefined}
                className="pari-a-btn pari-a-btn--secondary w-full"
              >
                {redeemStatus === 'pending'
                  ? 'Redeeming…'
                  : `Redeem ${tokenDisplay(redeemable)} pairs for USDC`}
              </button>
              {redeemStatus === 'success' && (
                <p className="mt-2 text-xs text-success">Redeemed successfully.</p>
              )}
            </div>
          )}

          {/* Shared tx error */}
          {txError && (
            <p className="text-center text-xs text-danger">{txError}</p>
          )}
        </div>
      )}

      {/* Dev preview — all PositionCard states (only in development) */}
      {process.env.NODE_ENV === 'development' && (
        <div className="mt-10 border-t border-dashed border-subtle pt-6 space-y-4">
          <p className="text-[10px] font-mono uppercase tracking-widest text-text-muted">
            ↓ dev preview — position card states
          </p>
          <PositionCard side="YES" _dev={DEV_YES_HEALTHY}
            userAddress={ZERO_ADDR} creditMarketAddress={ZERO_ADDR}
            yesTokenAddress={ZERO_ADDR} noTokenAddress={ZERO_ADDR}
            onSell={() => {}} />
          <PositionCard side="YES" _dev={DEV_YES_AMBER}
            userAddress={ZERO_ADDR} creditMarketAddress={ZERO_ADDR}
            yesTokenAddress={ZERO_ADDR} noTokenAddress={ZERO_ADDR}
            onSell={() => {}} />
          <PositionCard side="YES" _dev={DEV_YES_RED}
            userAddress={ZERO_ADDR} creditMarketAddress={ZERO_ADDR}
            yesTokenAddress={ZERO_ADDR} noTokenAddress={ZERO_ADDR}
            onSell={() => {}} />
          <PositionCard side="YES" _dev={DEV_YES_SEIZABLE}
            userAddress={ZERO_ADDR} creditMarketAddress={ZERO_ADDR}
            yesTokenAddress={ZERO_ADDR} noTokenAddress={ZERO_ADDR}
            onSell={() => {}} />
          <PositionCard side="YES" _dev={DEV_YES_FROZEN}
            userAddress={ZERO_ADDR} creditMarketAddress={ZERO_ADDR}
            yesTokenAddress={ZERO_ADDR} noTokenAddress={ZERO_ADDR}
            usdcAddress={ZERO_ADDR}
            onSell={() => {}} />
          <PositionCard side="NO" _dev={DEV_NO_HEALTHY}
            userAddress={ZERO_ADDR} creditMarketAddress={ZERO_ADDR}
            yesTokenAddress={ZERO_ADDR} noTokenAddress={ZERO_ADDR}
            onSell={() => {}} />
        </div>
      )}

      {/* Sell modal */}
      {tradeModal !== null && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setTradeModal(null)}
        >
          <div
            className="w-full max-w-sm rounded border border-subtle bg-surface-1 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="font-serif text-lg text-text-1">
                Sell {sideLabel(tradeModal)}
              </h2>
              <button
                onClick={() => setTradeModal(null)}
                className="text-xl leading-none text-text-muted hover:text-text-1"
                aria-label="Close"
              >
                ×
              </button>
            </div>
            <TradePanel
              marketId={MSTR_MARKET.id}
              initialSide={tradeModal}
              initialDirection="SELL"
            />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Stat sub-component ────────────────────────────────────────────────────────

function Stat({
  label,
  value,
  highlight = false,
  warn = false,
  dim = false,
}: {
  label: string
  value: string
  highlight?: boolean
  warn?: boolean
  dim?: boolean
}) {
  const valueClass = highlight
    ? 'text-success'
    : warn
    ? 'text-danger'
    : dim
    ? 'text-text-muted'
    : 'text-text-1'

  return (
    <div>
      <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-text-muted">
        {label}
      </p>
      <p className={`font-serif text-sm tabular ${valueClass}`}>{value}</p>
    </div>
  )
}
