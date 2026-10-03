// One-shot market-maker seeding for the LIVE Base Sepolia deployment.
// Mints YES+NO from the deployer's USDC and rests a two-sided book around the
// 23% mark via the local order-book-server. Reuses clob.ts signing helpers.
//
// Run:  set -a && . ../../contracts/.env && set +a && npx tsx mm-sepolia-seed.ts
// Multi-market: add `--market <slug>` (or MM_MARKET=<slug>) to seed that market; its
// CreditMarket/YES/NO/CLOB addresses come from the order-book-server's GET /markets
// instead of deployments/base-sepolia.json (which only describes mstr).
import { createPublicClient, createWalletClient, http, parseAbi, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { signOrder, toWire, postOrder, nextNonce, type OrderInput } from './clob'
import { minGrossForNet } from '../../frontend/lib/feeMath'
import deployments from '../../contracts/deployments/base-sepolia.json'

const RPC = process.env.BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org'
const ORDER_BOOK = process.env.ORDER_BOOK_URL ?? 'http://localhost:3001'
const KEY = process.env.DEPLOYER_PRIVATE_KEY as `0x${string}`
if (!KEY) throw new Error('DEPLOYER_PRIVATE_KEY not set (source contracts/.env)')

const USDC = deployments.usdc as Address
let YES = deployments.yesToken as Address
let NO = deployments.noToken as Address
let CREDIT_MARKET = deployments.creditMarket as Address
let CLOB_SETTLEMENT = deployments.clobSettlement as Address

const ERC20_ABI = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
])
const MARKET_ABI = parseAbi(['function mint(uint256 usdcAmount)'])
const MAX = 2n ** 256n - 1n

const account = privateKeyToAccount(KEY)
const transport = http(RPC)
const pub = createPublicClient({ chain: baseSepolia, transport })
const wallet = createWalletClient({ account, chain: baseSepolia, transport })

async function send(to: Address, abi: any, functionName: string, args: unknown[]) {
  const hash = await wallet.writeContract({ address: to, abi, functionName, args })
  const receipt = await pub.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`${functionName} reverted: ${hash}`)
  console.log(`  ${functionName}(${args[0]}...) ok ${hash.slice(0, 14)}…`)
}

// price in USDC per token (6-dec both sides); qty in whole tokens
function sellOrder(token: Address, qty: number, price: number): OrderInput {
  const amountIn = BigInt(Math.round(qty * 1e6))
  return {
    maker: account.address, tokenIn: token, tokenOut: USDC,
    amountIn, minAmountOut: BigInt(Math.round(qty * price * 1e6)),
    expiry: BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600), nonce: nextNonce(),
  }
}
function buyOrder(token: Address, qty: number, price: number): OrderInput {
  const qty6 = BigInt(Math.round(qty * 1e6))
  const net = BigInt(Math.round(qty * price * 1e6))
  return {
    maker: account.address, tokenIn: USDC, tokenOut: token,
    // NO buys pay the carry-side fee inside the signed amountIn — sign GROSS so
    // the bid rests at the intended net price (YES buys are fee-free).
    amountIn: token === NO ? minGrossForNet(net, qty6) : net, minAmountOut: qty6,
    expiry: BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600), nonce: nextNonce(),
  }
}

// --market <slug> | MM_MARKET=<slug>: resolve the market's contracts from the
// order-book-server directory. Absent => the mstr addresses from the deployments file.
async function resolveMarket(): Promise<void> {
  const i = process.argv.indexOf('--market')
  const slug = (i >= 0 ? process.argv[i + 1] : undefined) ?? process.env.MM_MARKET
  if (!slug) return
  const res = await fetch(`${ORDER_BOOK}/markets`)
  if (!res.ok) throw new Error(`GET ${ORDER_BOOK}/markets failed: ${res.status}`)
  const { markets } = (await res.json()) as { markets: Array<{ slug: string; active: boolean; creditMarket: Address; yesToken: Address; noToken: Address; clobSettlement: Address }> }
  const m = markets.find(x => x.slug === slug)
  if (!m) throw new Error(`unknown market "${slug}" (have: ${markets.map(x => x.slug).join(', ')})`)
  if (!m.active) throw new Error(`market "${slug}" is inactive`)
  ;({ yesToken: YES, noToken: NO, creditMarket: CREDIT_MARKET, clobSettlement: CLOB_SETTLEMENT } = m)
  console.log(`market: ${slug}  yes=${YES} no=${NO} clob=${CLOB_SETTLEMENT}`)
}

async function main() {
  await resolveMarket()
  console.log(`MM seeding from ${account.address} via ${RPC}`)

  console.log('1. approvals (skip if already max)…')
  for (const [token, spender] of [
    [USDC, CREDIT_MARKET], [USDC, CLOB_SETTLEMENT], [YES, CLOB_SETTLEMENT], [NO, CLOB_SETTLEMENT],
  ] as [Address, Address][]) {
    const cur = await pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [account.address, spender] })
    if (cur < MAX / 2n) await send(token, ERC20_ABI, 'approve', [spender, MAX])
  }

  console.log('2. mint 12 USDC → 12 YES + 12 NO…')
  const yesBal = await pub.readContract({ address: YES, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] })
  if (yesBal < 12_000_000n) await send(CREDIT_MARKET, MARKET_ABI, 'mint', [12_000_000n])
  else console.log('  already minted, skipping')

  console.log('3. resting quotes around 23%…')
  const quotes: [string, OrderInput][] = [
    ['ask YES 4 @ 24¢', sellOrder(YES, 4, 0.24)],
    ['ask YES 4 @ 26¢', sellOrder(YES, 4, 0.26)],
    ['bid YES 4 @ 22¢', buyOrder(YES, 4, 0.22)],
    ['bid YES 4 @ 20¢', buyOrder(YES, 4, 0.20)],
    ['ask NO  4 @ 77¢', sellOrder(NO, 4, 0.77)],
    ['ask NO  4 @ 79¢', sellOrder(NO, 4, 0.79)],
    ['bid NO  4 @ 75¢', buyOrder(NO, 4, 0.75)],
  ]
  for (const [label, order] of quotes) {
    const sig = await signOrder({ privateKey: KEY } as any, order, baseSepolia.id, CLOB_SETTLEMENT)
    const res = await postOrder(ORDER_BOOK, toWire(order, sig))
    console.log(`  ${label}: ${res.status === 200 || res.status === 201 ? `ok ${res.orderId}` : `FAILED ${res.status} ${res.error}`}`)
  }
  console.log('done.')
}

main().catch(e => { console.error(e); process.exit(1) })
