import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Credit events — Pari Docs',
}

export default function CreditEventsPage() {
  return (
    <div>
      <h1>Credit events</h1>

      <h2>What counts (MVP)</h2>
      <p>Two events settle the market:</p>
      <ul>
        <li>
          <strong>Bankruptcy</strong> — the reference company files for (or is put into)
          bankruptcy or an equivalent insolvency proceeding.
        </li>
        <li>
          <strong>Failure to Pay</strong> — the company misses a required payment on its
          debt (beyond any grace period).
        </li>
      </ul>
      <p>
        Anything else — downgrades, stock crashes, restructuring rumors — is NOT a credit
        event and does not settle the market.
      </p>

      <h2>Lifecycle</h2>
      <ol>
        <li>
          <strong>Event occurs</strong> in the real world.
        </li>
        <li>
          <strong>Motion raised.</strong> In the MVP, determination is made by the Pari
          team&rsquo;s multisig oracle — an industry-standard external determination
          process is on the roadmap. A pending motion is announced.
        </li>
        <li>
          <strong>Determination window.</strong> The market can be paused and — always —
          flagging and liquidation claims are frozen while the motion is pending. Nobody&rsquo;s
          Upbet can be seized while its payout is being decided.
        </li>
        <li>
          <strong>Confirmed:</strong> every Upbet redeems for <strong>$1.00</strong> (its
          full backing); every Downbet is worth <strong>$0.00</strong>. Redemption is a
          one-click settle from the Portfolio page. If your position was frozen pre-event,
          settlement auto-cures it: the frozen carry bill is deducted from your
          $1.00-per-Upbet payout.
        </li>
        <li>
          <strong>Rejected:</strong> the motion is dismissed, the market unpauses, trading
          and carry resume.
        </li>
      </ol>

      <h2>Zero recovery, by design</h2>
      <p>
        Real-world credit instruments recover some cents on the dollar in bankruptcy;
        Pari&rsquo;s Upbet pays the full $1.00 regardless. This keeps the product binary and
        simple — the price is a pure probability, with no recovery-rate guesswork.
      </p>

      <h2>After settlement</h2>
      <p>
        The market for that question is closed (perpetual = perpetual until the event
        happens, then it resolves like any prediction market).
      </p>

      <h2>How events are determined</h2>
      <p>
        In the MVP you cannot raise a motion on-chain; contact the team with evidence
        (bankruptcy filing, missed-payment notice).
      </p>
    </div>
  )
}
