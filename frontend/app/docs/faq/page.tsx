import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'FAQ — Pari Docs',
}

export default function FaqPage() {
  return (
    <div>
      <h1>FAQ</h1>

      <h3>What happens if there&rsquo;s no credit event for a year?</h3>
      <p>
        Nothing special on any date — the market is perpetual, always pricing the next 12
        months. Downbets keep earning daily carry; Upbets keep paying it. There is no
        expiry payout.
      </p>

      <h3>Can I lose more than I deposit?</h3>
      <p>
        No. Everything is fully collateralized — no leverage, no margin calls. Worst case an
        Upbet&rsquo;s value is consumed by carry (liquidation), or a Downbet goes to $0 on a
        confirmed credit event.
      </p>

      <h3>Why was my sell order rejected?</h3>
      <p>
        Selling an Upbet settles your accrued carry from the proceeds. If your limit price
        is too low to cover carry owed + fee, the order is rejected with the minimum
        workable price — raise your price a tick. Your position is unchanged.
      </p>

      <h3>Why can&rsquo;t I send Upbets/Downbets to another wallet?</h3>
      <p>
        Every transfer must run through the market so daily carry is settled correctly for
        both sides. Wallet-to-wallet transfers are disabled at the contract level.
      </p>

      <h3>My position says frozen — what now?</h3>
      <p>
        You crossed the liquidation trigger and were flagged. You can cure (pay the frozen
        carry bill, keep the position) before someone claims it — see{' '}
        <Link href="/docs/liquidations-and-cure">Liquidations &amp; cure</Link>.
      </p>

      <h3>Who decides a credit event happened?</h3>
      <p>
        In the MVP, the Pari team&rsquo;s multisig oracle, against public evidence
        (bankruptcy filing, missed payment). See{' '}
        <Link href="/docs/credit-events">Credit events</Link>.
      </p>

      <h3>What are the fees?</h3>
      <p>
        One trade fee: 0.50% × min(price, 1−price) × size, charged only when you sell an
        Upbet or buy a Downbet. Nothing on deposits, redemptions, or settlement.
      </p>

      <h3>Is this real money?</h3>
      <p>Not yet — Base Sepolia testnet only.</p>
    </div>
  )
}
