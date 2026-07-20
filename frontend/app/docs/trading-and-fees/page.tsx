import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Trading & fees — Pari Docs',
}

export default function TradingAndFeesPage() {
  return (
    <div>
      <h1>Trading &amp; fees</h1>

      <h2>Order book</h2>
      <p>
        Pari uses a central limit order book: you place a limit order at your price; when it
        crosses a resting order on the other side, it fills. Matching happens off-chain
        (fast, gas-free to place/cancel); settlement of a matched trade happens on-chain in
        USDC, atomically. Orders are signed messages from your wallet — placing and
        cancelling costs no gas; the settlement transaction itself is submitted by
        Pari&rsquo;s matching engine.
      </p>

      <h2>Placing an order</h2>
      <p>
        From the Market page: pick Upbet or Downbet, buy or sell, price and size; sign the
        order in your wallet. Orders have an expiry; unfilled orders can be cancelled
        anytime.
      </p>

      <h2>The trade fee</h2>
      <div className="docs-formula">{'fee = 0.50% × min(p, 1−p) × size'}</div>
      <p>
        where <code>p</code> is the trade price and <code>size</code> is the position size
        in $.
      </p>
      <ul>
        <li>
          The fee is charged <strong>only on the carry-earning side of a trade</strong>:
          selling an Upbet or buying a Downbet. Buying an Upbet or selling a Downbet is{' '}
          <strong>fee-free</strong>. Maker vs taker doesn&rsquo;t matter.
        </li>
        <li>
          Why <code>min(p, 1−p)</code>: buying a Downbet at 77¢ and &ldquo;minting a set
          then selling the Upbet at 23¢&rdquo; are the same economic trade — the fee is
          based on the smaller leg so both routes cost the same and there&rsquo;s no way
          around it.
        </li>
        <li>
          Worked example at a 23% market: sell 100 Upbets at 23¢ → fee = 0.50% × 0.23 ×
          $100 = $0.115. Buy 100 Downbets at 77¢ → same $0.115 fee, added on top of the $77
          cost.
        </li>
        <li>
          Downbet buys: the total you sign for <strong>includes</strong> the fee (the app
          shows &ldquo;Total … includes … trade fee&rdquo;). Upbet sells: the fee comes out
          of your proceeds.
        </li>
        <li>
          Fees go 50/50 to the Pari team wallet and the market&rsquo;s{' '}
          <strong>insurance fund</strong> (which backstops liquidations — see{' '}
          <Link href="/docs/liquidations-and-cure">Liquidations &amp; cure</Link>). Fees
          never touch the $1-per-set collateral backing positions.
        </li>
      </ul>

      <h2>When a sale can be rejected</h2>
      <p>
        Selling an Upbet also settles your accrued carry (see{' '}
        <Link href="/docs/mark-to-market-and-carry">Mark-to-market &amp; carry</Link>). If
        your sale proceeds at your chosen price wouldn&rsquo;t cover the carry you owe plus
        the fee, the order is rejected and <strong>nothing changes</strong> — your position
        is untouched. The app shows the minimum sell price that would go through. This only
        happens when a position is very close to liquidation territory AND the price is very
        low; raising your limit price one tick is usually the fix.
      </p>
    </div>
  )
}
