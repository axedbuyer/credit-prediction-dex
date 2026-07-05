'use client'

import Link from 'next/link'
import { useReadContract } from 'wagmi'
import { formatUnits } from 'viem'
import { CONTRACT_ADDRESSES } from '@/lib/contracts'
import { CREDIT_MARKET_ABI } from '@/lib/creditMarketAbi'
import { MSTR_MARKET } from '@/lib/constants'

const addrs = CONTRACT_ADDRESSES[84532]

function pctDisplay(mark: bigint | undefined): string {
  if (mark === undefined) return '—'
  return `${(parseFloat(formatUnits(mark, 18)) * 100).toFixed(1)}%`
}

export default function Home() {
  const { data: currentMark, isLoading, isError } = useReadContract({
    address: addrs.creditMarket,
    abi: CREDIT_MARKET_ABI,
    functionName: 'currentMark',
  })

  const markDisplay = isLoading || isError ? '—' : pctDisplay(currentMark as bigint | undefined)

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
          <Link href="/market/mstr" className="pari-a-btn pari-a-btn--primary pari-a-btn--lg">
            Trade Now
          </Link>
        </div>
      </section>

      {/* ── Live market card ─────────────────────────────────────────────── */}
      <section>
        <Link href="/market/mstr" className="block">
          <div className="pari-a-card transition-colors hover:border-brand-em cursor-pointer">
            <p className="pari-a-card__eyebrow">Senior Unsecured · Perpetual</p>
            <h2 className="pari-a-card__title">Microstrategy</h2>
            <p className="pari-a-card__value tabular">{markDisplay}</p>
            <p className="pari-a-card__meta">{MSTR_MARKET.name}</p>
            <p className="pari-a-card__meta text-teal">
              Downbet earns ≈{markDisplay} annualized
            </p>
          </div>
        </Link>
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
