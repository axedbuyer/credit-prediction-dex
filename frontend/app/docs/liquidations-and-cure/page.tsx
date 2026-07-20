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

      <h2>The freeze</h2>
      <p>
        When the trigger fires, a keeper flags the position. From that moment it is fully
        locked: no trading, no minting, no redeeming, and <strong>carry stops
        accruing</strong> — the bill is frozen at the flagged amount. Three exits only:
        someone claims it, you cure it, or a credit event is confirmed (settlement
        auto-collects the frozen bill from your $1.00 payout).
      </p>

      <h2>The claim (permissionless, fixed price — no auction)</h2>
      <p>Anyone may claim a flagged position by paying:</p>
      <div className="docs-formula">{'P = min(f, m)     (f = frozen carry owed, m = price at flag time)'}</div>
      <p>
        <strong>Normal case (f ≤ m):</strong> the claimer pays exactly the carry owed. That
        payment makes the Downbet side whole. The Upbet <strong>transfers</strong> to the
        claimer (it is never destroyed) with a fresh carry clock; their profit is the ~3%
        sliver (m − f) when they resell.
      </p>
      <p>
        <strong>Tail case (f &gt; m,</strong> e.g. after downtime): the claimer pays the full
        price m and the <strong>insurance fund</strong> tops up the difference — Downbet
        holders are always made whole, in every case, with no haircut.
      </p>
      <p>
        The claimed holder&rsquo;s Downbets (if any) are untouched — earned carry on the
        Downbet side survives a claim and pays at their next touchpoint.
      </p>

      <h2>Cure — the self-rescue</h2>
      <p>
        Before anyone claims, the holder can <strong>cure</strong>: pay the frozen carry
        bill in USDC, keep the Upbet (and the ~3% sliver a claimer would have taken), and
        carry resumes from now. The Portfolio page shows the cure cost and an approve → cure
        flow when your position is frozen.
      </p>

      <h2>For liquidators</h2>
      <p>
        The <Link href="/liquidate">Liquidate</Link> page lists flagged positions and the
        fixed claim price P. First valid transaction wins — no auction, no discount ramp, no
        special role required. Your edge is the 3% buffer. Note honestly: claims are open
        first-come-first-served on a public chain, so competition is possible.
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
