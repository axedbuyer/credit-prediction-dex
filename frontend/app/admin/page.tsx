'use client'

import { useState, useCallback } from 'react'
import type { ReactNode } from 'react'
import { useAccount, useReadContracts, useWriteContract, useChainId } from 'wagmi'
import { waitForTransactionReceipt } from '@wagmi/core'
import { formatUnits, keccak256, toBytes } from 'viem'
import { wagmiConfig } from '@/lib/wagmi'
import { CONTRACT_ADDRESSES, type SupportedChainId } from '@/lib/contracts'

// ── Role hashes ──────────────────────────────────────────────────────────────

const ORACLE_ROLE = keccak256(toBytes('ORACLE_ROLE'))
const PAUSER_ROLE = keccak256(toBytes('PAUSER_ROLE'))

// ── ABIs ─────────────────────────────────────────────────────────────────────

const ERC20_ABI = [
  {
    name: 'totalSupply',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
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
    name: 'paused',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'cumulativeFundingPerYES',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'hasRole',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'role', type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'pause',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    name: 'unpause',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  {
    name: 'accrueFunding',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
] as const

const ORACLE_ROUTER_ABI = [
  {
    name: 'hasRole',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'role', type: 'bytes32' },
      { name: 'account', type: 'address' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'confirmCreditEvent',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
] as const

// ── Helpers ───────────────────────────────────────────────────────────────────

const ZERO_ADDR = '0x0000000000000000000000000000000000000000' as const

function pctDisplay(raw: bigint): string {
  return `${(Number(raw) / 1e18 * 100).toFixed(2)}%`
}

function tokenDisplay(raw: bigint): string {
  return parseFloat(formatUnits(raw, 6)).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

function usdcDisplay(raw: bigint): string {
  return `$${parseFloat(formatUnits(raw, 6)).toFixed(2)}`
}

type TxStatus = 'idle' | 'pending' | 'success' | 'error'

// ── Component ─────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const addrs = CONTRACT_ADDRESSES[chainId as SupportedChainId] ?? CONTRACT_ADDRESSES[84532]

  const [confirmModal, setConfirmModal] = useState(false)
  const [creditEventStatus, setCreditEventStatus] = useState<TxStatus>('idle')
  const [creditEventError, setCreditEventError] = useState('')
  const [pauseStatus, setPauseStatus] = useState<TxStatus>('idle')
  const [pauseError, setPauseError] = useState('')
  const [lastPauseAction, setLastPauseAction] = useState<'pause' | 'unpause' | null>(null)
  const [fundingStatus, setFundingStatus] = useState<TxStatus>('idle')
  const [fundingError, setFundingError] = useState('')

  const { writeContractAsync } = useWriteContract()
  const userAddr = address ?? ZERO_ADDR

  // ── Batched reads ──────────────────────────────────────────────────────────

  const { data, isLoading, refetch } = useReadContracts({
    contracts: [
      // [0] currentMark
      { address: addrs.creditMarket, abi: CREDIT_MARKET_ABI, functionName: 'currentMark' },
      // [1] YES totalSupply
      { address: addrs.yesToken, abi: ERC20_ABI, functionName: 'totalSupply' },
      // [2] NO totalSupply
      { address: addrs.noToken, abi: ERC20_ABI, functionName: 'totalSupply' },
      // [3] USDC balance of CreditMarket
      {
        address: addrs.usdc,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [addrs.creditMarket],
      },
      // [4] creditEventConfirmed
      {
        address: addrs.creditMarket,
        abi: CREDIT_MARKET_ABI,
        functionName: 'creditEventConfirmed',
      },
      // [5] paused
      { address: addrs.creditMarket, abi: CREDIT_MARKET_ABI, functionName: 'paused' },
      // [6] cumulativeFundingPerYES
      {
        address: addrs.creditMarket,
        abi: CREDIT_MARKET_ABI,
        functionName: 'cumulativeFundingPerYES',
      },
      // [7] hasRole(ORACLE_ROLE, address) on OracleRouter
      {
        address: addrs.oracleRouter,
        abi: ORACLE_ROUTER_ABI,
        functionName: 'hasRole',
        args: [ORACLE_ROLE, userAddr],
      },
      // [8] hasRole(PAUSER_ROLE, address) on CreditMarket
      {
        address: addrs.creditMarket,
        abi: CREDIT_MARKET_ABI,
        functionName: 'hasRole',
        args: [PAUSER_ROLE, userAddr],
      },
    ],
    query: { enabled: !!address },
  })

  const currentMark          = data?.[0]?.result as bigint  | undefined
  const yesTotalSupply       = data?.[1]?.result as bigint  | undefined
  const noTotalSupply        = data?.[2]?.result as bigint  | undefined
  const usdcBalance          = data?.[3]?.result as bigint  | undefined
  const creditEventConfirmed = data?.[4]?.result as boolean | undefined
  const isPaused             = data?.[5]?.result as boolean | undefined
  const cumulativeFunding    = data?.[6]?.result as bigint  | undefined
  const hasOracleRole        = data?.[7]?.result as boolean | undefined
  const hasPauserRole        = data?.[8]?.result as boolean | undefined

  // ── Transactions ──────────────────────────────────────────────────────────

  const handleConfirmCreditEvent = useCallback(async () => {
    if (!address) return
    setConfirmModal(false)
    setCreditEventStatus('pending')
    setCreditEventError('')
    try {
      const hash = await writeContractAsync({
        address: addrs.oracleRouter,
        abi: ORACLE_ROUTER_ABI,
        functionName: 'confirmCreditEvent',
      })
      await waitForTransactionReceipt(wagmiConfig, { hash })
      setCreditEventStatus('success')
      refetch()
    } catch (e: unknown) {
      setCreditEventStatus('error')
      const msg = e instanceof Error ? e.message : 'Transaction failed'
      setCreditEventError(
        msg.includes('User rejected') || msg.includes('4001') ? 'Rejected by wallet' : msg,
      )
    }
  }, [address, addrs, writeContractAsync, refetch])

  const handlePauseToggle = useCallback(async () => {
    if (!address || isPaused === undefined) return
    const action = isPaused ? 'unpause' : 'pause'
    setLastPauseAction(action)
    setPauseStatus('pending')
    setPauseError('')
    try {
      const hash = await writeContractAsync({
        address: addrs.creditMarket,
        abi: CREDIT_MARKET_ABI,
        functionName: action,
      })
      await waitForTransactionReceipt(wagmiConfig, { hash })
      setPauseStatus('success')
      refetch()
    } catch (e: unknown) {
      setPauseStatus('error')
      const msg = e instanceof Error ? e.message : 'Transaction failed'
      setPauseError(
        msg.includes('User rejected') || msg.includes('4001') ? 'Rejected by wallet' : msg,
      )
    }
  }, [address, addrs, isPaused, writeContractAsync, refetch])

  const handleAccrueFunding = useCallback(async () => {
    if (!address) return
    setFundingStatus('pending')
    setFundingError('')
    try {
      const hash = await writeContractAsync({
        address: addrs.creditMarket,
        abi: CREDIT_MARKET_ABI,
        functionName: 'accrueFunding',
      })
      await waitForTransactionReceipt(wagmiConfig, { hash })
      setFundingStatus('success')
      refetch()
    } catch (e: unknown) {
      setFundingStatus('error')
      const msg = e instanceof Error ? e.message : 'Transaction failed'
      setFundingError(
        msg.includes('User rejected') || msg.includes('4001') ? 'Rejected by wallet' : msg,
      )
    }
  }, [address, addrs, writeContractAsync, refetch])

  // ── Not connected ──────────────────────────────────────────────────────────

  if (!isConnected) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
        <WarningBanner />
        <h1 className="text-2xl font-bold text-slate-100">Admin</h1>
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-10 text-center">
          <p className="text-slate-400">Connect your wallet to access admin controls.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <WarningBanner />

      <div>
        <h1 className="text-2xl font-bold text-slate-100">Admin</h1>
        <p className="mt-1 text-sm text-slate-400">
          Will MicroStrategy have a credit event in the next 12 months?
        </p>
      </div>

      {/* Role status */}
      <div className="flex flex-wrap gap-3">
        <RoleBadge label="ORACLE_ROLE" granted={hasOracleRole} loading={isLoading} />
        <RoleBadge label="PAUSER_ROLE" granted={hasPauserRole} loading={isLoading} />
      </div>

      {/* ── 1. Market Status ──────────────────────────────────────────────────── */}
      <Section title="Market Status">
        {isLoading ? (
          <div className="h-28 animate-pulse rounded bg-slate-800" />
        ) : (
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
            <Stat
              label="Current probability"
              value={currentMark !== undefined ? pctDisplay(currentMark) : '—'}
            />
            <Stat
              label="YES supply"
              value={yesTotalSupply !== undefined ? `${tokenDisplay(yesTotalSupply)} YES` : '—'}
            />
            <Stat
              label="NO supply"
              value={noTotalSupply !== undefined ? `${tokenDisplay(noTotalSupply)} NO` : '—'}
            />
            <Stat
              label="USDC in contract"
              value={usdcBalance !== undefined ? usdcDisplay(usdcBalance) : '—'}
            />
            <Stat
              label="Credit event"
              value={
                creditEventConfirmed === undefined
                  ? '—'
                  : creditEventConfirmed
                  ? 'Confirmed'
                  : 'Not triggered'
              }
              highlight={creditEventConfirmed === true}
            />
            <Stat
              label="Market status"
              value={isPaused === undefined ? '—' : isPaused ? 'Paused' : 'Active'}
              warn={isPaused === true}
            />
          </div>
        )}
      </Section>

      {/* ── 2. Credit Event Controls ──────────────────────────────────────────── */}
      <Section title="Credit Event Controls">
        <div className="space-y-3">
          {creditEventConfirmed && (
            <div className="rounded-lg border border-emerald-800/50 bg-emerald-950/40 px-4 py-3 text-sm text-emerald-300">
              Credit event confirmed. YES holders can now settle at $1.00.
            </div>
          )}
          <p className="text-sm text-slate-400">
            Confirms a credit event on-chain. Pauses the market and enables YES settlement
            at $1.00 per token. <span className="text-red-400 font-medium">Irreversible.</span>
          </p>
          <button
            onClick={() => setConfirmModal(true)}
            disabled={
              !hasOracleRole ||
              creditEventConfirmed === true ||
              creditEventStatus === 'pending'
            }
            className="rounded-lg bg-red-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {creditEventStatus === 'pending' ? 'Confirming…' : 'Confirm Credit Event'}
          </button>
          {!hasOracleRole && (
            <p className="text-xs text-slate-500">Requires ORACLE_ROLE on OracleRouter.</p>
          )}
          {creditEventStatus === 'success' && (
            <p className="text-xs text-emerald-400">Credit event confirmed on-chain.</p>
          )}
          {creditEventStatus === 'error' && creditEventError && (
            <p className="text-xs text-red-400">{creditEventError}</p>
          )}
        </div>
      </Section>

      {/* ── 3. Market Controls ────────────────────────────────────────────────── */}
      <Section title="Market Controls">
        <div className="space-y-3">
          <p className="text-sm text-slate-400">
            Pausing halts mint and redeem. Use during credit event determination window.
          </p>
          <button
            onClick={handlePauseToggle}
            disabled={
              !hasPauserRole ||
              isPaused === undefined ||
              pauseStatus === 'pending'
            }
            className={`rounded-lg px-5 py-2.5 text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              isPaused
                ? 'bg-emerald-700 hover:bg-emerald-600 text-white'
                : 'bg-amber-700 hover:bg-amber-600 text-white'
            }`}
          >
            {pauseStatus === 'pending'
              ? 'Processing…'
              : isPaused
              ? 'Unpause Market'
              : 'Pause Market'}
          </button>
          {!hasPauserRole && (
            <p className="text-xs text-slate-500">Requires PAUSER_ROLE on CreditMarket.</p>
          )}
          {pauseStatus === 'success' && lastPauseAction && (
            <p className="text-xs text-emerald-400">
              Market {lastPauseAction === 'pause' ? 'paused' : 'unpaused'} successfully.
            </p>
          )}
          {pauseStatus === 'error' && pauseError && (
            <p className="text-xs text-red-400">{pauseError}</p>
          )}
        </div>
      </Section>

      {/* ── 4. Funding ────────────────────────────────────────────────────────── */}
      <Section title="Funding Accrual">
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-slate-400">Cumulative funding per YES</span>
            <span className="font-mono text-slate-200">
              {cumulativeFunding !== undefined
                ? formatUnits(cumulativeFunding, 18)
                : '—'}
            </span>
          </div>
          <p className="text-xs text-slate-500">
            The funding keeper runs every 8h automatically. Trigger manually here if needed.
          </p>
          <button
            onClick={handleAccrueFunding}
            disabled={fundingStatus === 'pending'}
            className="rounded-lg border border-slate-600 bg-slate-800 px-5 py-2.5 text-sm font-semibold text-slate-200 hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {fundingStatus === 'pending' ? 'Accruing…' : 'Trigger Funding Accrual'}
          </button>
          {fundingStatus === 'success' && (
            <p className="text-xs text-emerald-400">
              Funding accrued. Updated cumulative shown above.
            </p>
          )}
          {fundingStatus === 'error' && fundingError && (
            <p className="text-xs text-red-400">{fundingError}</p>
          )}
        </div>
      </Section>

      {/* ── Confirm modal ─────────────────────────────────────────────────────── */}
      {confirmModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setConfirmModal(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-red-900 bg-slate-950 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-lg font-bold text-red-400">Confirm Credit Event</h2>
            <p className="mt-3 text-sm text-slate-300">
              This will trigger settlement for all YES holders. YES tokens will redeem at
              $1.00 USDC each. NO tokens will be worth $0.
            </p>
            <p className="mt-2 text-sm font-semibold text-red-400">
              This action is irreversible.
            </p>
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setConfirmModal(false)}
                className="flex-1 rounded-lg border border-slate-700 bg-slate-800 py-2.5 text-sm font-medium text-slate-300 hover:bg-slate-700 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmCreditEvent}
                className="flex-1 rounded-lg bg-red-700 py-2.5 text-sm font-semibold text-white hover:bg-red-600 transition-colors"
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────────────────

function WarningBanner() {
  return (
    <div className="rounded-lg border border-amber-700/60 bg-amber-950/40 px-4 py-3 text-sm font-semibold text-amber-300">
      Internal tool. Authorized personnel only.
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-5">
      <h2 className="mb-4 text-xs font-semibold uppercase tracking-wider text-slate-400">
        {title}
      </h2>
      {children}
    </div>
  )
}

function RoleBadge({
  label,
  granted,
  loading,
}: {
  label: string
  granted: boolean | undefined
  loading: boolean
}) {
  if (loading) {
    return <div className="h-7 w-36 animate-pulse rounded-full bg-slate-800" />
  }
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${
        granted
          ? 'border-emerald-700/50 bg-emerald-950/60 text-emerald-300'
          : 'border-slate-700 bg-slate-900 text-slate-500'
      }`}
    >
      {granted ? '✓' : '✗'} {label}{granted ? '' : ' — no access'}
    </span>
  )
}

function Stat({
  label,
  value,
  highlight = false,
  warn = false,
}: {
  label: string
  value: string
  highlight?: boolean
  warn?: boolean
}) {
  const valueClass = highlight ? 'text-emerald-400' : warn ? 'text-amber-400' : 'text-slate-100'
  return (
    <div>
      <p className="mb-0.5 text-xs text-slate-500">{label}</p>
      <p className={`text-sm font-semibold ${valueClass}`}>{value}</p>
    </div>
  )
}
