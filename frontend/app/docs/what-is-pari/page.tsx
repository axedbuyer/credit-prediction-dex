import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'What is Pari — Pari Docs',
}

export default function WhatIsPariPage() {
  return (
    <div>
      <h1>What is Pari</h1>
      <p>
        Pari lets you trade a single question: <strong>&ldquo;Will MicroStrategy have a
        credit event in the next 12 months?&rdquo;</strong> The price is the market&rsquo;s
        answer, as a probability.
      </p>
      <p>
        An <strong>Upbet</strong> pays <strong>$1.00</strong> if a credit event is
        confirmed. A <strong>Downbet</strong> pays nothing if one is confirmed — but it
        earns <strong>daily carry</strong> the whole time nothing happens. If the market
        says 23%, an Upbet costs about 23¢ and a Downbet about 77¢.
      </p>
      <p>
        Think of it like insurance on a company&rsquo;s debt: an Upbet pays a little every
        day to hold, and pays out in full if things go wrong. A Downbet is the other
        side — you collect that daily payment for taking on the risk. In TradFi a similar
        instrument exists (the credit default swap), but it&rsquo;s only accessible to
        institutions — Pari makes the same risk tradable by anyone.
      </p>
      <p>
        <em>Tradable credit for all.</em>
      </p>

      <h2>What makes Pari different from a normal prediction market</h2>
      <ol>
        <li>
          <strong>Perpetual</strong> — no expiry date. The question is always &ldquo;the
          <em> next</em> 12 months,&rdquo; a rolling window, so there&rsquo;s no series of
          dated markets to roll between.
        </li>
        <li>
          <strong>Daily carry</strong> keeps a perpetual market honest: without it,
          &ldquo;no credit event yet&rdquo; would never actually pay Downbet holders. Carry
          is how time passing turns into profit for Downbets and cost for Upbets.
        </li>
        <li>
          <strong>Fully collateralized</strong> — every Upbet/Downbet pair is backed 1:1 by
          $1 of USDC in the contract. No leverage, no margin calls on the mark. You can
          never lose more than you put in.
        </li>
      </ol>

      <h2>Credit events covered (MVP)</h2>
      <p>Two events settle the market: Bankruptcy and Failure to Pay. See <Link href="/docs/credit-events">Credit events</Link> for exact definitions.</p>

      <h2>Where to next</h2>
      <p>
        <Link href="/docs/core-concepts">Core concepts</Link> →{' '}
        <Link href="/docs/trading-and-fees">Trading &amp; fees</Link> →{' '}
        <Link href="/docs/mark-to-market-and-carry">Mark-to-market &amp; carry</Link>
      </p>
    </div>
  )
}
