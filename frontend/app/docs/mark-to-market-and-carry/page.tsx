import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Mark-to-market & carry — Pari Docs',
}

export default function MarkToMarketAndCarryPage() {
  return (
    <div>
      <h1>Mark-to-market &amp; carry</h1>

      <h2>Daily carry</h2>
      <p>
        Each day (each carry tick), an Upbet accrues carry per $1 of position of{' '}
        <code>Δf = m × Δt/365</code>, where <code>m</code> is the current price (e.g. 0.23)
        and <code>Δt</code> is the time since the last tick, in days. Stated for one day:
      </p>
      <div className="docs-formula">{'daily carry per $1 of position = m / 365        (m = current price, e.g. 0.23)'}</div>
      <p>
        Upbets <strong>pay</strong> carry; Downbets <strong>earn</strong> it, dollar for
        dollar. Intuition: the carry is the insurance premium — at a constant 23%
        probability, holding an Upbet for a full year costs ≈ its full price (0.23), which
        is exactly what &ldquo;23% annual probability&rdquo; means. Perpetual markets in
        TradFi call this <em>funding</em>; on Pari it&rsquo;s daily carry.
      </p>

      <h2>Carry accrues as a number, cash moves at touchpoints</h2>
      <p>
        Carry is tracked continuously against your position, but USDC only changes hands
        when your position is touched: when you trade, redeem a set, settle after a credit
        event, cure, or are liquidated. Earned carry (Downbet side) is paid out in cash at
        your next touchpoint; owed carry (Upbet side) is deducted from your proceeds at your
        next touchpoint. Owed carry is never forgotten — it&rsquo;s kept on a ledger until
        it&rsquo;s collected.
      </p>

      <h2>Your position stats</h2>
      <p>
        Exactly what the Portfolio page shows. Define: <code>c</code> = your entry price,{' '}
        <code>m</code> = current price, <code>f</code> = carry accrued per $1 since your
        entry.
      </p>
      <div className="docs-formula">{'Equity          = m − f\nP&L             = (m − c) − f\nBreakeven price = c + f'}</div>
      <p>
        Equity is what your Upbet is really worth after the carry you owe. Breakeven rises
        over time — that&rsquo;s the cost of holding. For Downbets the sign flips: carry
        adds to your P&amp;L.
      </p>

      <h2>Epochs to Expire</h2>
      <p>The Upbet early-warning number:</p>
      <div className="docs-formula">{'Epochs to Expire = floor( (m/1.03 − f) / Δf ),   Δf = m/365 per day'}</div>
      <p>
        Plain reading: &ldquo;if the price stays where it is, how many days until my Upbet
        hits the liquidation trigger?&rdquo; Worked example: buy at m = 5% with no carry
        accrued → Δf = 0.05/365 ≈ 0.000137/day → ≈354 days. Holding an Upbet for ~a year
        costs ~its full value — so a fresh Upbet has ~a year of runway. Watch this number;
        the app warns as it approaches zero.
      </p>

      <div className="docs-callout docs-callout--warning">
        <p>
          Negative P&amp;L alone NEVER triggers liquidation. Only unpaid carry vs the
          current price does — see Liquidations &amp; cure.
        </p>
      </div>
    </div>
  )
}
