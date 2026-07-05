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
      <h1 className="text-2xl font-bold uppercase tracking-wider text-text-1">Liquidations</h1>
      <p className="mt-2 max-w-xl text-xs font-semibold uppercase tracking-wider text-teal">
        Claimable Upbet positions · Formulaic price
      </p>
      <p className="mt-3 max-w-xl text-sm leading-relaxed text-text-2">
        Positions where accrued carry has nearly consumed the position&apos;s value are listed
        here. Claim to acquire the position at a fixed formulaic price, then resell. Downbet
        holders are unaffected and are made whole as part of every claim.
      </p>

      {/* Connection status */}
      <div className="mt-4 flex items-center gap-2">
        <span
          className={`h-2 w-2 rounded-full ${error ? 'bg-danger' : 'bg-success'}`}
        />
        <span className="text-xs text-text-muted">
          {error
            ? error + (hasPositions && process.env.NODE_ENV === 'development' ? ' — showing dev fixtures' : '')
            : lastUpdated
            ? `Updated ${lastUpdated.toLocaleTimeString()}`
            : 'Connecting…'}
        </span>
        {!error && (
          <span className="text-xs text-text-muted">· refreshes every 10s</span>
        )}
      </div>

      <div className="mt-6 space-y-4">
        {/* Loading skeleton */}
        {loading && (
          <>
            <div className="h-44 animate-pulse rounded-[1px] border border-subtle bg-surface-1" />
            <div className="h-44 animate-pulse rounded-[1px] border border-subtle bg-surface-1" />
          </>
        )}

        {/* Empty state */}
        {!loading && !hasPositions && (
          <div className="pari-b-card p-10 text-center">
            <p className="text-sm font-bold uppercase tracking-wider text-text-2">
              No claimable positions
            </p>
            <p className="mt-1 text-xs text-text-muted">
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
      <div className="mt-10 pari-b-card">
        <p className="pari-b-label">How pricing works</p>
        <p className="mt-2 text-xs leading-relaxed text-text-2">
          Claim price P = min(accrued carry owed, position value). In the normal case P is
          slightly below the position&apos;s value — the difference (~3%) is your profit
          margin for performing the seizure. In the tail case (carry owed exceeds the
          position&apos;s value) the insurance fund covers the shortfall so Downbet holders
          are always made whole. The Upbet position transfers to you, never burned — resell
          on the market to close it out.
        </p>
      </div>
    </div>
  )
}
