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
          <strong>Monitoring.</strong> At least twice every working day, and daily at
          weekends, the team checks the{' '}
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
          multisig opens a credit-event motion on that market. The moment it opens is
          Pari&rsquo;s <strong>event determination date</strong>. A motion blocks nothing:
          trading, liquidations and Pay carry all continue, and the market page shows a
          banner. What changes is carry: carry from that moment on is <strong>held</strong>{' '}
          until the DC rules.
          <ul>
            <li>
              <strong>Downbet holders</strong> see it as &ldquo;pending carry&rdquo;. It is
              paid to them if the DC rules No, and cancelled if it rules Yes. If you sell
              your Downbet during the motion, the carry held so far stays with you, not the
              buyer.
            </li>
            <li>
              <strong>Upbet holders</strong> keep owing carry, and an Upbet that falls behind
              can still be liquidated. Any carry paid in cash since the motion opened
              (through Pay carry, a sale, redeeming, or by a liquidator) is refunded to
              whoever paid it if the DC rules Yes.
            </li>
          </ul>
        </li>
        <li>
          <strong>DC rules &ldquo;Yes&rdquo;</strong> on an event the market covers: the
          multisig confirms the credit event on-chain and the market ends. Every Upbet
          redeems for <strong>$1.00</strong> (its full backing), minus only carry owed from
          before the motion opened, plus any carry you paid since then; every Downbet is
          worth <strong>$0.00</strong>. Redemption is a one-click settle from the Portfolio
          page. If your position was locked, settlement unlocks it and takes the carry
          owed from the payout. After confirmation no position can be flagged or claimed.
        </li>
        <li>
          <strong>DC rules &ldquo;No&rdquo;, declines the question, or rules Yes on an event
          this market doesn&rsquo;t cover:</strong> the motion is closed. Held carry is paid
          to Downbet holders, and Upbet carry owed since the motion opened becomes ordinary
          carry owed. Nothing else changes.
        </li>
      </ol>
      <p>
        You cannot raise a motion on-chain yourself. If you think the team has missed a DC
        request on a listed entity, contact the team with a link to it.
      </p>

      <h2>Timing gaps you should know about</h2>
      <ul>
        <li>
          <strong>Before the motion.</strong> The team checks the DC site by hand, at least
          twice every working day and daily at weekends. A question can sit there for some
          hours before the motion opens; carry in that gap is not held.
        </li>
        <li>
          <strong>Before confirmation.</strong> Between the DC announcing &ldquo;Yes&rdquo;
          and the confirmation landing on-chain, liquidations are still possible. The team
          stops its own liquidator at once and confirms within minutes, but anyone can
          claim a flagged position in that window. If you hold an Upbet, keep your carry
          paid: a position whose carry is paid can&rsquo;t be flagged, so it can&rsquo;t be
          liquidated in that gap.
        </li>
      </ul>

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
