import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Liquidations & paying carry — Pari Docs',
}

export default function LiquidationsAndCurePage() {
  return (
    <div>
      <h1>Liquidations &amp; paying carry</h1>

      <h2>Why liquidation exists</h2>
      <p>
        An Upbet holder continuously owes carry to Downbet holders. If someone just held an
        Upbet forever without paying, the promise to Downbets would go unpaid. So when
        accrued carry eats almost all of an Upbet&rsquo;s value, the position is seized and
        passed to someone who settles the carry bill.
      </p>

      <h2>The trigger</h2>
      <div className="docs-formula">{'f_next = f + carry/365 × Δt    (carry owed after one more day; carry per $1 a year, see Mark-to-market & carry)\nLiquidatable when:  m ≤ 1.03 × f_next'}</div>
      <p>
        In words: when your Upbet&rsquo;s price no longer exceeds the carry you&rsquo;d owe
        after one more day by at least 3%, the position becomes claimable. Two crucial
        properties:
      </p>
      <ul>
        <li>
          The trigger only compares the <strong>current price vs carry owed</strong>. Your
          entry price and your P&amp;L are irrelevant — being deep underwater on price alone
          never liquidates you.
        </li>
        <li>
          The 3% buffer means positions are seized while there&rsquo;s still a sliver of
          value left — that sliver is the liquidator&rsquo;s reward.
        </li>
        <li>
          The price is the market&rsquo;s: Pari&rsquo;s mark follows trading (recent trades,
          or the order book when trades are thin), and moves in both directions. A sharp
          fall in the chance brings liquidation closer <strong>at once</strong> &mdash; there
          is no grace period. A holder who keeps carry paid owes almost nothing, so a falling
          price alone can&rsquo;t get them liquidated.
        </li>
      </ul>

      <h2>Position health</h2>
      <p>
        Every Upbet on your Portfolio shows a health badge, worked out from the same numbers
        as the trigger:
      </p>
      <ul>
        <li><strong>Healthy</strong> &mdash; more than 30 days of carry left.</li>
        <li><strong>Watch</strong> &mdash; 30 days or fewer: a prompt to pay carry.</li>
        <li><strong>Warning</strong> &mdash; 7 days or fewer, or the price is within 1.5× of the trigger: a red banner on the market page and Portfolio.</li>
        <li><strong>Critical</strong> &mdash; 2 days or fewer, or within 1.15× of the trigger: a pop-up when you connect.</li>
      </ul>
      <p>
        These alerts are <strong>on-site only</strong>: you see them when you visit Pari.
        Nothing is emailed or pushed to you, so check in regularly while you hold an Upbet.
      </p>

      <h2>The lock</h2>
      <p>
        When the trigger fires, a keeper flags the position. From that moment it is fully
        locked: no trading, no minting, no redeeming. Daily carry keeps accruing the whole
        time it&rsquo;s locked &mdash; there is no freeze &mdash; so the carry you&rsquo;d
        pay to unlock it, or the price a claimer would pay, keeps growing the longer it
        waits. Three exits only: someone claims it, you pay carry, or a credit event is
        confirmed (settlement takes the carry owed from your $1.00 payout).
      </p>

      <h2>The claim (permissionless, formulaic price — no auction)</h2>
      <p>Anyone may claim a locked position by paying, priced at the moment they claim:</p>
      <div className="docs-formula">{'P = min(f, m)     (f = carry owed right now, m = price right now)'}</div>
      <p>
        <strong>Normal case (f ≤ m):</strong> the claimer pays exactly the carry owed at
        that instant. That payment makes the Downbet side whole. The Upbet{' '}
        <strong>transfers</strong> to the claimer (it is never destroyed) with a fresh
        carry clock; their profit is the sliver (m − f) when they resell &mdash; it
        shrinks the longer the position sits unclaimed, which is exactly the incentive to
        claim promptly rather than let it wait.
      </p>
      <p>
        <strong>Tail case (f &gt; m,</strong> e.g. after a long stall): the claimer pays the
        full price m and the <strong>insurance fund</strong> tops up the difference &mdash;
        Downbet holders are always made whole, in every case, with no haircut.
      </p>
      <p>
        The claimed holder&rsquo;s Downbets (if any) are untouched — earned carry on the
        Downbet side survives a claim and pays at their next touchpoint.
      </p>

      <h2>Pay carry &mdash; any time</h2>
      <p>
        Any Upbet holder can <strong>pay carry</strong> at any time from the Portfolio page:
        you pay the carry you owe right now in USDC (net of any carry your Downbets in the
        same market have earned), keep the Upbet, and your liquidation clock resets. It also
        works while a market is paused.
      </p>
      <p>
        If your position is already locked, paying carry is how you unlock it before
        anyone claims. Carry keeps accruing while it&rsquo;s locked, so the sooner you pay,
        the less you pay &mdash; and you keep the sliver a claimer would otherwise take.
      </p>

      <h2>For liquidators</h2>
      <p>
        The <Link href="/liquidate">Liquidate</Link> page lists locked positions and the
        current claim price P &mdash; it rises with every passing day, so refresh before you
        submit. First valid transaction wins — no auction, no discount ramp, no special role
        required. Your edge is the sliver between price and carry owed. Note honestly:
        claims are open first-come-first-served on a public chain, so competition is
        possible.
      </p>

      <div className="docs-callout docs-callout--warning">
        <p>
          Liquidations <strong>continue</strong> while a DC question is open on a market. If
          you hold an Upbet there, keep your carry paid: carry you pay from the day the
          question opened is refunded to you if the DC rules a credit event happened (and a
          liquidator who covered it gets theirs back). Once a credit event is confirmed, no
          position can be flagged or claimed again. See{' '}
          <Link href="/docs/credit-events">Credit events</Link>.
        </p>
      </div>
    </div>
  )
}
