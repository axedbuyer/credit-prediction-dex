import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Contracts & addresses — Pari Docs',
}

const CONTRACTS: { name: string; address: `0x${string}`; note: string }[] = [
  {
    name: 'CreditMarket',
    address: '0x26C3d2E6C29e8E414A4424aa9c9AFa5eFF15F51b',
    note: 'collateral, carry ledger, mint/redeem/settle',
  },
  {
    name: 'CLOBSettlement',
    address: '0xC31702C1C2c41FcCb57446E0fda5091412bccB8e',
    note: 'on-chain trade settlement (EIP-712 verifying contract)',
  },
  {
    name: 'Upbet (YES) token',
    address: '0x0228cf2f1BD7F11D07fA3c190F495171D35C85be',
    note: '',
  },
  {
    name: 'Downbet (NO) token',
    address: '0xB6Ca19E4590E28214902c18d37351238170E3D76',
    note: '',
  },
  {
    name: 'LiquidationEngine',
    address: '0x16Be3ac2f3d76f95a86BE961b2fE5B8EFB53c6B5',
    note: 'claims of flagged positions',
  },
  {
    name: 'InsuranceFund',
    address: '0xEDbBF8ffF57198bc44897A519088FE5AcD828aB1',
    note: 'backstops liquidation shortfalls; receives 50% of trade fees',
  },
  {
    name: 'OracleRouter',
    address: '0xDB8aD9aBF47870f1117382E22b764E90C862C8Bc',
    note: 'credit-event attestations',
  },
  {
    name: 'USDC (Base Sepolia)',
    address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    note: '',
  },
]

export default function ContractAddressesPage() {
  return (
    <div>
      <h1>Contracts &amp; addresses</h1>

      <div className="docs-callout docs-callout--warning">
        <p>
          Pari currently runs on Base Sepolia (chainId 84532). Nothing here is mainnet;
          balances are testnet USDC.
        </p>
      </div>

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
            {CONTRACTS.map((c) => (
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

      <h2>Hosted services</h2>
      <p>
        Order book API:{' '}
        <code>https://order-book-server-production-9bb6.up.railway.app</code> (health:{' '}
        <code>GET /orderbook</code>).
      </p>

      <div className="docs-callout docs-callout--danger">
        <p>
          Do NOT add the Upbet/Downbet tokens to your wallet as custom tokens — they report
          18 decimals but all balances are 6-decimal scale, so wallet displays are wrong by
          a trillion×. Use the Portfolio page.
        </p>
      </div>
    </div>
  )
}
