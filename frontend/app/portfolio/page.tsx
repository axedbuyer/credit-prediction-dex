'use client'

import { useState, useCallback } from 'react'
import { useAccount, useReadContracts, useWriteContract, useChainId } from 'wagmi'
import { waitForTransactionReceipt } from '@wagmi/core'
import { formatUnits } from 'viem'
import Link from 'next/link'
import { wagmiConfig } from '@/lib/wagmi'
import { CONTRACT_ADDRESSES, type SupportedChainId } from '@/lib/contracts'
import { TradePanel } from '@/components/TradePanel'
import { MSTR_MARKET } from '@/lib/constants'
import {
  PositionCard,
  DEV_YES_HEALTHY,
  DEV_YES_AMBER,
  DEV_YES_RED,
  DEV_YES_SEIZABLE,
  DEV_NO_HEALTHY,
} from '@/components/PositionCard'

// ── ABIs ─────────────────────────────────────────────────────────────────────

const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

const CREDIT_MARKET_ABI = [
  {
    name: 'currentMark',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'creditEventConfirmed',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'fundingDebt',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'redeem',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenAmount', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'settleYES',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
] as const

// ── Helpers ───────────────────────────────────────────────────────────────────

const ONE_E18 = 10n ** 18n
const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const

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
    ],
    query: { enabled: !!address },
  })

  const yesBalance      = data?.[0]?.result as bigint | undefined
  const noBalance       = data?.[1]?.result as bigint | undefined
  const fundingDebt     = data?.[2]?.result as bigint | undefined
  const currentMark     = data?.[3]?.result as bigint | undefined
  const creditConfirmed = data?.[4]?.result as boolean | undefined

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
        <h1 className="text-2xl font-bold text-slate-100">Portfolio</h1>
        <div className="mt-8 rounded-lg border border-slate-800 bg-slate-900 p-10 text-center">
          <p className="text-slate-400">Connect your wallet to view positions.</p>
        </div>
        {/* Dev preview — all PositionCard states (only in development) */}
        {process.env.NODE_ENV === 'development' && (
          <div className="mt-10 border-t border-dashed border-slate-700 pt-6 space-y-4">
            <p className="text-[10px] font-mono uppercase tracking-widest text-slate-600">
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
      <h1 className="text-2xl font-bold text-slate-100">Portfolio</h1>
      <p className="mt-1 text-sm text-slate-400">
        Will MicroStrategy have a credit event in the next 12 months?
      </p>

      {/* Loading skeletons */}
      {isLoading && (
        <div className="mt-6 space-y-4">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-40 rounded-lg border border-slate-800 bg-slate-900 animate-pulse"
            />
          ))}
        </div>
      )}

      {/* Empty state */}
      {hasNoPositions && (
        <div className="mt-8 rounded-lg border border-slate-800 bg-slate-900 p-10 text-center">
          <p className="text-slate-400">No positions yet.</p>
          <Link
            href="/market/mstr"
            className="mt-4 inline-block rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-500 transition-colors"
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
              creditEventConfirmed={creditConfirmed ?? false}
              onSell={() => setTradeModal('YES')}
              onSettle={handleSettleYES}
              settleStatus={settleStatus}
            />
          )}

          {hasNO && (
            <PositionCard
              side="NO"
              userAddress={userAddr}
              creditMarketAddress={addrs.creditMarket}
              yesTokenAddress={addrs.yesToken}
              noTokenAddress={addrs.noToken}
              onSell={() => setTradeModal('NO')}
            />
          )}

          {/* Redeem section */}
          {hasBoth && (
            <div className="rounded-lg border border-slate-700 bg-slate-900 p-5">
              <h2 className="mb-1 text-sm font-semibold text-slate-200">Redeem</h2>
              <p className="mb-4 text-xs text-slate-400">
                Burn {tokenDisplay(redeemable)} paired YES + NO tokens and receive{' '}
                {usdcDisplay(redeemable)} USDC
              </p>
              <div className="mb-4 flex items-center justify-between text-sm">
                <span className="text-slate-400">You receive (net of funding owed)</span>
                <span className="font-semibold text-slate-100">
                  {usdcDisplay(redeemableNet)}
                </span>
              </div>
              <button
                onClick={handleRedeem}
                disabled={redeemStatus === 'pending' || redeemable === 0n}
                className="w-full rounded-lg bg-slate-600 py-2.5 text-sm font-semibold text-slate-100 hover:bg-slate-500 disabled:opacity-50 transition-colors"
              >
                {redeemStatus === 'pending'
                  ? 'Redeeming…'
                  : `Redeem ${tokenDisplay(redeemable)} tokens for USDC`}
              </button>
              {redeemStatus === 'success' && (
                <p className="mt-2 text-xs text-emerald-400">Redeemed successfully.</p>
              )}
            </div>
          )}

          {/* Shared tx error */}
          {txError && (
            <p className="text-center text-xs text-red-400">{txError}</p>
          )}
        </div>
      )}

      {/* Dev preview — all PositionCard states (only in development) */}
      {process.env.NODE_ENV === 'development' && (
        <div className="mt-10 border-t border-dashed border-slate-700 pt-6 space-y-4">
          <p className="text-[10px] font-mono uppercase tracking-widest text-slate-600">
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
            className="w-full max-w-sm rounded-xl border border-slate-700 bg-slate-950 p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-sm font-semibold text-slate-200">
                Sell {tradeModal}
              </h2>
              <button
                onClick={() => setTradeModal(null)}
                className="text-xl leading-none text-slate-500 hover:text-slate-300"
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
    ? 'text-emerald-400'
    : warn
    ? 'text-red-400'
    : dim
    ? 'text-slate-500'
    : 'text-slate-100'

  return (
    <div>
      <p className="mb-0.5 text-xs text-slate-500">{label}</p>
      <p className={`text-sm font-semibold ${valueClass}`}>{value}</p>
    </div>
  )
}
