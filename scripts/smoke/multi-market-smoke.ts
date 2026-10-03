// End-to-end smoke for the Pari multi-market build-out, run against the THROWAWAY stack that
// multi-market-up.sh brings up (anvil :8549, redis :6392, services :3021-3024, registry mode,
// 3 markets: mstr / crwv / try). Prints PASS/FAIL per check and a final "N/M passed".
//
//   ./multi-market-up.sh && ./node_modules/.bin/tsx multi-market-smoke.ts ; ./multi-market-down.sh
//   (or just ./run-smoke.sh which does all three)
//
// Timeline (chain time is warped; every order's expiry is CHAIN time + 10y — wall-clock expiry
// would be stale after a warp, same reason TradePanel uses chain time):
//   day  0   setup: fund wallets, approvals, seed InsuranceFund. A (LP) mints sets in each market and
//            sells 1000 Upbet (YES) to D (#8, "distressed") — D then holds YES only, with the OLDEST
//            funding snapshot in every market (so only D crosses a lowered mark's seizure trigger).
//   day 30   checks 1-4 (listing, per-market trades, NO-buy fee, rejections)
//   day 31   check 5 (same user in two markets)
//   day 91   check 6 (crwv seizure + claim by the bot), 7 (mstr tail case, bot paused = downtime),
//            8 (try cure), 9 (try credit event; mstr/crwv keep going), 10 (legacy sweep), 11 (invariants)
// Services run in REGISTRY mode; the funding-keeper's REAL main() ticks every 4s (fast-cron.js).
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import Redis from 'ioredis'
import {
  createPublicClient, createTestClient, createWalletClient, defineChain, http, parseAbi, decodeEventLog,
  type Address, type Hex,
} from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { minGrossForNet, tradeFee } from '../../backend/order-book-server/src/fee'

// ─── env / clients ───────────────────────────────────────────────────────────

const SMOKE_DIR = path.dirname(path.resolve(process.argv[1]))
const ENV_PATH = process.env.SMOKE_ENV ?? path.join(SMOKE_DIR, '.run', 'env.json')
const env = JSON.parse(readFileSync(ENV_PATH, 'utf8')) as {
  rpcUrl: string; chainId: number; usdc: Address; registry: Address; insuranceFund: Address
  orderBookUrl: string; fundingHealthUrl: string; liqKeeperUrl: string; botHealthUrl: string; redisPort: number
}
const WAD = 10n ** 18n
const DAY = 86_400
const MNEMONIC = 'test test test test test test test test test test test junk'
const acct = (i: number) => mnemonicToAccount(MNEMONIC, { addressIndex: i })
const ADMIN = acct(0)      // deployer / admin / oracle attester / team wallet
const KEEPER = acct(1)     // funding-keeper
const BOT = acct(3)        // liquidator-bot
const A = acct(4)          // LP: mints sets, sells Upbet / Downbet
const B = acct(5)          // buys Upbet; user in several markets
const C = acct(6)          // buys Downbet (fee-paying side)
const X = acct(7)          // script liquidator (tail-case claim)
const D = acct(8)          // distressed Upbet holder in every market

const chain = defineChain({
  id: env.chainId, name: 'smoke-anvil', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [env.rpcUrl] } },
})
const transport = http(env.rpcUrl)
const pub = createPublicClient({ chain, transport, pollingInterval: 200 })
const testClient = createTestClient({ chain, mode: 'anvil', transport })
const wallets = new Map<string, ReturnType<typeof createWalletClient>>()
const walletFor = (a: ReturnType<typeof acct>) => {
  let w = wallets.get(a.address)
  if (!w) { w = createWalletClient({ account: a, chain, transport }); wallets.set(a.address, w) }
  return w
}

// ─── ABIs ────────────────────────────────────────────────────────────────────

const ERC20 = parseAbi([
  'function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)',
  'function approve(address,uint256) returns (bool)', 'function mint(address,uint256)',
])
const CM = parseAbi([
  'function mint(uint256)', 'function accrueFunding()', 'function currentMark() view returns (uint256)',
  'function owed(address) view returns (uint256)', 'function fundingDebt(address) view returns (uint256)',
  'function fundingSnapshot(address) view returns (uint256)', 'function snapNO(address) view returns (uint256)',
  'function claimable(address) view returns (bool)', 'function adminSetMark(uint256)', 'function cure()',
  'function settleYES(uint256)', 'function creditEventConfirmed() view returns (bool)', 'function paused() view returns (bool)',
  'function cumulativeFundingPerYES() view returns (uint256)',
  'event FundingAccrued(uint256 cumulativeFundingPerYES, uint256 cumFundingPerNO, uint256 timestamp)',
])
const CLOB = parseAbi([
  'function feeBps() view returns (uint256)', 'function insuranceShareBps() view returns (uint256)',
  'function teamWallet() view returns (address)', 'function insuranceFund() view returns (address)',
])
const LE = parseAbi([
  'function claim(address)',
  'event Liquidated(address indexed originalHolder, address indexed liquidator, uint256 yesAmount, uint256 pricePaid, bool tailCase)',
])
const IFUND = parseAbi(['function deposit(uint256)'])
const ROUTER = parseAbi(['function confirmCreditEvent()'])
const REGISTRY = parseAbi([
  'function allMarkets() view returns ((string slug,string entityName,uint8 entityType,address creditMarket,address yesToken,address noToken,address clobSettlement,address oracleRouter,address liquidationEngine,bool active,uint64 registeredAt,uint64 startBlock)[])',
])
const ORDER_TYPES = {
  Order: [
    { name: 'maker', type: 'address' }, { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'minAmountOut', type: 'uint256' },
    { name: 'expiry', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
  ],
} as const

// ─── helpers ─────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const lc = (s: string) => s.toLowerCase()
const eqAddr = (a: string, b: string) => lc(a) === lc(b)
const usd = (n: number) => BigInt(Math.round(n * 1e6))
const fmt = (x: bigint) => (Number(x) / 1e6).toFixed(4)

class AssertionFailed extends Error {}
function assert(cond: unknown, msg: string): asserts cond { if (!cond) throw new AssertionFailed(msg) }
function assertEq<T>(actual: T, expected: T, msg: string) {
  assert(actual === expected, `${msg}: expected ${String(expected)}, got ${String(actual)}`)
}

async function until<T>(fn: () => Promise<T | false | null | undefined>, label: string, timeoutMs = 60_000, intervalMs = 250): Promise<T> {
  const t0 = Date.now()
  let last: unknown
  while (Date.now() - t0 < timeoutMs) {
    try { const v = await fn(); if (v) return v as T } catch (e) { last = e }
    await sleep(intervalMs)
  }
  throw new AssertionFailed(`timed out after ${timeoutMs / 1000}s waiting for: ${label}${last ? ` (last error: ${String(last)})` : ''}`)
}

async function send(a: ReturnType<typeof acct>, address: Address, abi: any, functionName: string, args: readonly unknown[] = []) {
  const hash = await walletFor(a).writeContract({ address, abi, functionName, args: args as any, chain, account: a })
  const receipt = await pub.waitForTransactionReceipt({ hash, pollingInterval: 100 })
  if (receipt.status !== 'success') throw new Error(`tx reverted: ${functionName}(${args.join(',')}) from ${a.address} ${hash}`)
  return receipt
}
const read = <T = bigint>(address: Address, abi: any, functionName: string, args: readonly unknown[] = [], blockNumber?: bigint) =>
  pub.readContract({ address, abi, functionName, args: args as any, ...(blockNumber ? { blockNumber } : {}) }) as Promise<T>

const bal = (token: Address, who: string) => read<bigint>(token, ERC20, 'balanceOf', [who as Address])
const chainNow = async () => (await pub.getBlock()).timestamp
async function warp(days: number) {
  await testClient.increaseTime({ seconds: Math.round(days * DAY) })
  await testClient.mine({ blocks: 1 })
}

let nonceCounter = BigInt(Date.now()) * 1_000_000n
const nextNonce = () => ++nonceCounter

interface Mkt {
  slug: string; name: string; type: number
  cm: Address; yes: Address; no: Address; clob: Address; router: Address; le: Address
  /** reference Upbet price used for this market's trades (USDC per 1 Upbet) */
  p: number
}
const PRICE: Record<string, number> = { mstr: 0.20, crwv: 0.10, try: 0.03 }

async function loadMarkets(): Promise<Mkt[]> {
  const raw = await read<any[]>(env.registry, REGISTRY, 'allMarkets')
  return raw.map(m => ({
    slug: m.slug, name: m.entityName, type: m.entityType, cm: m.creditMarket, yes: m.yesToken, no: m.noToken,
    clob: m.clobSettlement, router: m.oracleRouter, le: m.liquidationEngine, p: PRICE[m.slug] ?? 0.1,
  }))
}

interface OrderIn { maker: Address; tokenIn: Address; tokenOut: Address; amountIn: bigint; minAmountOut: bigint; expiry: bigint; nonce: bigint }
/** Signs for `domainClob` (defaults to the market's own CLOB) — pass another market's CLOB to forge a cross-domain order. */
async function signOrder(maker: ReturnType<typeof acct>, o: OrderIn, domainClob: Address): Promise<Hex> {
  return maker.signTypedData({
    domain: { name: 'CLOBSettlement', version: '1', chainId: env.chainId, verifyingContract: domainClob },
    types: ORDER_TYPES, primaryType: 'Order', message: o,
  })
}
const wire = (o: OrderIn, signature: Hex) => ({
  maker: o.maker, tokenIn: o.tokenIn, tokenOut: o.tokenOut, amountIn: o.amountIn.toString(),
  minAmountOut: o.minAmountOut.toString(), expiry: o.expiry.toString(), nonce: o.nonce.toString(), signature,
})
async function post(body: object): Promise<{ status: number; json: any }> {
  const res = await fetch(`${env.orderBookUrl}/order`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => ({})) }
}
async function newOrder(maker: ReturnType<typeof acct>, tokenIn: Address, tokenOut: Address, amountIn: bigint, minAmountOut: bigint, domainClob: Address) {
  const o: OrderIn = { maker: maker.address, tokenIn, tokenOut, amountIn, minAmountOut, expiry: (await chainNow()) + BigInt(3650 * DAY), nonce: nextNonce() }
  return { o, w: wire(o, await signOrder(maker, o, domainClob)) }
}
async function getBook(slug?: string): Promise<{ bids: any[]; asks: any[] }> {
  const res = await fetch(`${env.orderBookUrl}/orderbook${slug === undefined ? '' : `?market=${slug}`}`)
  assertEq(res.status, 200, `GET /orderbook${slug ? '?market=' + slug : ''} status`)
  return res.json() as any
}
async function getJson(url: string): Promise<{ status: number; json: any }> {
  const res = await fetch(url)
  return { status: res.status, json: await res.json().catch(() => null) }
}

interface TradeResult { pre: Record<string, bigint>; post: Record<string, bigint>; gross: bigint; fee: bigint }
/**
 * Seller rests an ask via POST /order, buyer posts the crossing bid; waits for the matching-engine to
 * settle on-chain (buyer's token balance rises by Q). 'yes' = Upbet (fee-free for buyer), 'no' = Downbet
 * (buyer signs GROSS = minGrossForNet(net), fee-paying side). Returns pre/post balances for assertions.
 */
async function trade(m: Mkt, kind: 'yes' | 'no', seller: ReturnType<typeof acct>, buyer: ReturnType<typeof acct>, Q: bigint, netPrice: bigint): Promise<TradeResult> {
  const token = kind === 'yes' ? m.yes : m.no
  const feeBps = await read<bigint>(m.clob, CLOB, 'feeBps')
  const gross = kind === 'no' ? minGrossForNet(netPrice, Q, feeBps) : netPrice
  const fee = tradeFee(Q, gross, feeBps)
  const snap = async () => ({
    buyerTok: await bal(token, buyer.address), sellerTok: await bal(token, seller.address),
    buyerUsdc: await bal(env.usdc, buyer.address), sellerUsdc: await bal(env.usdc, seller.address),
    insurance: await bal(env.usdc, env.insuranceFund), team: await bal(env.usdc, ADMIN.address),
  })
  const pre = await snap()
  const ask = await newOrder(seller, token, env.usdc, Q, netPrice, m.clob)
  const bid = await newOrder(buyer, env.usdc, token, gross, Q, m.clob)
  const r1 = await post(ask.w); assertEq(r1.status, 201, `[${m.slug}] ask POST /order ${JSON.stringify(r1.json)}`)
  assertEq(r1.json.market, m.slug, `[${m.slug}] ask routed to market`)
  const r2 = await post(bid.w); assertEq(r2.status, 201, `[${m.slug}] bid POST /order ${JSON.stringify(r2.json)}`)
  assertEq(r2.json.market, m.slug, `[${m.slug}] bid routed to market`)
  await until(async () => (await bal(token, buyer.address)) === pre.buyerTok + Q, `[${m.slug}] ${kind} trade to settle on-chain`, 45_000)
  const post_ = await snap()
  return { pre: pre as any, post: post_ as any, gross, fee }
}

// ─── checks harness ──────────────────────────────────────────────────────────

const results: Array<{ n: number; name: string; ok: boolean; detail: string }> = []
async function check(n: number, name: string, fn: () => Promise<string | void>) {
  const t0 = Date.now()
  try {
    const detail = (await fn()) ?? ''
    results.push({ n, name, ok: true, detail })
    console.log(`PASS  ${String(n).padStart(2)}. ${name}${detail ? `  — ${detail}` : ''}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    results.push({ n, name, ok: false, detail: msg })
    console.log(`FAIL  ${String(n).padStart(2)}. ${name}  — ${msg}  [${((Date.now() - t0) / 1000).toFixed(1)}s]`)
  }
}
function svc(cmd: 'pause' | 'resume', name: string) {
  execFileSync(path.join(SMOKE_DIR, 'svc.sh'), [cmd, name], { stdio: 'inherit' })
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const markets = await loadMarkets()
  const mstr = markets.find(m => m.slug === 'mstr')!, crwv = markets.find(m => m.slug === 'crwv')!, tr = markets.find(m => m.slug === 'try')!
  assert(mstr && crwv && tr, 'registry must hold mstr, crwv, try')
  const registrySnapshot = JSON.stringify(await read<any[]>(env.registry, REGISTRY, 'allMarkets'), (_k, v) => typeof v === 'bigint' ? v.toString() : v)
  console.log(`markets: ${markets.map(m => `${m.slug}@${m.cm}`).join(' ')}`)

  // ── setup (not counted): fund, approve, seed the shared InsuranceFund, D's early Upbet position ──
  console.log('== setup')
  const MAXU = 2n ** 256n - 1n
  for (const [a, amt] of [[A, 100_000], [B, 100_000], [C, 50_000], [X, 50_000], [D, 50_000], [BOT, 20_000], [ADMIN, 10_000]] as const) {
    await send(ADMIN, env.usdc, ERC20, 'mint', [a.address, usd(amt)])
  }
  for (const a of [A, B, C, X, D]) {
    for (const m of markets) {
      await send(a, env.usdc, ERC20, 'approve', [m.cm, MAXU])
      await send(a, env.usdc, ERC20, 'approve', [m.clob, MAXU])
      await send(a, m.yes, ERC20, 'approve', [m.clob, MAXU])
      await send(a, m.no, ERC20, 'approve', [m.clob, MAXU])
    }
  }
  await send(ADMIN, env.usdc, ERC20, 'approve', [env.insuranceFund, MAXU])
  await send(ADMIN, env.insuranceFund, IFUND, 'deposit', [usd(5_000)])
  const ifSeed = await bal(env.usdc, env.insuranceFund)
  console.log(`   InsuranceFund seeded: ${fmt(ifSeed)} USDC`)
  const Q_D = usd(1000)
  for (const m of markets) {
    await send(A, m.cm, CM, 'mint', [usd(3000)])
    await trade(m, 'yes', A, D, Q_D, BigInt(Math.round(m.p * Number(Q_D))))
    assertEq(await bal(m.yes, D.address), Q_D, `[${m.slug}] D holds Upbet`)
  }
  await warp(30)
  console.log('   D (anvil #8) holds 1000 Upbet in every market; warped +30d')

  // ── 1. listing + service registry modes ────────────────────────────────────
  await check(1, 'GET /markets lists mstr/crwv/try; every keeper /health is registry mode with all 3 markets', async () => {
    const { status, json } = await getJson(`${env.orderBookUrl}/markets`)
    assertEq(status, 200, 'GET /markets status')
    assertEq(json.mode, 'registry', '/markets mode')
    const want: Record<string, [string, string]> = { mstr: ['MicroStrategy', 'corporate'], crwv: ['CoreWeave', 'corporate'], try: ['Turkey', 'sovereign'] }
    assertEq(json.markets.length, 3, '/markets count')
    for (const [slug, [name, type]] of Object.entries(want)) {
      const row = json.markets.find((x: any) => x.slug === slug)
      assert(row, `/markets missing ${slug}`)
      assertEq(row.entityName, name, `${slug}.entityName`); assertEq(row.entityType, type, `${slug}.entityType`)
      const reg = markets.find(m => m.slug === slug)!
      assert(eqAddr(row.creditMarket, reg.cm) && eqAddr(row.clobSettlement, reg.clob), `${slug} addresses match the registry`)
    }
    for (const [label, url] of [['funding-keeper', env.fundingHealthUrl], ['liquidation-keeper', env.liqKeeperUrl], ['liquidator-bot', env.botHealthUrl]] as const) {
      const h = await getJson(`${url}/health`)
      assertEq(h.status, 200, `${label} /health status`)
      assertEq(h.json.registry?.mode, 'registry', `${label} registry.mode`)
      assertEq(h.json.registry?.marketCount, 3, `${label} registry.marketCount`)
      for (const slug of Object.keys(want)) assert(h.json.markets?.[slug], `${label} /health.markets missing ${slug}`)
    }
    return 'order-book + 3 keepers: registry mode, 3 markets'
  })

  // ── 2. per-market trade isolation ───────────────────────────────────────────
  await check(2, 'per market: A mints + rests Upbet ask, B crosses; settles in THAT market only', async () => {
    const out: string[] = []
    for (const m of markets) {
      const others = markets.filter(o => o !== m)
      const tokSnap = async () => {
        const o: Record<string, bigint> = {}
        for (const x of others) for (const [who, a] of [['A', A], ['B', B]] as const) {
          o[`${who}.yes.${x.slug}`] = await bal(x.yes, a.address); o[`${who}.no.${x.slug}`] = await bal(x.no, a.address)
        }
        return o
      }
      const cmUsdc = async () => Object.fromEntries(await Promise.all(markets.map(async x => [x.slug, await bal(env.usdc, x.cm)] as const)))
      const aYesPre = await bal(m.yes, A.address), aNoPre = await bal(m.no, A.address)
      const bYesPre = await bal(m.yes, B.address)
      await send(A, m.cm, CM, 'mint', [usd(2000)])
      const cmAfterMint = await cmUsdc()     // mint moved USDC into THIS market only
      const tokPre = await tokSnap()
      const Q = usd(500), P = BigInt(Math.round(m.p * Number(Q)))
      const t = await trade(m, 'yes', A, B, Q, P)
      assertEq((await bal(m.yes, B.address)) - bYesPre, Q, `[${m.slug}] B Upbet delta`)
      assertEq(t.pre.buyerUsdc - t.post.buyerUsdc, P, `[${m.slug}] B paid exactly the price`)
      assertEq(aYesPre + usd(2000) - (await bal(m.yes, A.address)), Q, `[${m.slug}] A Upbet delta`)
      assertEq((await bal(m.no, A.address)) - aNoPre, usd(2000), `[${m.slug}] A Downbet only changed by the mint`)
      // YES seller pays the fee: 50/50 InsuranceFund / team (fee-paying side = carry-earning seller)
      const fee = tradeFee(Q, P, await read<bigint>(m.clob, CLOB, 'feeBps'))
      assertEq(t.post.insurance - t.pre.insurance, fee / 2n, `[${m.slug}] InsuranceFund got half the Upbet-sale fee`)
      assertEq(t.post.team - t.pre.team, fee - fee / 2n, `[${m.slug}] team wallet got the other half`)
      const tokPost = await tokSnap(), cmPost = await cmUsdc()
      for (const k of Object.keys(tokPre)) assertEq(tokPost[k], tokPre[k], `[${m.slug}] ${k} must not move`)
      for (const x of others) assertEq(cmPost[x.slug], cmAfterMint[x.slug], `[${x.slug}] CreditMarket USDC unchanged by a ${m.slug} trade`)
      out.push(`${m.slug}:${fmt(Q)}@${fmt(P)}`)
    }
    return out.join('  ')
  })

  // ── 3. Downbet buy with the live fee ─────────────────────────────────────────
  await check(3, 'Downbet (NO) buy: GROSS amountIn, fee 50/50 -> shared InsuranceFund + team wallet, in two markets', async () => {
    const ifs = new Set<string>()
    let ifTotal = 0n, teamTotal = 0n
    for (const m of [mstr, crwv]) {
      ifs.add(lc(await read<string>(m.clob, CLOB, 'insuranceFund')))
      assertEq(await read<bigint>(m.clob, CLOB, 'feeBps'), 50n, `[${m.slug}] feeBps`)
      assertEq(await read<bigint>(m.clob, CLOB, 'insuranceShareBps'), 5000n, `[${m.slug}] insuranceShareBps`)
      assert(eqAddr(await read<string>(m.clob, CLOB, 'teamWallet'), ADMIN.address), `[${m.slug}] teamWallet = admin`)
      const Q = usd(500), net = BigInt(Math.round((1 - m.p) * Number(Q)))
      const t = await trade(m, 'no', A, C, Q, net)
      assert(t.fee > 0n, `[${m.slug}] fee must be live (>0)`)
      assertEq(t.gross, minGrossForNet(net, Q, 50n), `[${m.slug}] buyer signed GROSS`)
      assertEq(t.pre.buyerUsdc - t.post.buyerUsdc, t.gross, `[${m.slug}] buyer paid exactly the signed gross`)
      assertEq(t.post.insurance - t.pre.insurance, t.fee / 2n, `[${m.slug}] InsuranceFund += fee/2`)
      assertEq(t.post.team - t.pre.team, t.fee - t.fee / 2n, `[${m.slug}] team += fee - fee/2`)
      ifTotal += t.post.insurance - t.pre.insurance; teamTotal += t.post.team - t.pre.team
    }
    assertEq(ifs.size, 1, 'both markets route fees to ONE InsuranceFund')
    assert(ifs.has(lc(env.insuranceFund)), 'that fund is the registry\'s shared InsuranceFund')
    assert(ifTotal > 0n && teamTotal > 0n, 'IF and team both received fees from both markets')
    return `IF +${fmt(ifTotal)} / team +${fmt(teamTotal)} USDC across mstr+crwv`
  })

  // ── 4. cross-market rejections ───────────────────────────────────────────────
  await check(4, 'cross-market rejections; unknown market 404; bare /orderbook == mstr', async () => {
    // (a) crwv Upbet order signed for mstr's CLOB domain
    const forged = await newOrder(B, env.usdc, crwv.yes, usd(1), usd(10), mstr.clob)
    const a = await post(forged.w)
    assertEq(a.status, 400, 'forged cross-domain order status')
    assert(['InvalidTokenPair', 'Invalid signature'].includes(a.json.error), `forged cross-domain error was ${a.json.error}`)
    // (b) tokenIn = a CreditMarket address
    const cmOrder = await newOrder(B, mstr.cm, env.usdc, usd(1), usd(1), mstr.clob)
    const b = await post(cmOrder.w)
    assertEq(b.status, 400, 'CreditMarket-as-token status'); assertEq(b.json.error, 'InvalidTokenPair', 'CreditMarket-as-token error')
    // (c) both legs USDC / unknown token
    const unk = await newOrder(B, env.usdc, '0x000000000000000000000000000000000000dEaD', usd(1), usd(1), mstr.clob)
    const u = await post(unk.w)
    assertEq(u.status, 400, 'unknown token status'); assertEq(u.json.error, 'UnknownMarket', 'unknown token error')
    // (d) book routing: one resting low bid in mstr and one in crwv (never crosses anything)
    const bidM = await newOrder(B, env.usdc, mstr.yes, usd(2), usd(1000), mstr.clob)
    const bidC = await newOrder(B, env.usdc, crwv.yes, usd(1), usd(300), crwv.clob)
    const rm = await post(bidM.w), rc = await post(bidC.w)
    assertEq(rm.status, 201, 'mstr resting bid'); assertEq(rc.status, 201, 'crwv resting bid')
    assertEq(rm.json.market, 'mstr', 'bid routed to mstr'); assertEq(rc.json.market, 'crwv', 'bid routed to crwv')
    const nope = await fetch(`${env.orderBookUrl}/orderbook?market=nope`)
    assertEq(nope.status, 404, 'GET /orderbook?market=nope')
    const bare = await getBook(), bm = await getBook('mstr'), bc = await getBook('crwv'), bt = await getBook('try')
    assertEq(JSON.stringify(bare), JSON.stringify(bm), 'bare /orderbook equals mstr book')
    assertEq(bm.bids.length, 1, 'mstr book has exactly its own bid'); assertEq(bm.bids[0].id, rm.json.orderId, 'mstr bid id')
    assertEq(bc.bids.length, 1, 'crwv book has exactly its own bid'); assertEq(bc.bids[0].id, rc.json.orderId, 'crwv bid id')
    assertEq(bt.bids.length + bt.asks.length, 0, 'try book empty')
    assert(bm.bids[0].id !== bc.bids[0].id, 'books are distinct')
    // cancel both (DELETE /order/:id verifies against the stored order's market domain)
    for (const [slug, id, m, sigDomain] of [['mstr', rm.json.orderId, mstr, mstr.clob], ['crwv', rc.json.orderId, crwv, crwv.clob]] as const) {
      const sig = await B.signTypedData({
        domain: { name: 'CLOBSettlement', version: '1', chainId: env.chainId, verifyingContract: sigDomain },
        types: { CancelOrder: [{ name: 'orderId', type: 'string' }] }, primaryType: 'CancelOrder', message: { orderId: id },
      })
      const res = await fetch(`${env.orderBookUrl}/order/${id}`, { method: 'DELETE', headers: { 'x-maker': B.address, 'x-signature': sig } })
      assertEq(res.status, 200, `cancel ${slug} bid`)
    }
    const after = await getBook(); assertEq(after.bids.length, 0, 'mstr book empty after cancel')
    return `forged:${a.json.error}  cm-as-token:${b.json.error}  unknown-token:${u.json.error}  market=nope:404`
  })

  // ── 5. same user, two markets ────────────────────────────────────────────────
  await check(5, 'B holds Upbet in several markets: a trade in crwv leaves mstr/try fundingDebt + snapshots unchanged', async () => {
    await warp(1)
    // second buy in mstr after a day => B's accrued Upbet funding lands in fundingDebt (a buyer's debit persists in the ledger)
    await trade(mstr, 'yes', A, B, usd(100), usd(100 * mstr.p))
    const state = async (m: Mkt) => ({
      debt: await read<bigint>(m.cm, CM, 'fundingDebt', [B.address]), snap: await read<bigint>(m.cm, CM, 'fundingSnapshot', [B.address]),
      snapNO: await read<bigint>(m.cm, CM, 'snapNO', [B.address]), yes: await bal(m.yes, B.address),
    })
    const mPre = await state(mstr), tPre = await state(tr), cPre = await state(crwv)
    assert(mPre.debt > 0n, `B has a non-zero fundingDebt in mstr to protect (got ${mPre.debt})`)
    assert(mPre.yes > 0n && cPre.yes > 0n && tPre.yes > 0n, 'B holds Upbet in all three markets')
    await trade(crwv, 'yes', A, B, usd(100), usd(100 * crwv.p))
    const mPost = await state(mstr), tPost = await state(tr), cPost = await state(crwv)
    assertEq(JSON.stringify(mPost, (_k, v) => String(v)), JSON.stringify(mPre, (_k, v) => String(v)), 'B mstr ledger/snapshots unchanged by a crwv trade')
    assertEq(JSON.stringify(tPost, (_k, v) => String(v)), JSON.stringify(tPre, (_k, v) => String(v)), 'B try ledger/snapshots unchanged by a crwv trade')
    assert(cPost.snap > cPre.snap && cPost.debt > 0n, 'control: B\'s crwv snapshot did advance and its debit was recorded')
    assertEq(cPost.yes - cPre.yes, usd(100), 'B crwv Upbet +100')
    return `mstr debt ${fmt(mPre.debt)} + try untouched; crwv snapshot ${cPre.snap} -> ${cPost.snap}`
  })

  // Distress helper: lower a market's mark to 1% above D's accrued funding-per-unit f (=> m <= 1.03*f_next, seizable)
  const distress = async (m: Mkt) => {
    const Q = await bal(m.yes, D.address)
    const f = (await read<bigint>(m.cm, CM, 'owed', [D.address])) * WAD / Q
    const newMark = f * 101n / 100n
    await send(ADMIN, m.cm, CM, 'adminSetMark', [newMark])
    return { Q, newMark, f }
  }

  await warp(60)    // chain day ~91: D's funding (oldest snapshot) is large relative to everyone else's
  const supplies = async (m: Mkt) => ({ yes: await read<bigint>(m.yes, ERC20, 'totalSupply'), no: await read<bigint>(m.no, ERC20, 'totalSupply') })

  // ── 6. seizure + claim in crwv by the bot ────────────────────────────────────
  await check(6, 'crwv: D seizable -> funding-keeper flags -> /claimable?market=crwv -> liquidator-bot claims; YES transferred, complete set holds', async () => {
    const supPre = await supplies(crwv)
    assertEq(supPre.yes, supPre.no, 'crwv complete-set pre')
    svc('pause', 'liquidator-bot')       // so the keeper's /claimable listing can be observed before the bot claims
    let resumed = false
    try {
      const { Q, newMark } = await distress(crwv)
      await until(async () => read<boolean>(crwv.cm, CM, 'claimable', [D.address]), 'funding-keeper flags D in crwv', 45_000)
      const pos = await until(async () => {
        const r = await getJson(`${env.liqKeeperUrl}/claimable?market=crwv`)
        return r.status === 200 ? (r.json as any[]).find(p => eqAddr(p.user, D.address)) : null
      }, 'liquidation-keeper lists D under /claimable?market=crwv', 30_000)
      assertEq(pos.market, 'crwv', 'position.market'); assert(eqAddr(pos.creditMarket, crwv.cm), 'position.creditMarket')
      assert(eqAddr(pos.liquidationEngine, crwv.le), 'position.liquidationEngine'); assertEq(pos.notional, Q.toString(), 'position.notional')
      assertEq(pos.tailCase, false, 'normal (not tail) case')
      assert(BigInt(pos.owed) <= BigInt(pos.tokenValue), 'owed <= m*Q')
      const otherMarkets = (await getJson(`${env.liqKeeperUrl}/claimable?market=mstr`)).json as any[]
      assert(!otherMarkets.some(p => eqAddr(p.user, D.address)), 'D is NOT listed under mstr')
      assertEq((await getJson(`${env.liqKeeperUrl}/claimable?market=nope`)).status, 404, '/claimable?market=nope')
      const all = (await getJson(`${env.liqKeeperUrl}/claimable`)).json as any[]
      assert(all.some(p => p.market === 'crwv' && eqAddr(p.user, D.address)), 'unfiltered /claimable includes the crwv position')
      const botYesPre = await bal(crwv.yes, BOT.address)
      svc('resume', 'liquidator-bot'); resumed = true
      await until(async () => (await bal(crwv.yes, D.address)) === 0n, 'bot claims D\'s crwv position', 60_000)
      const logs = await pub.getLogs({ address: crwv.le, event: LE[1] as any, fromBlock: 0n })
      const ev = logs.map(l => decodeEventLog({ abi: LE, data: l.data, topics: l.topics as any }) as any)
        .find(e => e.eventName === 'Liquidated' && eqAddr(e.args.originalHolder, D.address))
      assert(ev, 'Liquidated event on crwv LiquidationEngine')
      assert(eqAddr(ev.args.liquidator, BOT.address), `claimer is the bot (got ${ev.args.liquidator})`)
      assertEq(ev.args.yesAmount, Q, 'Liquidated.yesAmount'); assertEq(ev.args.tailCase, false, 'Liquidated.tailCase')
      assert(ev.args.pricePaid > 0n && ev.args.pricePaid <= Q * newMark / WAD, 'pricePaid = owed <= m*Q')
      const supPost = await supplies(crwv)
      assertEq(supPost.yes, supPre.yes, 'YES supply unchanged (transferred, never burned)'); assertEq(supPost.no, supPre.no, 'NO supply unchanged')
      assertEq(supPost.yes, supPost.no, 'crwv complete-set invariant after claim')
      assertEq(await read<boolean>(crwv.cm, CM, 'claimable', [D.address]), false, 'flag cleared after claim')
      // the bot either holds the seized Upbet or has already re-listed it on crwv's book
      const resting = await until(async () => (await getBook('crwv')).asks.find(o => eqAddr(o.maker, BOT.address)), 'bot re-lists the seized Upbet on crwv\'s book', 30_000)
      assertEq(resting.market, 'crwv', 'bot ask is in the crwv book')
      assertEq(resting.tokenIn.toLowerCase(), crwv.yes.toLowerCase(), 'bot ask sells crwv Upbet')
      const botYes = await bal(crwv.yes, BOT.address)
      assertEq(botYes - botYesPre, Q, 'bot received the seized Upbet (transfer)')
      return `Q=${fmt(Q)} P=${fmt(ev.args.pricePaid)} mark->${(Number(newMark) / 1e16).toFixed(3)}%  bot re-listed on crwv`
    } finally {
      if (!resumed) svc('resume', 'liquidator-bot')
    }
  })

  // ── 7. tail case in mstr (bot "down") ─────────────────────────────────────────
  await check(7, 'mstr tail case: flagged position stalls (bot paused) until owed > m*Q; claim -> IF tops up mstr only', async () => {
    svc('pause', 'liquidator-bot')       // keeper downtime: nobody claims for days
    const { Q, newMark } = await distress(mstr)
    await until(async () => read<boolean>(mstr.cm, CM, 'claimable', [D.address]), 'funding-keeper flags D in mstr', 45_000)
    const owed0 = await read<bigint>(mstr.cm, CM, 'owed', [D.address])
    assert(owed0 <= Q * newMark / WAD, 'initially a normal-case position (owed <= m*Q)')
    await warp(6)                        // margin (~1% of m*Q) shrinks 0.27%/day => tail after ~4 days
    const owedNow = await read<bigint>(mstr.cm, CM, 'owed', [D.address])
    const value = Q * newMark / WAD
    assert(owedNow > value, `stalled into the tail case: owed ${owedNow} > m*Q ${value}`)
    assertEq(await read<boolean>(mstr.cm, CM, 'claimable', [D.address]), true, 'still flagged (nobody claimed)')
    const supPre = await supplies(mstr)
    const pre = {
      ifBal: await bal(env.usdc, env.insuranceFund), mstr: await bal(env.usdc, mstr.cm),
      crwv: await bal(env.usdc, crwv.cm), try: await bal(env.usdc, tr.cm), xYes: await bal(mstr.yes, X.address),
    }
    await send(X, env.usdc, ERC20, 'approve', [mstr.le, 2n ** 256n - 1n])
    const receipt = await send(X, mstr.le, LE, 'claim', [D.address])
    const ev = receipt.logs.map(l => { try { return decodeEventLog({ abi: LE, data: l.data, topics: l.topics as any }) as any } catch { return null } })
      .find(e => e?.eventName === 'Liquidated')
    assert(ev, 'Liquidated event'); assertEq(ev.args.tailCase, true, 'tailCase')
    assertEq(ev.args.pricePaid, value, 'liquidator pays P = m*Q (full token value)')
    const post = {
      ifBal: await bal(env.usdc, env.insuranceFund), mstr: await bal(env.usdc, mstr.cm),
      crwv: await bal(env.usdc, crwv.cm), try: await bal(env.usdc, tr.cm), xYes: await bal(mstr.yes, X.address),
    }
    const shortfall = pre.ifBal - post.ifBal
    assert(shortfall > 0n, 'InsuranceFund paid a shortfall')
    const expected = owedNow - value
    assert(shortfall >= expected - 1000n && shortfall <= expected + 100_000n, `IF shortfall ${shortfall} ~ owed-m*Q ${expected}`)
    assertEq(post.mstr - pre.mstr, value + shortfall, 'mstr collateral += P + IF top-up (= owed; NO made whole)')
    assertEq(post.crwv, pre.crwv, 'crwv CreditMarket USDC unchanged'); assertEq(post.try, pre.try, 'try CreditMarket USDC unchanged')
    assertEq(post.xYes - pre.xYes, Q, 'claimer received the YES (transfer)'); assertEq(await bal(mstr.yes, D.address), 0n, 'D\'s YES gone')
    const supPost = await supplies(mstr)
    assertEq(supPost.yes, supPre.yes, 'mstr YES supply unchanged (never burned)'); assertEq(supPost.yes, supPost.no, 'mstr complete set holds')
    assertEq(await read<boolean>(mstr.cm, CM, 'claimable', [D.address]), false, 'flag cleared')
    return `P=${fmt(value)} IF top-up=${fmt(shortfall)} (owed ${fmt(owedNow)} > m*Q); crwv/try collateral untouched`
  })

  // ── 8. cure in try ────────────────────────────────────────────────────────────
  await check(8, 'try: flagged holder approves + cure(); flag clears; keeps the YES', async () => {
    const { Q } = await distress(tr)
    await until(async () => read<boolean>(tr.cm, CM, 'claimable', [D.address]), 'funding-keeper flags D in try', 45_000)
    const owedPre = await read<bigint>(tr.cm, CM, 'owed', [D.address])
    assert(owedPre > 0n, 'D owes funding')
    const usdcPre = await bal(env.usdc, D.address), cmPre = await bal(env.usdc, tr.cm)
    await send(D, env.usdc, ERC20, 'approve', [tr.cm, 2n ** 256n - 1n])
    await send(D, tr.cm, CM, 'cure')
    assertEq(await read<boolean>(tr.cm, CM, 'claimable', [D.address]), false, 'flag cleared by cure()')
    assertEq(await bal(tr.yes, D.address), Q, 'D kept the YES')
    const paid = usdcPre - (await bal(env.usdc, D.address))
    assert(paid >= owedPre && paid <= owedPre + 100_000n, `cure paid ~ owed (${paid} vs ${owedPre})`)
    assertEq((await bal(env.usdc, tr.cm)) - cmPre, paid, 'cure cash landed in try collateral')
    assertEq(await read<bigint>(tr.cm, CM, 'fundingDebt', [D.address]), 0n, 'fundingDebt cleared')
    // not re-flagged by the keeper (snapshot reset => no longer seizable): give it a few cycles
    await sleep(9_000)
    assertEq(await read<boolean>(tr.cm, CM, 'claimable', [D.address]), false, 'not re-flagged after cure')
    return `paid ${fmt(paid)} USDC (owed ${fmt(owedPre)}); Q=${fmt(Q)} kept`
  })
  svc('resume', 'liquidator-bot')

  // ── 9. credit event in try; mstr + crwv unaffected ───────────────────────────
  await check(9, 'try credit event: confirmCreditEvent -> settleYES pays 1 USDC/YES; mstr + crwv keep trading and accruing', async () => {
    const eventBlock = await pub.getBlockNumber()
    await send(ADMIN, tr.router, ROUTER, 'confirmCreditEvent')
    assertEq(await read<boolean>(tr.cm, CM, 'creditEventConfirmed'), true, 'try creditEventConfirmed')
    assertEq(await read<boolean>(tr.cm, CM, 'paused'), true, 'try paused after the event')
    const Q = await bal(tr.yes, D.address)
    assert(Q > 0n, 'D holds YES to settle')
    const supPre = await supplies(tr), usdcPre = await bal(env.usdc, D.address)
    await send(D, tr.cm, CM, 'settleYES', [Q])
    const got = (await bal(env.usdc, D.address)) - usdcPre
    assert(got <= Q && got >= Q - 200_000n, `settleYES paid ~1 USDC per YES net of seconds of funding (got ${fmt(got)} for ${fmt(Q)})`)
    assertEq(await bal(tr.yes, D.address), 0n, 'YES burned for D')
    assertEq(supPre.yes - (await supplies(tr)).yes, Q, 'try YES supply fell by Q (burned at settlement)')
    // mstr + crwv keep trading: one more matched Downbet trade each (the bot's crwv Upbet ask is wall-clock-expiring; stay on the NO side)
    for (const m of [mstr, crwv]) {
      const Qn = usd(100), net = BigInt(Math.round((1 - m.p) * Number(Qn)))
      const noPre = await bal(m.no, C.address)
      await trade(m, 'no', A, C, Qn, net)
      assertEq((await bal(m.no, C.address)) - noPre, Qn, `[${m.slug}] post-event trade settled`)
    }
    // keepers keep accruing: funding-keeper txs (from the keeper wallet) on mstr and crwv after the event block
    await sleep(9_000)
    for (const m of [mstr, crwv]) {
      const logs = await pub.getLogs({ address: m.cm, event: CM[CM.length - 1] as any, fromBlock: eventBlock + 1n })
      let keeperAccruals = 0
      for (const l of logs) { const tx = await pub.getTransaction({ hash: l.transactionHash! }); if (eqAddr(tx.from, KEEPER.address)) keeperAccruals++ }
      assert(keeperAccruals >= 1, `[${m.slug}] funding-keeper accrued after the credit event (saw ${keeperAccruals})`)
    }
    const h = (await getJson(`${env.fundingHealthUrl}/health`)).json
    assert(Date.now() - Date.parse(h.lastRunAt) < 30_000, `funding-keeper lastRunAt is fresh (${h.lastRunAt})`)
    for (const s of ['mstr', 'crwv']) assert(Date.now() - Date.parse(h.markets[s].lastRunAt) < 30_000, `funding-keeper ${s} lastRunAt fresh`)
    return `settleYES paid ${fmt(got)} for ${fmt(Q)} YES; post-event NO trades in mstr+crwv settled; keeper still accruing`
  })

  // ── 10. legacy-key sweep ──────────────────────────────────────────────────────
  await check(10, 'legacy redis keys (orderbook:bids, nonces:<maker>) are swept into mstr namespaces within LEGACY_SWEEP_MS', async () => {
    const redis = new Redis({ host: '127.0.0.1', port: env.redisPort })
    try {
      const o = await newOrder(B, env.usdc, mstr.yes, usd(2), usd(1000), mstr.clob)   // price 0.002, never crosses
      const id = `legacy-smoke-${Date.now()}`
      const stored = { ...o.w, id, side: 'bid', price: Number(o.o.amountIn) / Number(o.o.minAmountOut), timestamp: Date.now() }   // NOTE: no `market` field, like a pre-multi-market order
      const maker = lc(B.address), nonce = o.o.nonce.toString()
      await redis.set(`orders:${id}`, JSON.stringify(stored))
      await redis.zadd('orderbook:bids', stored.price, id)
      await redis.sadd(`nonces:${maker}`, nonce)
      const t0 = Date.now()
      const swept = await until(async () => (await getBook('mstr')).bids.find(b => b.id === id), 'swept order to appear in GET /orderbook?market=mstr', 15_000, 200)
      const orderMs = Date.now() - t0
      assertEq(swept.market, 'mstr', 'sweep stamped market=mstr on the order JSON')
      assertEq(await redis.zscore('orderbook:bids', id), null, 'legacy orderbook:bids no longer holds the id')
      assert((await getBook('crwv')).bids.every(b => b.id !== id), 'not in crwv book')
      // nonce SCAN runs on boot and every 10th tick by design (docs: backend/CLAUDE.md) => allow 10 ticks + slack
      await until(async () => (await redis.sismember(`nonces:mstr:${maker}`, nonce)) === 1, 'nonce merged into nonces:mstr:<maker>', 45_000, 500)
      const nonceMs = Date.now() - t0
      assertEq(await redis.sismember(`nonces:${maker}`, nonce), 0, 'nonce removed from the legacy set')
      // cleanup
      await redis.zrem('orderbook:mstr:bids', id); await redis.del(`orders:${id}`); await redis.srem(`nonces:mstr:${maker}`, nonce)
      return `order visible after ${orderMs}ms, nonce merged after ${nonceMs}ms (LEGACY_SWEEP_MS=2000; nonce scan every 10th tick)`
    } finally { redis.disconnect() }
  })

  // ── 11. invariants ────────────────────────────────────────────────────────────
  await check(11, 'invariants: YES==NO supply (pre-event markets), CLOB holds no USDC, registry unchanged', async () => {
    for (const m of [mstr, crwv]) { const s = await supplies(m); assertEq(s.yes, s.no, `[${m.slug}] YES.totalSupply == NO.totalSupply`) }
    for (const m of markets) assertEq(await bal(env.usdc, m.clob), 0n, `[${m.slug}] CLOBSettlement USDC balance`)
    for (const m of markets) {
      assertEq(await bal(m.yes, m.clob), 0n, `[${m.slug}] CLOB holds no YES`); assertEq(await bal(m.no, m.clob), 0n, `[${m.slug}] CLOB holds no NO`)
    }
    const registryNow = JSON.stringify(await read<any[]>(env.registry, REGISTRY, 'allMarkets'), (_k, v) => typeof v === 'bigint' ? v.toString() : v)
    assertEq(registryNow, registrySnapshot, 'registry entries unchanged')
    const j = (await getJson(`${env.orderBookUrl}/markets`)).json
    assertEq(j.markets.length, 3, '/markets still lists 3'); assert(j.markets.every((x: any) => x.active), 'all still active')
    const s = await supplies(tr)
    return `try post-event supply YES ${fmt(s.yes)} / NO ${fmt(s.no)} (YES burned at settlement, as designed)`
  })

  const passed = results.filter(r => r.ok).length
  console.log(`\n${passed}/${results.length} passed`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch(e => { console.error('SMOKE SETUP/RUNTIME ERROR:', e); try { svc('resume', 'liquidator-bot') } catch { /* ignore */ } process.exit(2) })
