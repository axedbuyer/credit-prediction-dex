import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = {
  title: 'Market maker guide — Pari Docs',
}

export default function MarketMakersPage() {
  return (
    <div>
      <h1>Market maker guide</h1>
      <p>
        This page is for programmatic traders. At the contract level, Upbet is the YES
        token and Downbet is the NO token; API fields use <code>yes</code>/<code>no</code>.
      </p>

      <h2>Architecture</h2>
      <p>
        Off-chain order book (REST + Redis) with price-time priority matching; matched pairs
        settle on-chain through the <code>CLOBSettlement</code> contract, which verifies
        both EIP-712 signatures, settles carry for both parties, and atomically swaps tokens
        vs USDC.
      </p>

      <h2>REST API</h2>
      <p>
        Base URL:{' '}
        <code>https://order-book-server-production-9bb6.up.railway.app</code>
      </p>
      <ul>
        <li>
          <code>POST /order</code> — body is the order + signature (wire format below).
          Pre-checks against chain state and can reject with 400 <code>PositionFrozen</code>{' '}
          (maker is flagged) or 400 <code>FundingShortfall</code> (a YES sell whose proceeds
          can&rsquo;t cover carry owed + fee; response includes{' '}
          <code>minSellProceeds</code>). These pre-checks fail open on RPC issues — the
          on-chain settlement check is the backstop. Orders below 1 Upbet/Downbet
          (1,000,000 units) are rejected with 400 <code>BelowMinOrderSize</code>.
        </li>
        <li>
          <code>DELETE /order/:id</code> — remove from the book (signed CancelOrder message).
          For a binding cancel, call <code>CLOBSettlement.cancelOrders([order])</code> or{' '}
          <code>setMinNonce(n)</code> (retires every order of yours with nonce &lt; n) on-chain,
          then <code>POST /orders/sync</code> with <code>{'{ market, maker }'}</code> — it drops
          your orders whose <code>remaining()</code> is now 0.
        </li>
        <li>
          <code>GET /orderbook</code> — bids (high→low) and asks (low→high). Orders fill in
          pieces: each carries <code>filled</code> (outcome units already filled), so what
          is left is size − filled.
        </li>
      </ul>

      <h2>Order wire format</h2>
      <p>All bigint fields as decimal strings:</p>
      <div className="docs-formula">{`{
  "maker": "0x…", "tokenIn": "0x…", "tokenOut": "0x…",
  "amountIn": "…", "minAmountOut": "…",
  "expiry": "…", "nonce": "…", "signature": "0x…"
}`}</div>
      <p>
        <code>tokenIn</code> = what you give (USDC when buying, YES/NO token when selling);{' '}
        <code>tokenOut</code> = what you receive; <code>minAmountOut</code> encodes your
        limit price. Buying: <code>amountIn</code> = USDC in, <code>minAmountOut</code> =
        tokens out. Selling: <code>amountIn</code> = tokens in, <code>minAmountOut</code> =
        USDC out.
      </p>

      <h2>EIP-712 signing</h2>
      <p>
        Domain: <code>name: &quot;CLOBSettlement&quot;</code>,{' '}
        <code>version: &quot;1&quot;</code>, <code>chainId: 84532</code>,{' '}
        <code>verifyingContract:</code> the CLOBSettlement address (see{' '}
        <Link href="/docs/contract-addresses">Contracts &amp; addresses</Link>). Type:{' '}
        <code>
          Order(address maker,address tokenIn,address tokenOut,uint256 amountIn,uint256
          minAmountOut,uint256 expiry,uint256 nonce)
        </code>{' '}
        — 7 fields, signature detached (passed alongside, never embedded in the struct).
      </p>

      <h2>Critical integration gotchas</h2>
      <ol>
        <li>
          <strong>All amounts are 6-decimal USDC scale</strong> — even though the YES/NO
          token contracts report <code>decimals() == 18</code>. Never scale by 1e18; never
          add the tokens to a wallet UI.
        </li>
        <li>
          <strong>NO buys must sign a GROSS amountIn</strong> (position cost + fee). The
          contract pulls exactly what you signed, so the fee must be inside it. Compute
          gross from your intended net price with the piecewise inversion in{' '}
          <code>frontend/lib/feeMath.ts</code> (<code>minGrossForNet</code>) /{' '}
          <code>backend/order-book-server/src/fee.ts</code>. A NO bid signed at net rests
          below where you meant it. The book sorts/crosses NO bids at their NET price.
        </li>
        <li>
          <strong>Fee reminder:</strong> 0.50% × min(p, 1−p) × size, charged only on YES
          sells + NO buys; YES buys + NO sells fee-free.
        </li>
        <li>
          <strong>Order expiry is checked against CHAIN time</strong>, not wall clock.
        </li>
        <li>
          <strong>Selling YES settles your carry from proceeds</strong> — a fill that
          can&rsquo;t cover carry owed + fee reverts <code>FundingShortfall</code> (position
          unchanged). Size/price accordingly; use the server&rsquo;s{' '}
          <code>minSellProceeds</code> hint.
        </li>
        <li>
          <strong>Partial fills:</strong> an order can fill across many trades, each at the
          resting (earlier) order&rsquo;s price and pro rata to your limit. A YES sale repays
          only its pro-rata share of your carry owed (owed × sold / held). Fills are
          submitted only by the platform&rsquo;s matcher.
        </li>
        <li>
          Nonces: unique per order; use millisecond timestamps (the app does) so{' '}
          <code>setMinNonce(Date.now())</code> cancels everything you signed before now.
        </li>
        <li>
          If CLOBSettlement is ever redeployed, the EIP-712 domain changes — all resting
          orders die and must be re-signed (watch announcements).
        </li>
      </ol>

      <div className="docs-callout">
        <p>
          Testnet note: this is Base Sepolia; USDC is the Base Sepolia test USDC (address on
          the <Link href="/docs/contract-addresses">Contracts &amp; addresses</Link> page).
        </p>
      </div>
    </div>
  )
}
