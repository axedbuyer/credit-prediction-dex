// Seeds the local anvil demo stack with every state a BD meeting needs to show:
//   - a resting order book with recent-trade history
//   - a price-chart history (~10-12 months of FundingAccrued events)
//   - Wallet D ("Doomed Upbet") already flagged claimable -> shows up in /liquidate
//   - Wallet C ("Distressed Upbet") close to the trigger but NOT flagged -> the
//     live demo runs `warp.sh` to push it over the edge in the meeting itself
//
// Run via demo-up.sh, which exports all the env vars this script reads.
//
// IMPORTANT funding-model subtlety this script works around (see root
// CLAUDE.md's "Funding settlement points"): settleFunding(user) resets
// fundingSnapshot[user] to the CURRENT global index on every touch — mint,
// AND every CLOB trade (buyer and seller side, regardless of which token is
// being traded). So a NO-side sale is a full snapshot reset too, not just a
// YES-side one. To make Wallet D accrue more per-unit funding than Wallet C
// by the end of the chart-history warp, D's *last touch* (its NO sale) must
// happen strictly before C's *last touch* (its own NO sale) — an ENTRY_GAP_DAYS
// gap is inserted between the two, which is what actually separates them
// (giving D a "head start" on the per-unit funding index, not just an earlier
// mint timestamp — the mint alone would be erased by the subsequent sale).

import { createPublicClient, createTestClient, createWalletClient, http, defineChain } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex } from 'viem'
import { ERC20_ABI, CREDIT_MARKET_ABI } from './abi'
import { A, B, C, D, DEPLOYER, KEEPER } from './wallets'
import type { DemoAccount } from './wallets'
import { signOrder, toWire, postOrder, getOrderBook, nextNonce, waitUntil, sleep } from './clob'
import type { OrderInput } from './clob'

// ─── config (env vars set by demo-up.sh) ──────────────────────────────────────

const RPC_URL          = process.env.BASE_SEPOLIA_RPC_URL ?? 'http://127.0.0.1:8547'
const ORDER_BOOK_URL   = process.env.ORDER_BOOK_URL ?? 'http://localhost:3011'
const CHAIN_ID         = parseInt(process.env.CHAIN_ID ?? '84532')
const USDC             = requireEnv('USDC_ADDRESS') as Address
const YES              = requireEnv('YES_TOKEN_ADDRESS') as Address
const NO               = requireEnv('NO_TOKEN_ADDRESS') as Address
const CREDIT_MARKET    = requireEnv('CREDIT_MARKET_ADDRESS') as Address
const CLOB_SETTLEMENT  = requireEnv('CLOB_SETTLEMENT_ADDRESS') as Address

function requireEnv(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`${name} env var is required (set by demo-up.sh)`)
  return v
}

const WAD = 1_000_000_000_000_000_000n
const MAX_UINT256 = 2n ** 256n - 1n
const DAY = 86_400
const WEEK = 7 * DAY

// Tunable knobs for the chart-history warp — see header comment.
const ENTRY_GAP_DAYS = 5          // gap between D's and C's last CLOB touch
const MAX_COARSE_WEEKS = 60       // weekly-step safety cap
const MAX_FINE_DAYS = 45          // daily-step safety cap (fine phase)
const COARSE_SWITCH_EPOCHS = 12n  // switch to daily granularity once D is this close

function u6(x: number): bigint {
  // 6-decimal raw scale (USDC + YES/NO share this raw-unit convention — see
  // root CLAUDE.md: mint() mints YES/NO 1:1 with the raw USDC amount, so the
  // token's own ERC20 `decimals()` metadata — default 18 — is irrelevant to
  // the actual integer math).
  return BigInt(Math.round(x * 1e6))
}

// ─── clients ───────────────────────────────────────────────────────────────────

const chain = defineChain({
  id: CHAIN_ID,
  name: 'demo-anvil',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
})
const transport = http(RPC_URL)
const publicClient = createPublicClient({ chain, transport })
const testClient = createTestClient({ chain, mode: 'anvil', transport })

const walletCache = new Map<string, ReturnType<typeof createWalletClient>>()
function walletFor(acc: DemoAccount) {
  const cached = walletCache.get(acc.address)
  if (cached) return cached
  const wallet = createWalletClient({ account: privateKeyToAccount(acc.privateKey), chain, transport })
  walletCache.set(acc.address, wallet)
  return wallet
}

async function send(acc: DemoAccount, address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []): Promise<Hex> {
  const wallet = walletFor(acc)
  const hash = await wallet.writeContract({
    address, abi: abi as any, functionName, args: args as any,
    chain, account: wallet.account!,
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') {
    throw new Error(`tx reverted: ${functionName}(${args.join(',')}) by ${acc.label} — ${hash}`)
  }
  return hash
}

async function read<T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []): Promise<T> {
  return publicClient.readContract({ address, abi: abi as any, functionName, args: args as any }) as Promise<T>
}

async function chainNow(): Promise<bigint> {
  const block = await publicClient.getBlock()
  return block.timestamp
}

async function balances(acc: DemoAccount) {
  const [usdc, yes, no] = await Promise.all([
    read<bigint>(USDC, ERC20_ABI, 'balanceOf', [acc.address]),
    read<bigint>(YES, ERC20_ABI, 'balanceOf', [acc.address]),
    read<bigint>(NO, ERC20_ABI, 'balanceOf', [acc.address]),
  ])
  return { usdc, yes, no }
}

function fmt(raw: bigint): string {
  return (Number(raw) / 1e6).toFixed(2)
}

function fmtMark(raw: bigint): string {
  return (Number(raw) / 1e18 * 100).toFixed(2) + '%'
}

// ─── CLOB helpers ───────────────────────────────────────────────────────────────

// Full round-trip: sign + post both legs of a crossing pair, wait for on-chain
// settlement (matching-engine picks it up within its poll interval).
async function crossTrade(opts: {
  seller: DemoAccount
  buyer: DemoAccount
  token: Address
  tokenAmt: bigint
  usdcAmt: bigint
  label: string
}): Promise<void> {
  const { seller, buyer, token, tokenAmt, usdcAmt, label } = opts
  const expiry = (await chainNow()) + 2n * BigInt(DAY)

  const sellOrder: OrderInput = {
    maker: seller.address, tokenIn: token, tokenOut: USDC,
    amountIn: tokenAmt, minAmountOut: usdcAmt, expiry, nonce: nextNonce(),
  }
  const buyOrder: OrderInput = {
    maker: buyer.address, tokenIn: USDC, tokenOut: token,
    amountIn: usdcAmt, minAmountOut: tokenAmt, expiry, nonce: nextNonce(),
  }
  const sellSig = await signOrder(seller, sellOrder, CHAIN_ID, CLOB_SETTLEMENT)
  const buySig = await signOrder(buyer, buyOrder, CHAIN_ID, CLOB_SETTLEMENT)

  const r1 = await postOrder(ORDER_BOOK_URL, toWire(sellOrder, sellSig))
  if (r1.status !== 201) throw new Error(`[${label}] sell order rejected: ${JSON.stringify(r1)}`)
  const r2 = await postOrder(ORDER_BOOK_URL, toWire(buyOrder, buySig))
  if (r2.status !== 201) throw new Error(`[${label}] buy order rejected: ${JSON.stringify(r2)}`)

  const before = await read<bigint>(token, ERC20_ABI, 'balanceOf', [buyer.address])
  await waitUntil(
    async () => (await read<bigint>(token, ERC20_ABI, 'balanceOf', [buyer.address])) !== before,
    { label: `${label} settlement`, timeoutMs: 25_000 },
  )
  console.log(`  [trade] ${label}: ${seller.label} -> ${buyer.label}, ${fmt(tokenAmt)} tokens @ ${fmt(usdcAmt)} USDC`)
}

// Posts a single resting order (no counterparty) — used for the market maker's book depth.
async function postResting(opts: {
  maker: DemoAccount
  side: 'bid' | 'ask'
  token: Address
  tokenAmt: bigint
  usdcAmt: bigint
  expirySeconds: bigint
}): Promise<void> {
  const { maker, side, token, tokenAmt, usdcAmt, expirySeconds } = opts
  const order: OrderInput = side === 'bid'
    ? { maker: maker.address, tokenIn: USDC, tokenOut: token, amountIn: usdcAmt, minAmountOut: tokenAmt, expiry: expirySeconds, nonce: nextNonce() }
    : { maker: maker.address, tokenIn: token, tokenOut: USDC, amountIn: tokenAmt, minAmountOut: usdcAmt, expiry: expirySeconds, nonce: nextNonce() }
  const sig = await signOrder(maker, order, CHAIN_ID, CLOB_SETTLEMENT)
  const res = await postOrder(ORDER_BOOK_URL, toWire(order, sig))
  if (res.status !== 201) throw new Error(`resting ${side} order rejected: ${JSON.stringify(res)}`)
}

async function sellFullBalance(seller: DemoAccount, buyer: DemoAccount, token: Address, price: number, label: string): Promise<void> {
  const bal = await read<bigint>(token, ERC20_ABI, 'balanceOf', [seller.address])
  if (bal === 0n) {
    console.log(`  [${label}] ${seller.label} has no balance to sell, skipping`)
    return
  }
  const usdcAmt = (bal * BigInt(Math.round(price * 1000))) / 1000n
  await crossTrade({ seller, buyer, token, tokenAmt: bal, usdcAmt, label })
}

// ─── main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== seed-demo.ts starting ===')
  console.log(`RPC=${RPC_URL} orderBook=${ORDER_BOOK_URL} chainId=${CHAIN_ID}`)
  console.log(`CreditMarket=${CREDIT_MARKET} YES=${YES} NO=${NO} USDC=${USDC} CLOB=${CLOB_SETTLEMENT}`)

  // ── 1. roles, USDC faucet, approvals ────────────────────────────────────────
  console.log('\n[1/6] roles + USDC + approvals')
  const KEEPER_ROLE = await read<Hex>(CREDIT_MARKET, CREDIT_MARKET_ABI, 'KEEPER_ROLE')
  await send(DEPLOYER, CREDIT_MARKET, CREDIT_MARKET_ABI, 'grantRole', [KEEPER_ROLE, KEEPER.address])
  await send(DEPLOYER, CREDIT_MARKET, CREDIT_MARKET_ABI, 'grantRole', [KEEPER_ROLE, DEPLOYER.address])
  console.log('  KEEPER_ROLE granted to keeper account + deployer')

  const seedUsdc: [DemoAccount, bigint][] = [
    [A, u6(10_000)],
    [B, u6(30_000)],
    [C, u6(1_200)],
    [D, u6(1_200)],
  ]
  for (const [acc, amt] of seedUsdc) {
    await send(DEPLOYER, USDC, ERC20_ABI, 'mint', [acc.address, amt])
  }
  console.log('  USDC minted to A, B, C, D')

  for (const [acc] of seedUsdc) {
    await send(acc, USDC, ERC20_ABI, 'approve', [CREDIT_MARKET, MAX_UINT256])
    await send(acc, USDC, ERC20_ABI, 'approve', [CLOB_SETTLEMENT, MAX_UINT256])
    await send(acc, YES, ERC20_ABI, 'approve', [CLOB_SETTLEMENT, MAX_UINT256])
    await send(acc, NO, ERC20_ABI, 'approve', [CLOB_SETTLEMENT, MAX_UINT256])
  }
  console.log('  max approvals set for A, B, C, D (USDC->CreditMarket, USDC/YES/NO->CLOBSettlement)')

  // ── 2. D enters early, sells its NO leg (its LAST touch — see header note) ──
  console.log('\n[2/6] D (Doomed Upbet) enters early and sells its NO leg')
  await send(D, CREDIT_MARKET, CREDIT_MARKET_ABI, 'mint', [u6(1000)])
  await sellFullBalance(D, B, NO, 0.77, 'D sells NO')

  // ── head-start gap: warp ENTRY_GAP_DAYS before C touches the ledger ─────────
  console.log(`  advancing ${ENTRY_GAP_DAYS} days (head-start gap) before C enters...`)
  await testClient.increaseTime({ seconds: ENTRY_GAP_DAYS * DAY })
  await testClient.mine({ blocks: 1 })
  await send(DEPLOYER, CREDIT_MARKET, CREDIT_MARKET_ABI, 'accrueFunding')
  let eventCount = 1

  // ── 3. C enters later, sells its NO leg ─────────────────────────────────────
  console.log('\n[3/6] C (Distressed Upbet) enters later and sells its NO leg')
  await send(C, CREDIT_MARKET, CREDIT_MARKET_ABI, 'mint', [u6(1000)])
  await sellFullBalance(C, B, NO, 0.77, 'C sells NO')

  const [dBalAfterSell, cBalAfterSell] = await Promise.all([balances(D), balances(C)])
  console.log(`  D: YES=${fmt(dBalAfterSell.yes)} NO=${fmt(dBalAfterSell.no)} (YES-only, distressed)`)
  console.log(`  C: YES=${fmt(cBalAfterSell.yes)} NO=${fmt(cBalAfterSell.no)} (YES-only, distressed)`)

  // ── 4. chart-history warp: coarse weekly steps, then fine daily steps ───────
  console.log('\n[4/6] warping chain time + mark path for chart history')
  let markWad = await read<bigint>(CREDIT_MARKET, CREDIT_MARKET_ABI, 'currentMark')
  const WEEKLY_DRIFT = 1_600_000_000_000_000n   // ~+0.0016/week (23% -> ~30% over 48 weeks)
  const MARK_MIN = 180_000_000_000_000_000n
  const MARK_MAX = 340_000_000_000_000_000n

  // Random walk: weekly drift up +/- noise in [-0.001, 0.001] WAD, clamped.
  function nextWeeklyMark(): bigint {
    const noise = BigInt(Math.round((Math.random() - 0.5) * 2 * 1_000_000_000_000_000))
    let next = markWad + WEEKLY_DRIFT + noise
    if (next < MARK_MIN) next = MARK_MIN
    if (next > MARK_MAX) next = MARK_MAX
    return next
  }

  let week = 0
  for (; week < MAX_COARSE_WEEKS; week++) {
    markWad = nextWeeklyMark()
    await testClient.increaseTime({ seconds: WEEK })
    await testClient.mine({ blocks: 1 })
    await send(DEPLOYER, CREDIT_MARKET, CREDIT_MARKET_ABI, 'setMark', [markWad])
    eventCount++
    const dEpochs = await read<bigint>(CREDIT_MARKET, CREDIT_MARKET_ABI, 'epochsToExpire', [D.address])
    const dSeizable = await read<boolean>(CREDIT_MARKET, CREDIT_MARKET_ABI, 'isSeizable', [D.address])
    if (week % 4 === 0 || dEpochs < 20n) {
      console.log(`  week ${week + 1}: mark=${fmtMark(markWad)} D.epochsToExpire=${dEpochs} D.isSeizable=${dSeizable}`)
    }
    if (dSeizable || dEpochs < COARSE_SWITCH_EPOCHS) break
  }

  let day = 0
  let dSeizable = await read<boolean>(CREDIT_MARKET, CREDIT_MARKET_ABI, 'isSeizable', [D.address])
  for (; !dSeizable && day < MAX_FINE_DAYS; day++) {
    await testClient.increaseTime({ seconds: DAY })
    await testClient.mine({ blocks: 1 })
    await send(DEPLOYER, CREDIT_MARKET, CREDIT_MARKET_ABI, 'accrueFunding')
    eventCount++
    dSeizable = await read<boolean>(CREDIT_MARKET, CREDIT_MARKET_ABI, 'isSeizable', [D.address])
    const dEpochs = await read<bigint>(CREDIT_MARKET, CREDIT_MARKET_ABI, 'epochsToExpire', [D.address])
    console.log(`  fine day ${day + 1}: D.epochsToExpire=${dEpochs} D.isSeizable=${dSeizable}`)
  }

  if (!dSeizable) {
    throw new Error(
      `D never became seizable after ${week} coarse weeks + ${day} fine days. ` +
      `Tune ENTRY_GAP_DAYS / DRIFT / MAX_COARSE_WEEKS / MAX_FINE_DAYS in seed-demo.ts and re-run.`,
    )
  }

  const [cSeizable, cEpochs] = await Promise.all([
    read<boolean>(CREDIT_MARKET, CREDIT_MARKET_ABI, 'isSeizable', [C.address]),
    read<bigint>(CREDIT_MARKET, CREDIT_MARKET_ABI, 'epochsToExpire', [C.address]),
  ])
  console.log(`\n  warp complete: ${week} coarse weeks + ${day} fine days, ${eventCount} FundingAccrued events`)
  console.log(`  final mark=${fmtMark(markWad)}`)
  console.log(`  D: isSeizable=${dSeizable} (expected true)`)
  console.log(`  C: isSeizable=${cSeizable} (expected false) epochsToExpire=${cEpochs} (expected small, ~2-10)`)
  if (cSeizable) {
    console.warn(
      '  WARNING: C is ALSO seizable — ENTRY_GAP_DAYS is too large relative to the warp path. ' +
      'The demo will still run, but the "close but not frozen" live beat (warp.sh pushing C over ' +
      'the edge) will not work as scripted. Reduce ENTRY_GAP_DAYS and re-run demo-up.sh.',
    )
  }

  // ── 5. keeper flags D as claimable ──────────────────────────────────────────
  console.log('\n[5/6] keeper flags D as claimable')
  await send(KEEPER, CREDIT_MARKET, CREDIT_MARKET_ABI, 'flagClaimable', [D.address])
  const dClaimable = await read<boolean>(CREDIT_MARKET, CREDIT_MARKET_ABI, 'claimable', [D.address])
  console.log(`  D.claimable = ${dClaimable}`)

  // ── 6. A and B mint fresh sets AFTER the warp, resting book + tape ──────────
  console.log('\n[6/6] A/B mint fresh sets, resting book, recent-trade tape')
  await send(A, CREDIT_MARKET, CREDIT_MARKET_ABI, 'mint', [u6(5000)])
  await send(B, CREDIT_MARKET, CREDIT_MARKET_ABI, 'mint', [u6(20_000)])
  console.log('  A minted 5,000 complete set, B minted 20,000 complete set')

  const finalMark = Number(markWad) / 1e18
  const nearAskPrice = Math.min(finalMark + 0.002, finalMark + 0.005)

  // 2-3 small throwaway trades (A buys YES from B) for recent-trades realism —
  // priced BELOW the resting asks below so they get matched first and don't
  // consume the resting book the live demo needs.
  const throwawaySizes = [50, 75, 60]
  for (let i = 0; i < throwawaySizes.length; i++) {
    const yesAmt = u6(throwawaySizes[i])
    const usdcAmt = (yesAmt * BigInt(Math.round(nearAskPrice * 1_000_000))) / 1_000_000n
    await crossTrade({ seller: B, buyer: A, token: YES, tokenAmt: yesAmt, usdcAmt, label: `recent trade #${i + 1}` })
  }

  // Resting book: 3 bids below mark, 3 asks above mark (YES side), + 2 NO-side orders.
  const restExpiry = (await chainNow()) + BigInt(60 * DAY)
  const bidLevels = [
    { deltaPct: -0.03, usdc: 500 },
    { deltaPct: -0.02, usdc: 1500 },
    { deltaPct: -0.01, usdc: 3000 },
  ]
  const askLevels = [
    { deltaPct: 0.01, yes: 500 },
    { deltaPct: 0.02, yes: 1500 },
    { deltaPct: 0.03, yes: 3000 },
  ]
  for (const { deltaPct, usdc } of bidLevels) {
    const price = finalMark + deltaPct
    const usdcAmt = u6(usdc)
    const yesAmt = BigInt(Math.round(Number(usdcAmt) / price))
    await postResting({ maker: B, side: 'bid', token: YES, tokenAmt: yesAmt, usdcAmt, expirySeconds: restExpiry })
  }
  for (const { deltaPct, yes } of askLevels) {
    const price = finalMark + deltaPct
    const yesAmt = u6(yes)
    const usdcAmt = BigInt(Math.round(Number(yesAmt) * price))
    await postResting({ maker: B, side: 'ask', token: YES, tokenAmt: yesAmt, usdcAmt, expirySeconds: restExpiry })
  }
  // A couple of NO-side resting orders for book realism (not matched).
  const noPrice = 1 - finalMark
  await postResting({ maker: B, side: 'bid', token: NO, tokenAmt: u6(1000 / noPrice), usdcAmt: u6(1000 * (noPrice - 0.02)), expirySeconds: restExpiry })
  await postResting({ maker: B, side: 'ask', token: NO, tokenAmt: u6(1000), usdcAmt: u6(1000 * (noPrice + 0.02)), expirySeconds: restExpiry })
  console.log('  B posted resting book: 3 YES bids, 3 YES asks, 2 NO orders (expiry +60 days)')

  // ── summary ───────────────────────────────────────────────────────────────────
  console.log('\n=== seed summary ===')
  for (const acc of [A, B, C, D]) {
    const bal = await balances(acc)
    console.log(`  ${acc.label.padEnd(28)} USDC=${fmt(bal.usdc).padStart(10)} YES=${fmt(bal.yes).padStart(10)} NO=${fmt(bal.no).padStart(10)}`)
  }
  console.log(`  currentMark = ${fmtMark(markWad)}`)
  console.log(`  D.claimable = ${dClaimable}`)
  console.log(`  C.isSeizable = ${cSeizable}  C.epochsToExpire = ${cEpochs}`)
  const book = await getOrderBook(ORDER_BOOK_URL)
  console.log(`  order book depth: ${book.bids.length} bids, ${book.asks.length} asks`)
  console.log(`  FundingAccrued events emitted by this script: ${eventCount}`)
  console.log('=== seed-demo.ts complete ===')
}

main().catch(err => {
  console.error('\n[seed-demo] FAILED:', err)
  process.exit(1)
})
