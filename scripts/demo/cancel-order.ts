// Cancels a resting order via DELETE /order/:id (signed EIP-712 CancelOrder).
// Usage: tsx cancel-order.ts <orderId> <makerLabel: A|B|C|D>
import { privateKeyToAccount } from 'viem/accounts'
import { A, B, C, D } from './wallets'

const ORDER_BOOK_URL = process.env.ORDER_BOOK_URL!
const CHAIN_ID = Number(process.env.CHAIN_ID!)
const CLOB_ADDR = process.env.CLOB_SETTLEMENT_ADDRESS! as `0x${string}`

const CANCEL_TYPES = {
  CancelOrder: [{ name: 'orderId', type: 'string' }],
} as const

async function main() {
  const [orderId, makerLabel] = process.argv.slice(2)
  const maker = { A, B, C, D }[makerLabel!]
  if (!orderId || !maker) throw new Error('usage: tsx cancel-order.ts <orderId> <A|B|C|D>')

  const account = privateKeyToAccount(maker.privateKey)
  const signature = await account.signTypedData({
    domain: { name: 'CLOBSettlement', version: '1', chainId: CHAIN_ID, verifyingContract: CLOB_ADDR },
    types: CANCEL_TYPES,
    primaryType: 'CancelOrder',
    message: { orderId },
  })

  const res = await fetch(`${ORDER_BOOK_URL}/order/${orderId}`, {
    method: 'DELETE',
    headers: { 'X-Maker': maker.address, 'X-Signature': signature },
  })
  console.log('DELETE status:', res.status, await res.json().catch(() => ({})))
}

main().catch(e => { console.error(e); process.exit(1) })
