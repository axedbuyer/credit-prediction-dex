import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Contracts & addresses — Pari Docs',
}

type Row = { name: string; address: `0x${string}`; note: string }

// Batch-2 contracts (2026-10-15) — contracts/deployments/base-sepolia/{core.json,markets/*.json}.
const SHARED: Row[] = [
  {
    name: 'MarketRegistry',
    address: '0xF650221216c76Bb775cd42211aFcb7a3c99f99A0',
    note: 'list of markets and their contracts',
  },
  {
    name: 'InsuranceFund',
    address: '0x1a0dB241CE7D0fd3b0C22cd45285a41D185B403b',
    note: 'shared by all markets; backstops liquidation shortfalls; receives 50% of trade fees',
  },
  {
    name: 'USDC (Base Sepolia)',
    address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    note: '',
  },
]

const MARKETS: { title: string; rows: Row[] }[] = [
  {
    title: 'MicroStrategy',
    rows: [
      {
        name: 'CreditMarket',
        address: '0x7AF29bd2fE6CF3bE904A538f2e0217285A7da94c',
        note: 'collateral, carry ledger, mint/redeem/settle',
      },
      {
        name: 'CLOBSettlement',
        address: '0x2311472C07F8b79a456F1F939895EaF6504E8B47',
        note: 'on-chain trade settlement (EIP-712 verifying contract)',
      },
      {
        name: 'Upbet (YES) token',
        address: '0xdFDe0540b22EA7a5c047Fc4bCBf6072BE8143F0B',
        note: '',
      },
      {
        name: 'Downbet (NO) token',
        address: '0x0Eb7e95BbE7A5f39182C561dD4c2739bD6Cd24a2',
        note: '',
      },
      {
        name: 'LiquidationEngine',
        address: '0x49360c6b8C36e5e1F71Ea6Ae60Bd968b71Ad0cbE',
        note: 'claims of flagged positions',
      },
      {
        name: 'OracleRouter',
        address: '0x1FD6ca58479E0EAb455E930f6d4A7ff3C2d97111',
        note: 'credit-event attestations',
      },
    ],
  },
  {
    title: 'CoreWeave',
    rows: [
      {
        name: 'CreditMarket',
        address: '0xcD60CDe83f631A82f369BF7D6C03b91D2b25f5A0',
        note: '',
      },
      {
        name: 'CLOBSettlement',
        address: '0xF8959aB75C09F1b6E02d77e5b9eA50D337dfF280',
        note: '',
      },
      {
        name: 'Upbet (YES) token',
        address: '0x5f48ed2550D4C17FF337E010a352CE8B00Bd25e9',
        note: '',
      },
      {
        name: 'Downbet (NO) token',
        address: '0xb229940Ca48B8c6da6576eD4B524669F02cd3AB7',
        note: '',
      },
      {
        name: 'LiquidationEngine',
        address: '0x93eD293bF4cfa8dA851Cb736923bD44b71e65502',
        note: '',
      },
      {
        name: 'OracleRouter',
        address: '0xD75220802b1A0FA9472c7E8D5Cf46B74217F6084',
        note: '',
      },
    ],
  },
  {
    title: 'Turkey',
    rows: [
      {
        name: 'CreditMarket',
        address: '0xA891D433DEcEf0d35C40f93b86057411777Ca594',
        note: '',
      },
      {
        name: 'CLOBSettlement',
        address: '0xfd5a4CE143117c6Be8fb5363AD0fB265345fdC57',
        note: '',
      },
      {
        name: 'Upbet (YES) token',
        address: '0xf20ee08ab83490f09A3CF0E93Be339B51636991d',
        note: '',
      },
      {
        name: 'Downbet (NO) token',
        address: '0x41495b3555Ac80783e90afE707e93c49a7a49e38',
        note: '',
      },
      {
        name: 'LiquidationEngine',
        address: '0xb84b373F12a3a52dE3b3800b75ab2A4Af56570Db',
        note: '',
      },
      {
        name: 'OracleRouter',
        address: '0x046B4F6D055B899Fa58254b6E23338c30d9b3917',
        note: '',
      },
    ],
  },
]

function AddressTable({ rows }: { rows: Row[] }) {
  return (
    <div className="docs-table-wrap">
      <table>
        <thead>
          <tr>
            <th>Contract</th>
            <th>Address</th>
            <th>Notes</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.address}>
              <td>{c.name}</td>
              <td>
                <a
                  href={`https://sepolia.basescan.org/address/${c.address}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <code>{c.address}</code>
                </a>
              </td>
              <td>{c.note}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export default function ContractAddressesPage() {
  return (
    <div>
      <h1>Contracts &amp; addresses</h1>

      <div className="docs-callout docs-callout--warning">
        <p>
          Pari currently runs on Base Sepolia (chainId 84532). Nothing here is mainnet; balances are
          testnet USDC.
        </p>
      </div>

      <p>Each market has its own set of contracts; the InsuranceFund is shared by all of them.</p>

      <h2>Shared</h2>
      <AddressTable rows={SHARED} />

      {MARKETS.map((m) => (
        <section key={m.title}>
          <h2>{m.title}</h2>
          <AddressTable rows={m.rows} />
        </section>
      ))}

      <h2>Hosted services</h2>
      <p>
        Order book API: <code>https://order-book-server-production-9bb6.up.railway.app</code>{' '}
        (health: <code>GET /orderbook</code>).
      </p>

      <div className="docs-callout docs-callout--danger">
        <p>
          Do NOT add the Upbet/Downbet tokens to your wallet as custom tokens — they report 18
          decimals but all balances are 6-decimal scale, so wallet displays are wrong by a
          trillion×. Use the Portfolio page.
        </p>
      </div>
    </div>
  )
}
