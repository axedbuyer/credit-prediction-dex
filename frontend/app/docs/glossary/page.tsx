import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Glossary — Pari Docs',
}

const TERMS: { term: string; meaning: string; tradfi: string }[] = [
  {
    term: 'Upbet',
    meaning:
      'A position that pays $1.00 if a credit event is confirmed; pays daily carry to hold.',
    tradfi: 'Long credit risk / owning default protection (YES share, in prediction-market terms)',
  },
  {
    term: 'Downbet',
    meaning:
      'A position that earns daily carry and goes to $0.00 if a credit event is confirmed.',
    tradfi: 'Short credit risk / providing default protection (NO share)',
  },
  {
    term: 'Probability (12-month chance)',
    meaning: 'The price; the market-implied chance of a credit event within the next 12 months.',
    tradfi: '1-year probability of default (PD)',
  },
  {
    term: 'Daily carry',
    meaning:
      'The daily cashflow from Upbet holders to Downbet holders: the chance of a credit event, charged only on what an Upbet stands to win (≈20.1¢ per $1 a year at a 23% price).',
    tradfi: 'Funding (perpetuals) / premium (insurance)',
  },
  {
    term: 'Complete set',
    meaning: '1 Upbet + 1 Downbet, always mintable and redeemable for $1.00.',
    tradfi: '—',
  },
  {
    term: 'Equity',
    meaning: 'Current price minus carry owed; what an Upbet is really worth.',
    tradfi: 'Mark-to-market value net of accruals',
  },
  {
    term: 'Credit event',
    meaning: 'An event the market covers (each market lists its own, e.g. Bankruptcy or Failure to Pay), ruled to have happened by the Determinations Committee.',
    tradfi: 'Same term in TradFi',
  },
  {
    term: 'Pay carry',
    meaning: 'Paying the carry your Upbet owes right now, at any time, to reset its liquidation clock — and, if it is locked, to unlock it and keep it.',
    tradfi: 'Paying accrued premium',
  },
  {
    term: 'Mark',
    meaning: 'The on-chain price that carry, equity and liquidation use. It follows trading: recent trades, or the order book when trades are thin.',
    tradfi: 'Mark price',
  },
  {
    term: 'Position health',
    meaning: 'How far an Upbet is from liquidation: Healthy, Watch, Warning or Critical. Shown on-site only.',
    tradfi: 'Margin health',
  },
  {
    term: 'Motion / DC question',
    meaning: 'Opened by the team when the Determinations Committee is asked whether a credit event happened on a listed entity. Nothing is blocked; carry from then on is held until the ruling.',
    tradfi: 'DC credit event question',
  },
  {
    term: 'Event determination date',
    meaning: "The moment a motion opens on Pari. Carry after it is held: refunded to Upbet holders who paid it on a Yes ruling, paid to Downbet holders on a No.",
    tradfi: 'Event determination date',
  },
  {
    term: 'Pending carry',
    meaning: 'Downbet carry earned while a DC question is open, held until the ruling. It stays with the address that earned it, even if the Downbet is sold.',
    tradfi: '—',
  },
  {
    term: 'Claim / liquidation',
    meaning: "A third party paying a locked position's live carry bill and taking over the position.",
    tradfi: '—',
  },
  {
    term: 'Insurance fund',
    meaning:
      'A USDC reserve (funded by half of all trade fees) that guarantees Downbet holders are made whole in edge-case liquidations.',
    tradfi: 'Default fund / backstop',
  },
  {
    term: 'Oracle',
    meaning: 'The team multisig that relays ISDA Determinations Committee rulings on-chain to confirm or reject a credit event.',
    tradfi: '—',
  },
]

export default function GlossaryPage() {
  return (
    <div>
      <h1>Glossary</h1>

      <div className="docs-table-wrap">
        <table>
          <thead>
            <tr>
              <th>Term</th>
              <th>Meaning</th>
              <th>Similar TradFi concept</th>
            </tr>
          </thead>
          <tbody>
            {TERMS.map((t) => (
              <tr key={t.term}>
                <td>{t.term}</td>
                <td>{t.meaning}</td>
                <td>{t.tradfi}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
