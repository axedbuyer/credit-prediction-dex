// Post-cutover check (runbook §6): a fresh test wallet buys the whole best resting
// Upbet (YES) ask on a market on the HOSTED order book, then waits for the hosted
// matching engine to settle it on-chain. YES buys are fee-free. CLOBSettlement only
// settles whole orders, so the buy mirrors the ask's exact amounts — a different-size
// order would never be matched against it (both would just keep resting).
//
// Run:  set -a && . ../../contracts/.env && set +a && \
//       ORDER_BOOK_URL=https://order-book-server-production-9bb6.up.railway.app \
//       npx tsx sepolia-test-trade.ts --market mstr
// Needs TEST_TAKER_PRIVATE_KEY (a wallet holding a little ETH + USDC).
import { createPublicClient, createWalletClient, http, parseAbi, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { signOrder, toWire, postOrder, nextNonce, type OrderInput } from './clob'

const RPC = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org'
const ORDER_BOOK = process.env.ORDER_BOOK_URL ?? 'http://localhost:3001'
const KEY = process.env.TEST_TAKER_PRIVATE_KEY as `0x${string}`
if (!KEY) throw new Error('TEST_TAKER_PRIVATE_KEY not set (source contracts/.env)')

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
])
const MAX = 2n ** 256n - 1n

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

  // GET /orderbook returns raw signed orders for both tokens; a YES ask sells YES for USDC.
  const book = (await (await fetch(`${ORDER_BOOK}/orderbook?market=${slug}`)).json()) as {
    asks: Array<{ tokenIn: string; amountIn: string; minAmountOut: string }>
  }
  const yesAsks = book.asks.filter((a) => a.tokenIn.toLowerCase() === m.yesToken.toLowerCase())
  if (!yesAsks.length) throw new Error('no resting Upbet asks')
  const ask = yesAsks.reduce((b, a) =>
    Number(a.minAmountOut) / Number(a.amountIn) < Number(b.minAmountOut) / Number(b.amountIn) ? a : b)
  const QTY = BigInt(ask.amountIn) // tokens the ask sells
  const amountIn = BigInt(ask.minAmountOut) // USDC it asks for
  const best = Number(amountIn) / Number(QTY)
  console.log(`${slug}: taker ${account.address} buys ${Number(QTY) / 1e6} Upbet @ ${(best * 100).toFixed(2)}¢ (${Number(amountIn) / 1e6} USDC)`)

  const allowance = await pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, m.clobSettlement] })
  if (allowance < amountIn) {
    const hash = await wallet.writeContract({ address: USDC, abi: ERC20_ABI, functionName: 'approve', args: [m.clobSettlement, MAX] })
    await pub.waitForTransactionReceipt({ hash })
    console.log(`  approved USDC → CLOB ${hash.slice(0, 14)}…`)
  }

  const before = await pub.readContract({ address: m.yesToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] })
  const order: OrderInput = {
    maker: account.address, tokenIn: USDC, tokenOut: m.yesToken, amountIn, minAmountOut: QTY,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 3600), nonce: nextNonce(),
  }
  const sig = await signOrder({ privateKey: KEY } as any, order, baseSepolia.id, m.clobSettlement)
  const res = await postOrder(ORDER_BOOK, toWire(order, sig))
  if (res.status !== 200 && res.status !== 201) throw new Error(`POST /order ${res.status} ${res.error}`)
  console.log(`  order ${res.orderId} accepted; waiting for on-chain settlement…`)

  for (let t = 0; t < 36; t++) {
    await new Promise((r) => setTimeout(r, 5000))
    const bal = await pub.readContract({ address: m.yesToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] })
    if (bal >= before + QTY) {
      console.log(`  SETTLED: taker Upbet balance ${Number(bal) / 1e6}`)
      return
    }
  }
  throw new Error('not settled within 3 minutes — check matching-engine /health')
}

main().catch((e) => { console.error(e); process.exit(1) })
