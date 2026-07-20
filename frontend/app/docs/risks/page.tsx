import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Risk disclosures — Pari Docs',
}

export default function RisksPage() {
  return (
    <div>
      <h1>Risk disclosures</h1>

      <ul>
        <li>
          <strong>Carry decay:</strong> at a constant price, an Upbet loses ≈ its entire
          value to daily carry over ~a year. An Upbet is a decaying asset unless the
          probability rises. Watch{' '}
          <Link href="/docs/mark-to-market-and-carry">Epochs to Expire</Link>.
        </li>
        <li>
          <strong>Liquidation risk:</strong> if accrued carry approaches your Upbet&rsquo;s
          value (within 3%), the position is frozen and can be claimed. You keep none of the
          residual unless you cure first.
        </li>
        <li>
          <strong>Downbet wipeout:</strong> a single confirmed credit event takes every
          Downbet to $0.00, regardless of entry price or carry earned to date.
        </li>
        <li>
          <strong>Oracle trust (MVP):</strong> credit events are determined by the Pari
          team&rsquo;s multisig, not an independent process. You are trusting the
          team&rsquo;s honesty and diligence.
        </li>
        <li>
          <strong>Smart-contract risk:</strong> contracts are tested but{' '}
          <strong>not yet audited</strong> (audit planned before mainnet).
        </li>
        <li>
          <strong>Liquidity risk:</strong> early-stage order book; large orders may move the
          price or fail to fill; the sell-order carry check (see{' '}
          <Link href="/docs/faq">FAQ</Link>) binds sooner in a thin book.
        </li>
        <li>
          <strong>Testnet status:</strong> Base Sepolia only; no real funds; markets may be
          reset.
        </li>
      </ul>

      <div className="docs-callout docs-callout--danger">
        <p>
          This is not investment advice; nothing here is an offer of securities or
          derivatives in any jurisdiction.
        </p>
      </div>
    </div>
  )
}
