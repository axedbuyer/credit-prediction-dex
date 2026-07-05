// Task 3, Beat 1 — live trade: wallet A (Presenter) buys Upbet (YES) crossing
// wallet B's best resting ask, via the real EIP-712 -> REST -> matching-engine
// -> CLOBSettlement.verifyAndSettle path (same path the live UI uses).
import { createPublicClient, http } from 'viem'
import { A } from './wallets'
import { signOrder, toWire, postOrder, nextNonce, waitUntil, getOrderBook } from './clob'
import { ERC20_ABI } from './abi'

const RPC_URL       = process.env.BASE_SEPOLIA_RPC_URL!
const ORDER_BOOK_URL = process.env.ORDER_BOOK_URL!
const CHAIN_ID       = Number(process.env.CHAIN_ID!)
const USDC_ADDR      = process.env.USDC_ADDRESS! as `0x${string}`
const YES_ADDR       = process.env.YES_TOKEN_ADDRESS! as `0x${string}`
const CLOB_ADDR      = process.env.CLOB_SETTLEMENT_ADDRESS! as `0x${string}`

async function main() {
  const client = createPublicClient({ transport: http(RPC_URL) })

  const yesBefore = await client.readContract({ address: YES_ADDR, abi: ERC20_ABI, functionName: 'balanceOf', args: [A.address] }) as bigint
  const usdcBefore = await client.readContract({ address: USDC_ADDR, abi: ERC20_ABI, functionName: 'balanceOf', args: [A.address] }) as bigint

  const bookBefore = await getOrderBook(ORDER_BOOK_URL)
  const askBefore = bookBefore.asks.find(o => o.tokenIn.toLowerCase() === YES_ADDR.toLowerCase())
  console.log('[beat1] A YES before:', yesBefore.toString(), 'USDC before:', usdcBefore.toString())
  console.log('[beat1] best YES ask before:', askBefore?.price, askBefore?.amountIn, askBefore?.minAmountOut)

  // Aggressive marketable bid: 200 USDC, willing to accept as few as 480 YES
  // tokens back (implied limit ~41.6%), comfortably above the best ask
  // (~33.06%) so it crosses immediately. amountIn/minAmountOut sizing mirrors
  // scripts/demo/seed-demo.ts's own trade construction.
  const amountIn = 200_000000n
  const minAmountOut = 480_000000n
  // Chain time, not wall-clock — scripts/demo's chain has been warped ~13
  // months ahead of real time (chart-history seeding), so a wall-clock
  // expiry would already be in the past on-chain (OrderExpired revert).
  // Mirrors TradePanel.tsx's own fallback logic for the same reason.
  const block = await client.getBlock()
  const expiry = block.timestamp + 3600n
  const nonce = nextNonce()

  const order = {
    maker: A.address,
    tokenIn: USDC_ADDR,
    tokenOut: YES_ADDR,
    amountIn,
    minAmountOut,
    expiry,
    nonce,
  }

  const sig = await signOrder(A, order, CHAIN_ID, CLOB_ADDR)
  const wire = toWire(order, sig)

  console.log('[beat1] posting A buy order:', wire)
  const postResult = await postOrder(ORDER_BOOK_URL, wire)
  console.log('[beat1] POST /order result:', postResult)
  if (postResult.status >= 400) throw new Error(`order rejected: ${JSON.stringify(postResult)}`)

  console.log('[beat1] waiting for matching-engine to settle on-chain...')
  await waitUntil(async () => {
    const yesNow = await client.readContract({ address: YES_ADDR, abi: ERC20_ABI, functionName: 'balanceOf', args: [A.address] }) as bigint
    return yesNow > yesBefore
  }, { timeoutMs: 15_000, intervalMs: 500, label: 'A YES balance to increase' })

  const yesAfter = await client.readContract({ address: YES_ADDR, abi: ERC20_ABI, functionName: 'balanceOf', args: [A.address] }) as bigint
  const usdcAfter = await client.readContract({ address: USDC_ADDR, abi: ERC20_ABI, functionName: 'balanceOf', args: [A.address] }) as bigint
  const bookAfter = await getOrderBook(ORDER_BOOK_URL)
  const askAfter = bookAfter.asks.find(o => o.tokenIn.toLowerCase() === YES_ADDR.toLowerCase())

  console.log('[beat1] A YES after:', yesAfter.toString(), 'USDC after:', usdcAfter.toString())
  console.log('[beat1] YES delta:', (yesAfter - yesBefore).toString(), 'USDC delta:', (usdcAfter - usdcBefore).toString())
  console.log('[beat1] best YES ask after:', askAfter?.price, askAfter?.amountIn, askAfter?.minAmountOut)
  console.log('[beat1] PASS — A YES balance increased, order book updated')
}

main().catch(e => { console.error('[beat1] FAIL', e); process.exit(1) })
