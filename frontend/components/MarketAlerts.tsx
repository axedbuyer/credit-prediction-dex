'use client'

// Market-page alerts (batch 4): a DC question open on this market, a confirmed credit
// event, and — for the connected wallet — an Upbet whose health is at Warning or
// Critical. On-site only (owner decision Q3): nothing is sent off-site.

import Link from 'next/link'
import { useAccount, useReadContracts } from 'wagmi'
import { CREDIT_MARKET_ABI } from '@/lib/creditMarketAbi'
import { usePositionHealth } from '@/lib/positionHealth'
import type { Market } from '@/lib/markets'

export function MarketAlerts({ market }: { market: Market }) {
  const { address } = useAccount()
  const { data } = useReadContracts({
    contracts: [
      { address: market.creditMarket, abi: CREDIT_MARKET_ABI, functionName: 'motionPending' },
      { address: market.creditMarket, abi: CREDIT_MARKET_ABI, functionName: 'creditEventConfirmed' },
    ],
    query: { refetchInterval: 60_000 },
  })
  const motionPending = data?.[0]?.result as boolean | undefined
  const confirmed = data?.[1]?.result as boolean | undefined
  const h = usePositionHealth(market, address)

  return (
    <div className="mb-4 space-y-3 empty:hidden">
      {confirmed && (
        <div className="rounded border border-success-a30 bg-success-a10 px-4 py-3">
          <p className="text-sm font-semibold text-success">Credit event confirmed</p>
          <p className="mt-0.5 text-xs text-text-2">
            Upbets settle at $1.00 each from your{' '}
            <Link href="/portfolio" className="underline">Portfolio</Link>. Downbets are worth $0.
          </p>
        </div>
      )}
      {!confirmed && motionPending && (
        <div className="rounded border border-warning-a40 bg-warning-a10 px-4 py-3">
          <p className="text-sm font-semibold text-warning">A DC question is open on this market</p>
          <p className="mt-0.5 text-xs leading-relaxed text-text-2">
            The Credit Derivatives Determinations Committee is deciding whether a credit event
            happened. Trading and liquidations continue. Carry from the day the question opened
            is held until the ruling: refunded to Upbet holders who paid it if the DC rules Yes,
            paid to Downbet holders if it rules No. Upbet holders: keep your carry paid.{' '}
            <Link href="/docs/credit-events" className="underline">How this works</Link>
          </p>
        </div>
      )}
      {(h.level === 'warning' || h.level === 'critical') && (
        <div className="rounded border border-danger-a28 bg-danger-a10 px-4 py-3">
          <p className="text-sm font-semibold text-danger">
            {h.level === 'critical' ? 'Your Upbet is close to liquidation' : 'Your Upbet is getting close to liquidation'}
          </p>
          <p className="mt-0.5 text-xs text-text-2">
            {h.runway !== undefined && h.runway < 10_000n ? `About ${h.runway} day${h.runway === 1n ? '' : 's'} of carry left at today’s chance. ` : ''}
            Pay carry from your <Link href="/portfolio" className="underline">Portfolio</Link> to reset the clock.
          </p>
        </div>
      )}
    </div>
  )
}
