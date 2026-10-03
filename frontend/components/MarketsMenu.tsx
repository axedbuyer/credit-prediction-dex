'use client'

import Link from 'next/link'
import { useReadContract } from 'wagmi'
import { formatUnits } from 'viem'
import { CREDIT_MARKET_ABI } from '@/lib/creditMarketAbi'
import { useActiveMarkets, type Market } from '@/lib/markets'
import { entityTypeLabel } from '@/lib/marketCopy'

// One row per active market: entity, type, live "x% chance". Same currentMark query
// (and refetch interval) as the home-page cards, so wagmi shares the cache.
function MarketRow({ market }: { market: Market }) {
  const { data } = useReadContract({
    address: market.creditMarket,
    abi: CREDIT_MARKET_ABI,
    functionName: 'currentMark',
    query: { refetchInterval: 15_000 },
  })
  const pct = data !== undefined ? parseFloat(formatUnits(data as bigint, 18)) * 100 : undefined

  return (
    <Link
      href={`/market/${market.slug}`}
      className="flex items-center justify-between gap-6 rounded px-3 py-2 hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
    >
      <span>
        <span className="block text-sm text-text-1">{market.entityName}</span>
        <span className="block text-xs text-text-muted">{entityTypeLabel(market.entityType)}</span>
      </span>
      <span className="text-sm tabular text-text-2">{pct !== undefined ? `${pct.toFixed(1)}% chance` : '—'}</span>
    </Link>
  )
}

// "Markets" nav item with a hover / keyboard-focus dropdown of every active market.
// The link itself still goes to the full market list on `/`.
export function MarketsMenu({ isActive }: { isActive: boolean }) {
  const { markets, isLoading } = useActiveMarkets()

  return (
    <div className="group relative">
      <Link
        href="/"
        aria-haspopup="menu"
        className={
          isActive
            ? 'text-sm text-teal transition-colors'
            : 'text-sm text-text-2 hover:text-text-1 transition-colors'
        }
      >
        Markets <span aria-hidden className="text-xs">▾</span>
      </Link>

      {/* pt-3 bridges the gap so the pointer can travel from the link into the panel */}
      <div className="invisible absolute left-0 top-full pt-3 opacity-0 transition-opacity group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100">
        <div role="menu" className="min-w-[280px] rounded border border-subtle bg-surface-1 p-2 shadow-lg">
          {isLoading ? (
            <p className="px-3 py-2 text-sm text-text-muted">Loading markets…</p>
          ) : markets.length === 0 ? (
            <p className="px-3 py-2 text-sm text-text-muted">No markets are open right now.</p>
          ) : (
            markets.map((m) => <MarketRow key={m.slug} market={m} />)
          )}
          <div className="mt-1 border-t border-subtle pt-1">
            <Link href="/#markets" className="block rounded px-3 py-2 text-xs text-text-2 hover:bg-surface-2 hover:text-text-1">
              All markets
            </Link>
          </div>
        </div>
      </div>
    </div>
  )
}
