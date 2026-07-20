import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Core concepts — Pari Docs',
}

export default function CoreConceptsPage() {
  return (
    <div>
      <h1>Core concepts</h1>

      <h2>The complete set</h2>
      <p>
        Deposit $1 of USDC → receive 1 Upbet + 1 Downbet. Any time before a credit event is
        confirmed, a pair of 1 Upbet + 1 Downbet redeems back for exactly $1. This is why
        prices always satisfy:
      </p>
      <div className="docs-formula">{'Upbet price + Downbet price = $1'}</div>

      <h2>The prediction-market analogy</h2>
      <p>
        If you&rsquo;ve traded on prediction markets like Polymarket, Upbet and Downbet are
        exactly like YES and NO shares on the question &ldquo;credit event in the next 12
        months?&rdquo; — a complete set costs $1, the winning side redeems for $1, the
        losing side goes to zero. The differences: this market never expires, and holding a
        side has a daily carry cashflow (covered on the next two pages).
      </p>

      <h2>Price = probability</h2>
      <p>
        The Upbet price <em>is</em> the market&rsquo;s implied annual probability of a
        credit event (&ldquo;23¢&rdquo; ⇔ &ldquo;23% annual probability&rdquo;). This
        probability-per-year is what&rsquo;s called a <em>hazard rate</em> in TradFi.
      </p>

      <h2>Directions</h2>
      <p>
        <strong>Upbet</strong> — you profit if the probability rises or an event is
        confirmed ($1.00 payout). <strong>Downbet</strong> — you profit if the probability
        falls, and you earn daily carry while you wait. On a confirmed credit event, Downbet
        goes to $0.
      </p>

      <h2>How positions move</h2>
      <p>
        All buying/selling happens on Pari&rsquo;s order book. Upbets and Downbets
        can&rsquo;t be sent wallet-to-wallet — every transfer runs through the market so
        carry is always settled correctly (and so balances shown in Pari are always right).
      </p>

      <div className="docs-callout">
        <p>
          Prices in this doc use a 23% market as the running example — the live market will
          differ.
        </p>
      </div>
    </div>
  )
}
