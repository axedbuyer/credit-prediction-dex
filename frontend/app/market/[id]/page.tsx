'use client'

import Link from 'next/link'
import { useMarket } from '@/lib/markets'
import { entityTypeLabel } from '@/lib/marketCopy'
import { OrderBook } from '@/components/OrderBook'
import { TradePanel } from '@/components/TradePanel'
import { PriceChart } from '@/components/PriceChart'
import { FundingTicker } from '@/components/FundingTicker'

// `id` is the market slug (e.g. /market/mstr) — resolved through the registry.
export default function MarketPage({ params }: { params: { id: string } }) {
  const { market, isLoading, isError, notFound } = useMarket(params.id)

  if (isLoading) {
    return (
      <div className="mx-auto max-w-[1280px] px-4 py-8">
        <div className="h-24 animate-pulse rounded border border-subtle bg-surface-1" />
      </div>
    )
  }

  if (isError) {
    return (
      <div className="mx-auto max-w-[1280px] px-4 py-8">
        <div className="pari-b-card p-10 text-center">
          <p className="text-sm text-text-2">Couldn’t load markets right now. Please refresh in a moment.</p>
        </div>
      </div>
    )
  }

  if (notFound || !market) {
    return (
      <div className="mx-auto max-w-[1280px] px-4 py-8">
        <div className="pari-b-card p-10 text-center">
          <h1 className="font-serif text-2xl text-text-1">Market not found</h1>
          <p className="mt-2 text-sm text-text-2">
            We couldn’t find a market called “{params.id}”.
          </p>
          <Link href="/" className="pari-a-btn pari-a-btn--primary mt-6 inline-flex">
            Browse all markets
          </Link>
        </div>
      </div>
    )
  }

  const { copy } = market

  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8">
      {/* Market header */}
      <div className="mb-6">
        <p className="pari-eyebrow mb-2">
          {[copy.ticker, 'Perpetual', entityTypeLabel(market.entityType), 'Credit Event Market']
            .filter(Boolean)
            .join(' · ')}
        </p>
        <h1 className="font-serif text-3xl text-text-1">{market.title}</h1>
        <p className="mt-1 text-sm text-text-2">
          {[copy.legalName ?? market.entityName, copy.creditEvents.join(' & '), 'Base'].join(' · ')}
        </p>
        {!market.active && (
          <p className="mt-2 text-xs text-warning">This market is closed to new orders.</p>
        )}
      </div>

      <div className="grid grid-cols-3 gap-4">
        {/* Row 1: chart + order book */}
        <div className="col-span-2 pari-b-card">
          <p className="pari-b-card__header">Mark History</p>
          <PriceChart market={market} />
        </div>
        <div className="pari-b-card">
          <p className="pari-b-card__header">Order Book</p>
          <OrderBook market={market} />
        </div>

        {/* Row 2: funding ticker + trade panel */}
        <div className="col-span-2">
          <FundingTicker market={market} />
        </div>
        <div className="pari-b-card">
          <TradePanel market={market} />
        </div>
      </div>
    </div>
  )
}
