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
        <h1 className="font-serif text-2xl text-text-1">Admin</h1>
        <div className="pari-a-card text-center">
          <p className="text-text-2">Connect your wallet to access admin controls.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 space-y-6">
      <WarningBanner />

      <div>
        <h1 className="font-serif text-2xl text-text-1">Admin</h1>
        <p className="mt-1 text-sm text-text-2">
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
          <div className="h-28 animate-pulse rounded bg-surface-2" />
        ) : (
          <div className="grid grid-cols-2 gap-x-8 gap-y-4 sm:grid-cols-3">
            <Stat
              label="Current probability"
              value={currentMark !== undefined ? pctDisplay(currentMark) : '—'}
            />
            <Stat
              label="Upbet supply"
              value={yesTotalSupply !== undefined ? `${tokenDisplay(yesTotalSupply)} Upbet` : '—'}
            />
            <Stat
              label="Downbet supply"
              value={noTotalSupply !== undefined ? `${tokenDisplay(noTotalSupply)} Downbet` : '—'}
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
            <div className="rounded border border-success/30 bg-success/10 px-4 py-3 text-sm text-success">
              Credit event confirmed. Upbet holders can now settle at $1.00.
            </div>
          )}
          <p className="text-sm text-text-2">
            Confirms a credit event on-chain. Pauses the market and enables Upbet holders
            to settle at $1.00 each. <span className="text-danger font-medium">Irreversible.</span>
          </p>
          <button
            onClick={() => setConfirmModal(true)}
            disabled={
              !hasOracleRole ||
              creditEventConfirmed === true ||
              creditEventStatus === 'pending'
            }
            className="pari-a-btn pari-a-btn--danger"
          >
            {creditEventStatus === 'pending' ? 'Confirming…' : 'Confirm Credit Event'}
          </button>
          {!hasOracleRole && (
            <p className="text-xs text-text-muted">Requires ORACLE_ROLE on OracleRouter.</p>
          )}
          {creditEventStatus === 'success' && (
            <p className="text-xs text-success">Credit event confirmed on-chain.</p>
          )}
          {creditEventStatus === 'error' && creditEventError && (
            <p className="text-xs text-danger">{creditEventError}</p>
          )}
        </div>
      </Section>

      {/* ── 3. Market Controls ────────────────────────────────────────────────── */}
      <Section title="Market Controls">
        <div className="space-y-3">
          <p className="text-sm text-text-2">
            Pausing halts mint and redeem. Use during credit event determination window.
          </p>
          <button
            onClick={handlePauseToggle}
            disabled={
              !hasPauserRole ||
              isPaused === undefined ||
              pauseStatus === 'pending'
            }
            className={isPaused ? 'pari-a-btn pari-a-btn--primary' : 'pari-a-btn pari-a-btn--secondary'}
            style={!isPaused ? { borderColor: 'var(--color-warning)', color: 'var(--color-warning)' } : undefined}
          >
            {pauseStatus === 'pending'
              ? 'Processing…'
              : isPaused
              ? 'Unpause Market'
              : 'Pause Market'}
          </button>
          {!hasPauserRole && (
            <p className="text-xs text-text-muted">Requires PAUSER_ROLE on CreditMarket.</p>
          )}
          {pauseStatus === 'success' && lastPauseAction && (
            <p className="text-xs text-success">
              Market {lastPauseAction === 'pause' ? 'paused' : 'unpaused'} successfully.
            </p>
          )}
          {pauseStatus === 'error' && pauseError && (
            <p className="text-xs text-danger">{pauseError}</p>
          )}
        </div>
      </Section>

      {/* ── 4. Funding ────────────────────────────────────────────────────────── */}
      <Section title="Funding Accrual">
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-text-2">Cumulative carry per Upbet</span>
            <span className="font-mono tabular text-text-1">
              {cumulativeFunding !== undefined
                ? formatUnits(cumulativeFunding, 18)
                : '—'}
            </span>
          </div>
          <p className="text-xs text-text-muted">
            The funding keeper runs every 8h automatically. Trigger manually here if needed.
          </p>
          <button
            onClick={handleAccrueFunding}
            disabled={fundingStatus === 'pending'}
            className="pari-a-btn pari-a-btn--secondary"
          >
            {fundingStatus === 'pending' ? 'Accruing…' : 'Trigger Funding Accrual'}
          </button>
          {fundingStatus === 'success' && (
            <p className="text-xs text-success">
              Funding accrued. Updated cumulative shown above.
            </p>
          )}
          {fundingStatus === 'error' && fundingError && (
            <p className="text-xs text-danger">{fundingError}</p>
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
            className="w-full max-w-md rounded border border-danger-a28 bg-surface-1 p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-serif text-lg text-danger">Confirm Credit Event</h2>
            <p className="mt-3 text-sm text-text-2">
              This will trigger settlement for all Upbet holders. Upbet redeems at
              $1.00 USDC each. Downbet will be worth $0.
            </p>
            <p className="mt-2 text-sm font-semibold text-danger">
              This action is irreversible.
            </p>
            <div className="mt-6 flex gap-3">
              <button
                onClick={() => setConfirmModal(false)}
                className="pari-a-btn pari-a-btn--secondary flex-1"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmCreditEvent}
                className="pari-a-btn pari-a-btn--danger flex-1"
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
    <div className="rounded border border-warning/40 bg-warning/10 px-4 py-3 text-sm font-semibold text-warning">
      Internal tool. Authorized personnel only.
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pari-a-card">
      <h2 className="mb-4 text-[11px] font-semibold uppercase tracking-[0.22em] text-text-muted">
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
    return <div className="h-7 w-36 animate-pulse rounded-full bg-surface-2" />
  }
  return (
    <span className={`pari-badge ${granted ? 'pari-badge--success' : 'pari-badge--neutral'}`}>
      {label}{granted ? '' : ' — no access'}
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
  const valueClass = highlight ? 'text-success' : warn ? 'text-warning' : 'text-text-1'
  return (
    <div>
      <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-[0.22em] text-text-muted">{label}</p>
      <p className={`font-serif text-sm tabular ${valueClass}`}>{value}</p>
    </div>
  )
}
