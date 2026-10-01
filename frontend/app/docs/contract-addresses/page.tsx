import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'Contracts & addresses — Pari Docs',
}

const CONTRACTS: { name: string; address: `0x${string}`; note: string }[] = [
  {
    name: 'CreditMarket',
    address: '0xe8D0448Fb825875AE2CEFfEdA561Ea98508F8369',
    note: 'collateral, carry ledger, mint/redeem/settle',
  },
  {
    name: 'CLOBSettlement',
    address: '0x8048d8CC6A8e4d0101bDD9B9251c39a65E47FA25',
    note: 'on-chain trade settlement (EIP-712 verifying contract)',
  },
  {
    name: 'Upbet (YES) token',
    address: '0x9ED5A4c6B1B5334645Ec47e7ce087e281fcEC59D',
    note: '',
  },
  {
    name: 'Downbet (NO) token',
    address: '0xFcFf6488677A852D724B7659649176115D5f296e',
    note: '',
  },
  {
    name: 'LiquidationEngine',
    address: '0xd041293744b255952d760aF3594714c61697cc9E',
    note: 'claims of flagged positions',
  },
  {
    name: 'InsuranceFund',
    address: '0x1a0dB241CE7D0fd3b0C22cd45285a41D185B403b',
    note: 'backstops liquidation shortfalls; receives 50% of trade fees',
  },
  {
    name: 'OracleRouter',
    address: '0xb125C4E351134c444d7c142E7bb98Cb4b72d2226',
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
