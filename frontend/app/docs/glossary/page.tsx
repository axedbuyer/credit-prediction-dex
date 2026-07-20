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
    term: 'Annual probability',
    meaning: 'The price; market-implied chance of a credit event within 12 months.',
    tradfi: 'Hazard rate',
  },
  {
    term: 'Daily carry',
    meaning: 'The daily cashflow from Upbet holders to Downbet holders, m/365 per $1.',
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
    meaning: 'Bankruptcy or Failure to Pay by the reference company.',
    tradfi: 'Same term in TradFi',
  },
  {
    term: 'Cure',
    meaning: "Paying a frozen position's carry bill to unlock it and keep it.",
    tradfi: '—',
  },
  {
    term: 'Claim / liquidation',
    meaning: "A third party paying a flagged position's carry bill and taking over the position.",
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
    meaning: 'The process that confirms or rejects a credit event (team multisig in MVP).',
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
