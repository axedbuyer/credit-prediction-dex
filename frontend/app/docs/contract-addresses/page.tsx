import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Contracts & addresses — Pari Docs',
}

type Row = { name: string; address: `0x${string}`; note: string }

// Batch-3 contracts (2026-10-17) — contracts/deployments/base-sepolia/{core.json,markets/*.json}.
const SHARED: Row[] = [
  {
    name: 'MarketRegistry',
    address: '0xA7bcc124aF821388886012B905Ba8cF4B79469b1',
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
        address: '0x89e54F5e5C996174D9d2e52dbf90589b2f355d3A',
        note: 'collateral, carry ledger, mint/redeem/settle',
      },
      {
        name: 'CLOBSettlement',
        address: '0x3dB1b2CD9B427C6E3ACdB73901125A4257D1b540',
        note: 'on-chain trade settlement (EIP-712 verifying contract)',
      },
      {
        name: 'Upbet (YES) token',
        address: '0x0Fe03367f54e93625Ef26C8D7759225b9Ca99197',
        note: '',
      },
      {
        name: 'Downbet (NO) token',
        address: '0xfdBA4301169A6595FE651E303c50D50a59fb7EF0',
        note: '',
      },
      {
        name: 'LiquidationEngine',
        address: '0xCc1b43ef6C26D3805af0cef6a5633aE9dB56364e',
        note: 'claims of flagged positions',
      },
      {
        name: 'OracleRouter',
        address: '0x352B2610d4820B31A7896a8571749BE07151ea60',
        note: 'credit-event attestations',
      },
    ],
  },
  {
    title: 'CoreWeave',
    rows: [
      {
        name: 'CreditMarket',
        address: '0xB6bc5e9FA166520536453FD667B79Fb705ca09b5',
        note: '',
      },
      {
        name: 'CLOBSettlement',
        address: '0xc305b6d159F13075383242Bb0aA43f6Cbe8337fb',
        note: '',
      },
      {
        name: 'Upbet (YES) token',
        address: '0xd747040C24FA0e2EE59a0ac64Bd013E4F329cF3c',
        note: '',
      },
      {
        name: 'Downbet (NO) token',
        address: '0xbFaF87A8A2dcf983be470B5e814AF0Be99E99Db5',
        note: '',
      },
      {
        name: 'LiquidationEngine',
        address: '0xdEA3667904a6663A2b0848A92200E3109c4A2d1d',
        note: '',
      },
      {
        name: 'OracleRouter',
        address: '0x4Ac34d76B6895610B90cA793869dc9c1188b86B5',
        note: '',
      },
    ],
  },
  {
    title: 'Turkey',
    rows: [
      {
        name: 'CreditMarket',
        address: '0xdD1202B077b9B89253006610F80DAD23B9fDf76e',
        note: '',
      },
      {
        name: 'CLOBSettlement',
        address: '0xE2ce4475de6AD60Fd9DEC54925275CA646E71325',
        note: '',
      },
      {
        name: 'Upbet (YES) token',
        address: '0x22b817A301d19d4cb9a20714eBaDf1898B932E03',
        note: '',
      },
      {
        name: 'Downbet (NO) token',
        address: '0x51324e748E171385Fa9b89CA07e06B81Ae093A5f',
        note: '',
      },
      {
        name: 'LiquidationEngine',
        address: '0x787Ce5B37C8D1064c09B193c56C6CC88B3093737',
        note: '',
      },
      {
        name: 'OracleRouter',
        address: '0x470218241E1ACEdCe947B2e75dB8199038b3df96',
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
