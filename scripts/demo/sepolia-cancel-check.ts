// Post-cutover check (batch-3 runbook §6): the test wallet rests a 1-Upbet bid far
// below the market, cancels it ON-CHAIN (CLOBSettlement.cancelOrders), asks the book to
// drop it (POST /orders/sync) and confirms it is gone — the same path as the market
// page's "Your Open Orders" Cancel button. No USDC moves (the bid never fills).
//
// Run:  set -a && . ../../contracts/.env && set +a && \
//       ORDER_BOOK_URL=https://order-book-server-production-9bb6.up.railway.app \
//       npx tsx sepolia-cancel-check.ts --market mstr
import { createPublicClient, createWalletClient, http, parseAbi, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { signOrder, toWire, postOrder, nextNonce, type OrderInput } from './clob'

const RPC = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org'
const ORDER_BOOK = process.env.ORDER_BOOK_URL ?? 'http://localhost:3001'
const KEY = process.env.TEST_TAKER_PRIVATE_KEY as `0x${string}`
if (!KEY) throw new Error('TEST_TAKER_PRIVATE_KEY not set (source contracts/.env)')

const CLOB_ABI = parseAbi([
  'struct Order { address maker; address tokenIn; address tokenOut; uint256 amountIn; uint256 minAmountOut; uint256 expiry; uint256 nonce; }',
  'function cancelOrders(Order[] orders)',
  'function remaining(Order order) view returns (uint256)',
])

const account = privateKeyToAccount(KEY)
const transport = http(RPC)
const pub = createPublicClient({ chain: baseSepolia, transport })
const wallet = createWalletClient({ account, chain: baseSepolia, transport })

async function main() {
  const i = process.argv.indexOf('--market')
  const slug = i >= 0 ? process.argv[i + 1] : undefined
  if (!slug) throw new Error('usage: --market <slug>')

  const { markets } = (await (await fetch(`${ORDER_BOOK}/markets`)).json()) as {
    markets: Array<{ slug: string; active: boolean; yesToken: Address; clobSettlement: Address }>
  }
  const m = markets.find((x) => x.slug === slug)
  if (!m?.active) throw new Error(`market "${slug}" unknown or inactive`)
  const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as Address // Base Sepolia USDC

  // 1 Upbet for 0.001 USDC (0.1¢) — rests below every seeded bid, never fills.
  const order: OrderInput = {
    maker: account.address, tokenIn: USDC, tokenOut: m.yesToken, amountIn: 1_000n, minAmountOut: 1_000_000n,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600), nonce: nextNonce(),
  }
  const sig = await signOrder({ privateKey: KEY } as any, order, baseSepolia.id, m.clobSettlement)
  const res = await postOrder(ORDER_BOOK, toWire(order, sig))
  if (res.status !== 200 && res.status !== 201) throw new Error(`POST /order ${res.status} ${res.error}`)
  const inBook = async () => {
    const book = (await (await fetch(`${ORDER_BOOK}/orderbook?market=${slug}`)).json()) as { bids: Array<{ id: string }> }
    return book.bids.some((b) => b.id === res.orderId)
  }
  console.log(`${slug}: bid ${res.orderId} resting: ${await inBook()}`)

  const hash = await wallet.writeContract({ address: m.clobSettlement, abi: CLOB_ABI, functionName: 'cancelOrders', args: [[order]] })
  await pub.waitForTransactionReceipt({ hash })
  // A load-balanced public RPC can answer from a node a block behind the receipt, so
  // retry the read and the sync (as the market page does) until the cancel is visible.
  let left = 1n
  for (let t = 0; t < 5 && left !== 0n; t++) {
    if (t > 0) await new Promise((r) => setTimeout(r, 2000))
    left = await pub.readContract({ address: m.clobSettlement, abi: CLOB_ABI, functionName: 'remaining', args: [order] })
  }
  console.log(`  cancelOrders ${hash.slice(0, 14)}… → remaining() ${left}`)

  for (let t = 0; t < 5 && (await inBook()); t++) {
    if (t > 0) await new Promise((r) => setTimeout(r, 2000))
    const sync = await fetch(`${ORDER_BOOK}/orders/sync`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ market: slug, maker: account.address }),
    })
    console.log(`  POST /orders/sync ${sync.status} ${await sync.text()}`)
  }
  const still = await inBook()
  console.log(still ? '  FAIL: order still in the book' : '  OK: order removed from the book')
  if (still || left !== 0n) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
