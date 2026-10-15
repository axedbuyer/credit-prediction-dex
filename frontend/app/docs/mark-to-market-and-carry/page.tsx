import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Mark-to-market & carry — Pari Docs',
}

// Reference rows: price → carry. Carry = −(1 − m)·ln(1 − m) a year per $1 of payout
// (CreditMarket.carryRateFor); runway = 365 × m / (1.03 × carry) days for a fresh
// Upbet at a steady price. Keep in sync with docs/carry-formula.md.
const CARRY_TABLE = [
  { chance: '2%', costs: '2¢', yearly: '1.98¢', daily: '0.0054¢', runway: '~358 days' },
  { chance: '5%', costs: '5¢', yearly: '4.87¢', daily: '0.0134¢', runway: '~363 days' },
  { chance: '10%', costs: '10¢', yearly: '9.48¢', daily: '0.0260¢', runway: '~373 days' },
  { chance: '23%', costs: '23¢', yearly: '20.13¢', daily: '0.0551¢', runway: '~404 days' },
  { chance: '40%', costs: '40¢', yearly: '30.65¢', daily: '0.0840¢', runway: '~462 days' },
]

export default function MarkToMarketAndCarryPage() {
  return (
    <div>
      <h1>Mark-to-market &amp; carry</h1>

      <h2>Why carry exists</h2>
      <p>
        A Pari market never expires. In a market with a deadline (&ldquo;default by
        December 31?&rdquo;), an Upbet slowly loses value as the deadline approaches without
        an event. Pari&rsquo;s markets roll forever, so that slow loss is paid in the open
        instead: Upbet holders pay a small amount every day, called <strong>carry</strong>,
        to the Downbet holders taking the other side of the risk.
      </p>
      <p>
        Upbets <strong>pay</strong> carry; Downbets <strong>earn</strong> it, cent for cent.
        Perpetual markets in TradFi call this <em>funding</em>.
      </p>

      <h2>How much: one rule</h2>
      <div className="docs-callout docs-callout--info">
        <p>
          <strong>You pay for the chance of a credit event, but only on what you stand to
          win.</strong>
        </p>
      </div>
      <p>
        At a 23% chance, an Upbet costs 23¢ and pays $1 on a credit event, so it stands to
        win 77¢. Carry works out to about <strong>20.1¢ per $1 a year</strong>, or roughly
        0.055¢ per $1 per day. That&rsquo;s below the 23% chance because it&rsquo;s charged
        only on the 77¢ at stake, not on the full $1.
      </p>
      <p>
        Carry moves with the market price: every time the price updates, so does the carry
        rate. The market page shows the live figure.
      </p>

      <h2>Why that&rsquo;s fair</h2>
      <p>
        Hold 1,000 Upbets (each pays $1 on a credit event) for one day while the price sits
        at 23%:
      </p>
      <ul>
        <li>
          The chance of a credit event that particular day is about 0.072% (a 23% chance
          over the next 12 months, spread across the days).
        </li>
        <li>
          If it happens, each Upbet jumps from 23¢ to $1: you gain 77¢ × 1,000 = $770. On
          average that&rsquo;s worth 0.072% × $770 ≈ <strong>$0.55</strong> a day.
        </li>
        <li>
          The carry you pay that day: 0.055¢ × 1,000 ≈ <strong>$0.55</strong>.
        </li>
      </ul>
      <p>
        What you expect to win equals what you pay. That balance is what makes the price
        mean exactly what it says: <strong>23¢ = a 23% chance of a credit event in the next
        12 months</strong>. If you think the real chance is higher, Upbets are cheap; if
        lower, Downbets are.
      </p>
      <p>
        From the Downbet side: a Downbet costs 77¢ and earns the same 20.1¢ a year, about
        26% a year on what you paid. You earn that for carrying the risk of losing your 77¢
        if a credit event happens.
      </p>

      <h2>Quick reference</h2>
      <p>Carry per $1 of payout, and runway for a fresh Upbet at a steady price:</p>
      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Chance</th>
              <th data-numeric>Upbet costs</th>
              <th data-numeric>Carry / year</th>
              <th data-numeric>Carry / day</th>
              <th data-numeric>Runway</th>
            </tr>
          </thead>
          <tbody>
            {CARRY_TABLE.map((r) => (
              <tr key={r.chance}>
                <td>{r.chance}</td>
                <td data-numeric>{r.costs}</td>
                <td data-numeric>{r.yearly}</td>
                <td data-numeric>{r.daily}</td>
                <td data-numeric>{r.runway}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>
        Runway is how long a freshly bought Upbet can be held before the carry it owes
        reaches the{' '}
        <Link href="/docs/liquidations-and-cure">liquidation trigger</Link>, if the price
        never moves. It&rsquo;s a little over a year at every price.
      </p>

      <details className="docs-details">
        <summary>For the curious: the exact formula</summary>
        <div className="docs-formula">{'carry per $1, a year = −(1 − m) · ln(1 − m)        (m = price, e.g. 0.23)\ncarry per $1, a day  = that ÷ 365'}</div>
        <p>It has two parts:</p>
        <ul>
          <li>
            <code>−ln(1 − m)</code> turns a 12-month chance into a steady event rate: the
            rate that, running all year, leaves a <code>1 − m</code> chance of no event.
            At 23% it&rsquo;s about 26.1% a year.
          </li>
          <li>
            <code>× (1 − m)</code> charges that rate only on what an Upbet stands to win.
          </li>
        </ul>
        <p>
          For low prices carry is close to <code>m − m²/2</code>, just under the price. It
          always sits between <code>m × (1 − m)</code> and <code>m</code>, and peaks at
          about 36.8¢ a year when the price is about 63%. Above that there&rsquo;s little
          left to protect, so it falls. The formula assumes the event rate is steady over
          time and ignores interest on the money held as collateral.
        </p>
      </details>

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
      <div className="docs-formula">{'Epochs to Expire = floor( (m/1.03 − f) / Δf ),   Δf = carry / 365 per day'}</div>
      <p>
        Plain reading: &ldquo;if the price stays where it is, how many days until my Upbet
        hits the liquidation trigger?&rdquo; Worked example: buy at 5% with no carry
        accrued → carry ≈ 4.87¢ a year → Δf ≈ 0.0134¢ per day → about 363 days. A fresh
        Upbet has a little over a year of runway (see the table above). Watch this number;
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
