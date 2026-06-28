'use client'

import { useEffect, useState } from 'react'
import { LiquidationCard, DEV_POSITIONS, type ClaimablePosition } from '@/components/LiquidationCard'
import { LIQUIDATION_KEEPER_URL } from '@/lib/constants'

const POLL_MS = 10_000

export default function LiquidatePage() {
  const [positions, setPositions]   = useState<ClaimablePosition[]>([])
  const [loading, setLoading]       = useState(true)
  const [error, setError]           = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)

  useEffect(() => {
    let mounted = true

    async function fetchPositions() {
      try {
        const res = await fetch(`${LIQUIDATION_KEEPER_URL}/claimable`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data: ClaimablePosition[] = await res.json()
        if (mounted) {
          setPositions(data)
          setError('')
          setLastUpdated(new Date())
          setLoading(false)
        }
      } catch {
        if (mounted) {
          // In development, fall back to fixture data if keeper isn't running.
          if (process.env.NODE_ENV === 'development' && positions.length === 0) {
            setPositions(DEV_POSITIONS)
          }
          setError('Could not reach liquidation keeper')
          setLoading(false)
        }
      }
    }

    fetchPositions()
    const id = setInterval(fetchPositions, POLL_MS)
    return () => {
      mounted = false
      clearInterval(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const hasPositions = positions.length > 0

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      {/* Page header */}
      <h1 className="text-2xl font-bold text-slate-100">Liquidations</h1>
      <p className="mt-2 max-w-xl text-sm leading-relaxed text-slate-400">
        Positions where accrued funding has nearly consumed the token&apos;s value are listed
        here. Claim to acquire the position at a fixed formulaic price, then resell. NO
        holders are unaffected and are made whole as part of every claim.
      </p>

      {/* Connection status */}
      <div className="mt-4 flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full ${error ? 'bg-red-500' : 'bg-emerald-500'}`}
        />
        <span className="text-xs text-slate-500">
          {error
            ? error + (hasPositions && process.env.NODE_ENV === 'development' ? ' — showing dev fixtures' : '')
            : lastUpdated
            ? `Updated ${lastUpdated.toLocaleTimeString()}`
            : 'Connecting…'}
        </span>
        {!error && (
          <span className="text-xs text-slate-600">· refreshes every 10s</span>
        )}
      </div>

      <div className="mt-6 space-y-4">
        {/* Loading skeleton */}
        {loading && (
          <>
            <div className="h-44 animate-pulse rounded-lg border border-slate-800 bg-slate-900" />
            <div className="h-44 animate-pulse rounded-lg border border-slate-800 bg-slate-900" />
          </>
        )}

        {/* Empty state */}
        {!loading && !hasPositions && (
          <div className="rounded-lg border border-slate-800 bg-slate-900 p-10 text-center">
            <p className="text-slate-400">No claimable positions right now.</p>
            <p className="mt-1 text-xs text-slate-600">
              The keeper checks for new positions every 10 seconds.
            </p>
          </div>
        )}

        {/* Position cards */}
        {hasPositions &&
          positions.map((pos) => (
            <LiquidationCard key={pos.user} position={pos} />
          ))}
      </div>

      {/* Price model note */}
      <div className="mt-10 rounded-lg border border-slate-800 bg-slate-900/50 px-5 py-4">
        <p className="text-xs font-semibold text-slate-400">How pricing works</p>
        <p className="mt-1 text-xs leading-relaxed text-slate-500">
          Claim price P = min(accrued funding owed, token value). In the normal case P is
          slightly below token value — the difference (~3%) is your profit margin for
          performing the seizure. In the tail case (funding exceeds token value) the
          insurance fund covers the shortfall so NO holders are always made whole.
          YES tokens transfer to you, never burned — resell on the market to close the
          position.
        </p>
      </div>
    </div>
  )
}
