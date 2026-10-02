'use client'

import Link from 'next/link'
import { useReadContract } from 'wagmi'
import { formatUnits } from 'viem'
import { CREDIT_MARKET_ABI } from '@/lib/creditMarketAbi'
import { useMarkets, type Market } from '@/lib/markets'
import { entityTypeLabel } from '@/lib/marketCopy'

function pctNumber(mark: bigint): number {
  return parseFloat(formatUnits(mark, 18)) * 100
}

function MarketCard({ market }: { market: Market }) {
  const { data: currentMark, isLoading, isError } = useReadContract({
    address: market.creditMarket,
    abi: CREDIT_MARKET_ABI,
    functionName: 'currentMark',
    query: { refetchInterval: 15_000 },
  })

  const mark = isLoading || isError ? undefined : (currentMark as bigint | undefined)
  const pct = mark !== undefined ? pctNumber(mark) : undefined
  const chance = pct !== undefined ? `${pct.toFixed(1)}% chance` : '—'
  const daily = pct !== undefined ? `${(pct / 365).toFixed(3)}%/day` : '—'

  return (
    <Link href={`/market/${market.slug}`} className="block">
      <div className="pari-a-card h-full transition-colors hover:border-brand-em cursor-pointer">
        <div className="flex items-center justify-between gap-2">
          <p className="pari-a-card__eyebrow">
            {market.entityType === 'sovereign' ? 'Sovereign Debt' : 'Senior Unsecured'} · Perpetual
          </p>
          <span className="pari-badge pari-badge--neutral">{entityTypeLabel(market.entityType)}</span>
        </div>
        <h2 className="pari-a-card__title">{market.entityName}</h2>
        <p className="pari-a-card__value tabular">{chance}</p>
        <p className="pari-a-card__meta">{market.title}</p>
        <p className="pari-a-card__meta">Daily carry {daily}</p>
        {!market.active && <p className="pari-a-card__meta text-warning">Closed to new orders</p>}
        {market.active && pct !== undefined && (
          <p className="pari-a-card__meta text-teal">Downbet earns ≈{pct.toFixed(1)}% annualized</p>
        )}
      </div>
    </Link>
  )
}

export default function Home() {
  const { markets, isLoading, isError } = useMarkets()
  const active = markets.filter((m) => m.active)

  return (
    <div className="mx-auto max-w-[1280px] px-6 py-20 sm:py-28 space-y-24">

      {/* ── Hero ──────────────────────────────────────────────────────────── */}
      <section className="max-w-3xl">
        <p className="pari-eyebrow mb-5">Pari · Credit Markets</p>
        <h1 className="font-serif text-[length:var(--text-5xl)] leading-[1.05] text-text-1">
          Tradable Credit For All
        </h1>
        <p className="mt-6 text-lg text-text-2">
          Real Credit · Real Yield · Real Marketplace
        </p>
        <div className="mt-10">
          <a href="#markets" className="pari-a-btn pari-a-btn--primary pari-a-btn--lg">
            Trade Now
          </a>
        </div>
      </section>

      {/* ── Live markets ─────────────────────────────────────────────────── */}
      <section id="markets">
        <p className="pari-eyebrow mb-5">Markets</p>
        {isLoading ? (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <div key={i} className="h-44 animate-pulse rounded border border-subtle bg-surface-1" />
            ))}
          </div>
        ) : isError ? (
          <p className="text-sm text-text-2">Couldn’t load markets right now. Please refresh in a moment.</p>
        ) : active.length === 0 ? (
          <p className="text-sm text-text-2">No markets are open right now.</p>
        ) : (
          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {active.map((m) => (
              <MarketCard key={m.slug} market={m} />
            ))}
          </div>
        )}
      </section>

      {/* ── Trade / Hedge / Earn ─────────────────────────────────────────── */}
      <section className="grid gap-6 sm:grid-cols-3">
        <div className="pari-a-card">
          <h3 className="pari-a-card__title">Trade</h3>
          <p className="pari-a-card__subtitle">
            Bet on the default probability of any institution to rise or fall. Price is
            set entirely by the market — not a model, not an oracle feed.
          </p>
        </div>
        <div className="pari-a-card">
          <h3 className="pari-a-card__title">Hedge</h3>
          <p className="pari-a-card__subtitle">
            Protect exposure to an institution&apos;s default — custodied assets, loaned
            capital, brokerage balances — without leaving the chain.
          </p>
        </div>
        <div className="pari-a-card">
          <h3 className="pari-a-card__title">Earn</h3>
          <p className="pari-a-card__subtitle">
            Collect real yield by taking on credit risk as a Downbetter. Income comes
            from credit risk — not token emissions.
          </p>
        </div>
      </section>
    </div>
  )
}
