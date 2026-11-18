import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Contracts & addresses — Pari Docs',
}

type Row = { name: string; address: `0x${string}`; note: string }

// Batch-4 contracts (2026-11-18) — contracts/deployments/base-sepolia/{core.json,markets/*.json}.
const SHARED: Row[] = [
  {
    name: 'MarketRegistry',
    address: '0x36a1507fef705E8760d40bD8c959F40d242e342a',
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
        address: '0x5914fCd859Bfdf3FB28c31718b3d710e83B217B1',
        note: 'collateral, carry ledger, mint/redeem/settle',
      },
      {
        name: 'CLOBSettlement',
        address: '0x33d8D90BE92ccbBDc5741c55767f34bB614D8e30',
        note: 'on-chain trade settlement (EIP-712 verifying contract)',
      },
      {
        name: 'Upbet (YES) token',
        address: '0xf8BA06fDA5B5F22A7810FfE4d36E47Cd25dFf4Cf',
        note: '',
      },
      {
        name: 'Downbet (NO) token',
        address: '0x99cDb69C3742f1a77f4714FACD8b97b395314ebe',
        note: '',
      },
      {
        name: 'LiquidationEngine',
        address: '0x376F46aadf07506213B088E55327e5bB7De237C3',
        note: 'claims of flagged positions',
      },
      {
        name: 'OracleRouter',
        address: '0xa10101825167BDe5F779e42a33FEa08e6c8E3828',
        note: 'credit-event attestations',
      },
    ],
  },
  {
    title: 'CoreWeave',
    rows: [
      {
        name: 'CreditMarket',
        address: '0x0E086feb7A91a89291460Cb81A045B5deac96Ae6',
        note: '',
      },
      {
        name: 'CLOBSettlement',
        address: '0xB1002c846f55A91FfC2E6FBf8AC02c54Fc1D5E7b',
        note: '',
      },
      {
        name: 'Upbet (YES) token',
        address: '0xCA1B3eacb4945D8cB25779c03e82Ee8AaEA55887',
        note: '',
      },
      {
        name: 'Downbet (NO) token',
        address: '0xA008B310D534b0169672550eF4169730b9a9623b',
        note: '',
      },
      {
        name: 'LiquidationEngine',
        address: '0xb7bb56e9d0213695c54ab22401D5C9C903ff3182',
        note: '',
      },
      {
        name: 'OracleRouter',
        address: '0x473f297888DA3a974d5D0bB758C8734738Ce3B3e',
        note: '',
      },
    ],
  },
  {
    title: 'Turkey',
    rows: [
      {
        name: 'CreditMarket',
        address: '0xD089e1A07e4BFCCf6CA432521240Ac1406D84566',
        note: '',
      },
      {
        name: 'CLOBSettlement',
        address: '0x08fc0ae72d616BcB9D530a465A449E35262B0222',
        note: '',
      },
      {
        name: 'Upbet (YES) token',
        address: '0x4Dab7a0281a2B0CA9a6f66aeD43D07Aa8701D6c6',
        note: '',
      },
      {
        name: 'Downbet (NO) token',
        address: '0x97269ba38cA62c98d9592c3De30b39FFe5906690',
        note: '',
      },
      {
        name: 'LiquidationEngine',
        address: '0x5C41D2a5B78E83dBE7E449c59034c0A4396d7941',
        note: '',
      },
      {
        name: 'OracleRouter',
        address: '0x2159bc99AAF6B54D43BEe982b543C5B5C83bc69A',
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
