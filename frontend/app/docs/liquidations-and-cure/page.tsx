import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Liquidations & cure — Pari Docs',
}

export default function LiquidationsAndCurePage() {
  return (
    <div>
      <h1>Liquidations &amp; cure</h1>

      <h2>Why liquidation exists</h2>
      <p>
        An Upbet holder continuously owes carry to Downbet holders. If someone just held an
        Upbet forever without paying, the promise to Downbets would go unpaid. So when
        accrued carry eats almost all of an Upbet&rsquo;s value, the position is seized and
        passed to someone who settles the carry bill.
      </p>

      <h2>The trigger</h2>
      <div className="docs-formula">{'f_next = f + m/365 × Δt        (carry owed after one more day)\nLiquidatable when:  m ≤ 1.03 × f_next'}</div>
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
      </ul>

      <h2>The lock</h2>
      <p>
        When the trigger fires, a keeper flags the position. From that moment it is fully
        locked: no trading, no minting, no redeeming. Daily carry keeps accruing the whole
        time it&rsquo;s locked &mdash; there is no freeze &mdash; so the bill you&rsquo;d
        pay to cure, or the price a claimer would pay, keeps growing the longer it waits.
        Three exits only: someone claims it, you cure it, or a credit event is confirmed
        (settlement auto-collects the live bill from your $1.00 payout).
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

      <h2>Cure — the self-rescue</h2>
      <p>
        Before anyone claims, the holder can <strong>cure</strong>: pay the live carry bill
        in USDC and keep the Upbet. Carry has been accruing the entire time the position
        was locked, so the sooner you cure, the less you pay &mdash; and you keep the
        sliver a claimer would otherwise have taken. The Portfolio page shows a live
        cure-cost estimate and an approve → cure flow whenever your position is locked.
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
          Liquidation and flagging are paused during a pending credit-event motion — a
          position is never seized moments before its payout could be decided.
        </p>
      </div>
    </div>
  )
}
