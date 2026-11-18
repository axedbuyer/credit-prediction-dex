import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Credit events — Pari Docs',
}

const DC_URL = 'https://www.cdsdeterminationscommittees.org/'

export default function CreditEventsPage() {
  return (
    <div>
      <h1>Credit events</h1>

      <p>
        Pari markets settle on the same credit events that settle credit default swaps in
        TradFi, as ruled on by the{' '}
        <a href={DC_URL} target="_blank" rel="noreferrer">
          Credit Derivatives Determinations Committees
        </a>{' '}
        (ISDA DC) — the industry panel of dealers and investors whose requests and rulings
        are public and free to check.
      </p>

      <h2>What counts</h2>
      <p>Each market lists the credit events it covers:</p>
      <ul>
        <li>
          <strong>Companies</strong> (MicroStrategy, CoreWeave): <strong>Bankruptcy</strong>{' '}
          — the company files for, or is put into, bankruptcy or an equivalent insolvency
          proceeding; and <strong>Failure to Pay</strong> — it misses a required payment on
          its debt beyond any grace period.
        </li>
        <li>
          <strong>Countries</strong> (Republic of Turkey): <strong>Failure to Pay</strong>;{' '}
          <strong>Repudiation/Moratorium</strong> — the government disowns its debt or
          declares a halt on paying it; and <strong>Restructuring</strong> — the terms of its
          debt are changed to creditors&rsquo; detriment (for example, reduced or deferred
          payments).
        </li>
      </ul>
      <p>
        These follow the ISDA credit derivatives definitions. Anything else — downgrades,
        stock or bond price crashes, rumors — is NOT a credit event and does not settle the
        market. Only an ISDA DC &ldquo;Yes&rdquo; on an event the market covers settles it.
      </p>

      <h2>How a credit event is triggered</h2>
      <p>
        Pari&rsquo;s oracle is the team&rsquo;s multisig (2-of-3 before mainnet; a single
        team key on the current testnet). It bases every decision on the ISDA DC&rsquo;s
        public record, in this order — CoreWeave is used as an illustrative example:
      </p>
      <ol>
        <li>
          <strong>Continuous monitoring.</strong> The team watches the{' '}
          <em>All DC Requests</em> list on{' '}
          <a href={DC_URL} target="_blank" rel="noreferrer">
            cdsdeterminationscommittees.org
          </a>{' '}
          for every entity listed on Pari.
        </li>
        <li>
          <strong>A DC question is raised.</strong> A new request appears for the entity,
          phrased like: <em>&ldquo;Question: Has a Bankruptcy Credit Event occurred with
          respect to CoreWeave, Inc.?&rdquo;</em>
        </li>
        <li>
          <strong>Motion opened.</strong> As soon as the team picks up the question, the
          multisig opens a credit-event motion on that market. From that moment no position
          can be flagged and no liquidation claim can go through, so nobody&rsquo;s Upbet is
          seized while its payout is being decided. The market can also be paused, which
          halts minting and redeeming.
        </li>
        <li>
          <strong>DC rules &ldquo;Yes&rdquo;:</strong> the multisig confirms the credit
          event on-chain. Every Upbet redeems for <strong>$1.00</strong> (its full backing);
          every Downbet is worth <strong>$0.00</strong>. Redemption is a one-click settle
          from the Portfolio page. If your position was locked before the event, settlement
          auto-cures it: the carry bill accrued up to that moment is deducted from your
          $1.00-per-Upbet payout.
        </li>
        <li>
          <strong>DC rules &ldquo;No&rdquo; or declines the question:</strong> the motion
          is closed and the market unpauses. Nothing settles; flagging and liquidations
          resume. Carry keeps accruing throughout the motion.
        </li>
      </ol>
      <p>
        You cannot raise a motion on-chain yourself. If you think the team has missed a DC
        request on a listed entity, contact the team with a link to it.
      </p>

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

      <h2>On the roadmap</h2>
      <p>
        A Pari Determinations Committee of prominent credit investors and market makers,
        modelled on the ISDA DC, for names the ISDA DC does not cover.
      </p>
    </div>
  )
}
