// Mark updater (batch 4, docs/design/motion-escrow-and-mark.md §3).
//
// The on-chain mark drives the carry rate, Equity, the seizure trigger, the claim cap
// m×Q and cost basis. It must follow trading. Per market, every MARK_POLL_MS:
//
//   1. fills  — time-weighted average (TWAP) of the YES-implied price of this market's
//               CLOBSettlement `OrderFilled` events over MARK_TWAP_WINDOW_SEC. Used when
//               there are ≥ MARK_MIN_FILLS fills of ≥ MARK_MIN_FILL_TOKENS each and
//               ≥ MARK_MIN_FILL_VOLUME tokens in total in the window.
//   2. book   — otherwise, the mid of the YES-implied book, where each side's price is
//               the level at which MARK_BOOK_MIN_DEPTH tokens of resting size are
//               reached (a 1-token quote can't move it), and only if the spread between
//               those two prices is ≤ MARK_BOOK_MAX_SPREAD.
//               When both are usable, the fills TWAP is clamped into that depth band
//               (old fills can't hold the mark outside today's two-sided market).
//   3. none   — the mark holds and, after MARK_STALE_ALERT_SEC, an [ALERT] is logged.
//
// The target is clamped to [MARK_MIN, MARK_MAX]. A move smaller than MARK_DEADBAND is
// skipped. Otherwise setMark() is sent once minMarkInterval has passed since
// lastMarkUpdate, stepping at most maxMarkStep (both read on-chain; 50 points / 10 min
// by default, decided Q2). Jumps go both ways, and a downward move counts for flagging
// at once (owner decision). Protection for holders: the on-site health alert and Pay
// carry anytime.
//
// YES-implied prices:
//   YES fill:  tradePrice / tokens            (tradePrice is the buyer's gross USDC)
//   NO fill:   1 − (tradePrice − fee) / tokens (the NO seller's net: buying NO at 1−p
//              ≡ minting and selling YES at p, see the fee section of root CLAUDE.md)
//   YES bid/ask: its price; NO bid (stored NET) → YES ask at 1 − price;
//   NO ask (net floor) → YES bid at 1 − price.
//
// Manipulation: a fill only happens where the matching engine crosses the best bid
// and ask, so printing an extreme price means first trading through every better
// quote. The minimum fill size, the TWAP window and the depth band blunt the rest.
// A compromised MARK key can post a bad mark within the on-chain bounds; the admin
// reverts it with adminSetMark.
//
// Writes need MARK_ROLE on each CreditMarket (deploy env MARK_UPDATER_ADDRESS). Without
// it — batch-3 contracts have no MARK_ROLE — or with MARK_DRY_RUN=true, the service
// computes and logs targets and serves /health but sends nothing.

import http from 'http'
import { createPublicClient, createWalletClient, http as viemHttp } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import type { Address, Hash } from 'viem'
import { chainFor, rpcUrlFromEnv } from './chains'
import { installShutdownHandlers, closeHttpServer } from './shutdown'
import { buildDirectory } from './markets'
import type { IRegistryClient, MarketInfo, MarketDirectoryStatus } from './registry'
import { parsePrivateKey, isTransientError, LowBalanceMonitor } from './funding-keeper'

export const WAD = 10n ** 18n

// ─── ABIs ──────────────────────────────────────────────────────────────────────

const view = (name: string, out: string, inputs: Array<{ name: string; type: string }> = []) => ({
  name, type: 'function' as const, stateMutability: 'view' as const, inputs, outputs: [{ name: '', type: out }],
})

export const MARK_CREDIT_MARKET_ABI = [
  view('currentMark', 'uint256'),
  view('lastMarkUpdate', 'uint256'),
  view('maxMarkStep', 'uint256'),
  view('minMarkInterval', 'uint256'),
  view('creditEventConfirmed', 'bool'),
  view('MARK_ROLE', 'bytes32'),
  view('hasRole', 'bool', [{ name: 'role', type: 'bytes32' }, { name: 'account', type: 'address' }]),
  {
    name: 'setMark', type: 'function' as const, stateMutability: 'nonpayable' as const,
    inputs: [{ name: 'newMark', type: 'uint256' }], outputs: [],
  },
  { name: 'InvalidMark', type: 'error' as const, inputs: [] },
  { name: 'MarkUpdateTooSoon', type: 'error' as const, inputs: [] },
  { name: 'MarkStepTooLarge', type: 'error' as const, inputs: [] },
] as const

export const ORDER_FILLED_EVENT = {
  type: 'event' as const,
  name: 'OrderFilled',
  inputs: [
    { name: 'makerOrderHash', type: 'bytes32', indexed: true },
    { name: 'takerOrderHash', type: 'bytes32', indexed: true },
    { name: 'seller', type: 'address', indexed: true },
    { name: 'buyer', type: 'address', indexed: false },
    { name: 'token', type: 'address', indexed: false },
    { name: 'tokens', type: 'uint256', indexed: false },
    { name: 'tradePrice', type: 'uint256', indexed: false },
    { name: 'fee', type: 'uint256', indexed: false },
    { name: 'debtCollected', type: 'uint256', indexed: false },
  ],
} as const

// ─── Pure math (prices are WAD: 1e18 = $1 per token = 100% chance) ─────────────

export interface Fill {
  blockNumber: bigint
  timestamp: number // unix seconds
  yesPrice: bigint  // WAD
  tokens: bigint    // raw 6-decimal token units
}

/** YES-implied price of one fill, or null if it can't be priced. */
export function fillYesPrice(isYes: boolean, tokens: bigint, tradePrice: bigint, fee: bigint): bigint | null {
  if (tokens <= 0n) return null
  if (isYes) return (tradePrice * WAD) / tokens
  const net = tradePrice > fee ? tradePrice - fee : 0n
  const noPrice = (net * WAD) / tokens
  return noPrice >= WAD ? 0n : WAD - noPrice
}

export interface TwapOptions {
  windowSec: number
  minFills: number
  minFillTokens: bigint
  minVolume: bigint
}

export interface TwapResult { price: bigint; fills: number; volume: bigint }

/**
 * Time-weighted average of fill prices in (now − window, now]. Fills in the same
 * second collapse into their volume-weighted price; each price is then held until the
 * next one (the last until `now`), with a 1-second floor so every group counts.
 */
export function fillTwap(fills: readonly Fill[], nowSec: number, o: TwapOptions): TwapResult | null {
  const from = nowSec - o.windowSec
  const inWin = fills.filter(f => f.timestamp > from && f.timestamp <= nowSec && f.tokens >= o.minFillTokens)
  if (inWin.length < o.minFills || inWin.length === 0) return null
  const volume = inWin.reduce((a, f) => a + f.tokens, 0n)
  if (volume < o.minVolume) return null

  const groups = new Map<number, { pv: bigint; v: bigint }>()
  for (const f of inWin) {
    const g = groups.get(f.timestamp) ?? { pv: 0n, v: 0n }
    g.pv += f.yesPrice * f.tokens
    g.v += f.tokens
    groups.set(f.timestamp, g)
  }
  const ts = [...groups.keys()].sort((a, b) => a - b)
  let num = 0n
  let den = 0n
  for (let i = 0; i < ts.length; i++) {
    const g = groups.get(ts[i])!
    const next = i + 1 < ts.length ? ts[i + 1] : nowSec
    const w = BigInt(Math.max(1, next - ts[i]))
    num += (g.pv / g.v) * w
    den += w
  }
  return { price: num / den, fills: inWin.length, volume }
}

/** Minimal view of an order-book-server StoredOrder. */
export interface BookOrder {
  side: 'bid' | 'ask'
  tokenIn: string
  tokenOut: string
  amountIn: string
  minAmountOut: string
  expiry: string
  price: number   // USDC per token (NO bids: NET)
  filled?: string
}

export interface BookLevel { price: bigint; size: bigint }
export interface ImpliedBook { bids: BookLevel[]; asks: BookLevel[] }

function priceToWad(p: number): bigint | null {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null
  return BigInt(Math.round(p * 1e9)) * 10n ** 9n
}

/** The market's YES-implied book: YES orders as-is, NO orders mirrored at 1 − price. */
export function yesImpliedBook(
  orders: readonly BookOrder[],
  tokens: { yesToken: string; noToken: string },
  nowSec: number,
): ImpliedBook {
  const yes = tokens.yesToken.toLowerCase()
  const no = tokens.noToken.toLowerCase()
  const bids: BookLevel[] = []
  const asks: BookLevel[] = []
  for (const o of orders) {
    try {
      if (Number(o.expiry) <= nowSec) continue
      const outcome = (o.side === 'bid' ? o.tokenOut : o.tokenIn).toLowerCase()
      const size = BigInt(o.side === 'bid' ? o.minAmountOut : o.amountIn) - BigInt(o.filled ?? '0')
      if (size <= 0n) continue
      const p = priceToWad(o.price)
      if (p === null) continue
      if (outcome === yes) (o.side === 'bid' ? bids : asks).push({ price: p, size })
      else if (outcome === no) (o.side === 'bid' ? asks : bids).push({ price: WAD - p, size })
    } catch { /* malformed order — ignore */ }
  }
  bids.sort((a, b) => (b.price > a.price ? 1 : b.price < a.price ? -1 : 0))
  asks.sort((a, b) => (a.price > b.price ? 1 : a.price < b.price ? -1 : 0))
  return { bids, asks }
}

/** Price of the level at which cumulative size first reaches minDepth (null if never). */
export function depthPrice(levels: readonly BookLevel[], minDepth: bigint): bigint | null {
  let cum = 0n
  for (const l of levels) {
    cum += l.size
    if (cum >= minDepth) return l.price
  }
  return null
}

export interface BookMid { mid: bigint; bid: bigint; ask: bigint }

export function bookMid(book: ImpliedBook, minDepth: bigint, maxSpread: bigint): BookMid | null {
  const bid = depthPrice(book.bids, minDepth)
  const ask = depthPrice(book.asks, minDepth)
  if (bid === null || ask === null) return null
  const spread = ask > bid ? ask - bid : 0n
  if (spread > maxSpread) return null
  return { mid: (bid + ask) / 2n, bid, ask }
}

export type MarkSource = 'fills' | 'book'

export interface Target { target: bigint; source: MarkSource; clampedToBook: boolean }

export function chooseTarget(
  twap: TwapResult | null,
  book: BookMid | null,
  bounds: { min: bigint; max: bigint },
): Target | null {
  let target: bigint
  let source: MarkSource
  let clampedToBook = false
  if (twap) {
    target = twap.price
    source = 'fills'
    if (book && book.bid <= book.ask) {
      if (target < book.bid) { target = book.bid; clampedToBook = true }
      if (target > book.ask) { target = book.ask; clampedToBook = true }
    }
  } else if (book) {
    target = book.mid
    source = 'book'
  } else {
    return null
  }
  if (target < bounds.min) target = bounds.min
  if (target > bounds.max) target = bounds.max
  return { target, source, clampedToBook }
}

export type Plan =
  | { action: 'set'; mark: bigint; stepped: boolean }
  | { action: 'hold'; reason: 'deadband' | 'interval' | 'invalid' }

/** What to send, given the on-chain bounds. Pure. */
export function planUpdate(a: {
  target: bigint
  current: bigint
  lastUpdate: bigint
  nowSec: bigint
  maxStep: bigint
  minInterval: bigint
  deadband: bigint
}): Plan {
  const diff = a.target > a.current ? a.target - a.current : a.current - a.target
  if (diff < a.deadband || diff === 0n) return { action: 'hold', reason: 'deadband' }
  if (a.nowSec < a.lastUpdate + a.minInterval) return { action: 'hold', reason: 'interval' }
  const step = diff > a.maxStep ? a.maxStep : diff
  const mark = a.target > a.current ? a.current + step : a.current - step
  if (mark <= 0n || mark >= WAD) return { action: 'hold', reason: 'invalid' }
  return { action: 'set', mark, stepped: diff > a.maxStep }
}

// ─── Config ────────────────────────────────────────────────────────────────────

export interface MarkConfig {
  pollMs: number
  twap: TwapOptions
  bookMinDepth: bigint
  bookMaxSpread: bigint
  deadband: bigint
  minMark: bigint
  maxMark: bigint
  staleAlertSec: number
  blockTimeSec: number
  logChunkBlocks: bigint
  dryRun: boolean
}

function num(raw: string | undefined, fallback: number): number {
  const n = Number((raw ?? '').trim())
  return (raw ?? '').trim() !== '' && Number.isFinite(n) && n >= 0 ? n : fallback
}
const wadOf = (x: number) => BigInt(Math.round(x * 1e9)) * 10n ** 9n
const tokensOf = (x: number) => BigInt(Math.round(x * 1e6))

export function markConfigFromEnv(env: NodeJS.ProcessEnv = process.env): MarkConfig {
  return {
    pollMs:         num(env.MARK_POLL_MS, 60_000),
    twap: {
      windowSec:     num(env.MARK_TWAP_WINDOW_SEC, 3600),
      minFills:      num(env.MARK_MIN_FILLS, 2),
      minFillTokens: tokensOf(num(env.MARK_MIN_FILL_TOKENS, 1)),    // Upbets/Downbets
      minVolume:     tokensOf(num(env.MARK_MIN_FILL_VOLUME, 50)),
    },
    bookMinDepth:   tokensOf(num(env.MARK_BOOK_MIN_DEPTH, 100)),
    bookMaxSpread:  wadOf(num(env.MARK_BOOK_MAX_SPREAD, 0.10)),
    deadband:       wadOf(num(env.MARK_DEADBAND, 0.0025)),
    minMark:        wadOf(num(env.MARK_MIN, 0.001)),
    maxMark:        wadOf(num(env.MARK_MAX, 0.95)),
    staleAlertSec:  num(env.MARK_STALE_ALERT_SEC, 6 * 3600),
    blockTimeSec:   num(env.BLOCK_TIME_SEC, 2) || 2,
    logChunkBlocks: BigInt(Math.max(1, Math.floor(num(env.LOG_CHUNK_BLOCKS, 2000)))),
    dryRun:         ['1', 'true', 'yes'].includes((env.MARK_DRY_RUN ?? '').trim().toLowerCase()),
  }
}

// ─── Narrow clients ────────────────────────────────────────────────────────────

export interface FilledLog {
  blockNumber: bigint | null
  args: { token?: Address; tokens?: bigint; tradePrice?: bigint; fee?: bigint }
}

export interface IMarkPublicClient {
  readContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[] }): Promise<unknown>
  estimateContractGas(args: { address: Address; abi: readonly unknown[]; functionName: string; args: readonly unknown[]; account: Address }): Promise<bigint>
  waitForTransactionReceipt(args: { hash: Hash }): Promise<{ status: 'success' | 'reverted' }>
  getBlock(args?: { blockNumber?: bigint }): Promise<{ number: bigint | null; timestamp: bigint }>
  getLogs(args: { address: Address; event: typeof ORDER_FILLED_EVENT; fromBlock: bigint; toBlock: bigint }): Promise<FilledLog[]>
  getBalance?(args: { address: Address }): Promise<bigint>
}

export interface IMarkWalletClient {
  writeContract(args: { address: Address; abi: readonly unknown[]; functionName: string; args?: readonly unknown[]; gas: bigint }): Promise<Hash>
  account: { address: Address } | undefined
}

export interface IBookSource {
  fetch(market: MarketInfo): Promise<BookOrder[]>
}

/** GET {ORDER_BOOK_URL}/orderbook?market=<slug> (no param in legacy mode). */
export class HttpBookSource implements IBookSource {
  constructor(private readonly baseUrl: string, private readonly registryMode: boolean, private readonly timeoutMs = 5000) {}
  async fetch(market: MarketInfo): Promise<BookOrder[]> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/orderbook${this.registryMode ? `?market=${encodeURIComponent(market.slug)}` : ''}`
    const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) })
    if (!res.ok) throw new Error(`orderbook ${market.slug}: HTTP ${res.status}`)
    const body = await res.json() as { bids?: BookOrder[]; asks?: BookOrder[] }
    return [...(body.bids ?? []), ...(body.asks ?? [])]
  }
}

// ─── Per-market worker ─────────────────────────────────────────────────────────

export interface MarkMarketHealth {
  lastRunAt: string | null
  writable: boolean | null
  writableReason: string | null
  onChainMark: string | null
  target: string | null
  source: MarkSource | null
  clampedToBook: boolean
  lastPlan: string | null
  lastSetAt: string | null
  lastSetTx: string | null
  lastSourceAt: string | null
  fillsInWindow: number
  book: { bid: string; ask: string } | null
  consecutiveFailures: number
  lastError: string | null
}

function brief(err: unknown): string {
  const e = err as { shortMessage?: unknown; message?: unknown } | null
  const m = typeof e?.shortMessage === 'string' ? e.shortMessage : typeof e?.message === 'string' ? e.message : String(err)
  return m.split('\n')[0].slice(0, 300)
}

const pct = (w: bigint) => `${(Number(w) / 1e16).toFixed(2)}%`

export class MarkUpdater {
  private fills: Fill[] = []
  private syncedTo: bigint | null = null
  private blockTs = new Map<bigint, number>()
  private writable: boolean | null = null
  private writableReason: string | null = null
  private writableCheckedAt = 0
  private lastSourceAt: number | null = null
  private lastStaleAlertAt: number | null = null
  private readonly startedAt: number
  private readonly tag: string
  private readonly h: MarkMarketHealth = {
    lastRunAt: null, writable: null, writableReason: null, onChainMark: null, target: null, source: null,
    clampedToBook: false, lastPlan: null, lastSetAt: null, lastSetTx: null, lastSourceAt: null,
    fillsInWindow: 0, book: null, consecutiveFailures: 0, lastError: null,
  }

  constructor(
    private readonly pub: IMarkPublicClient,
    private readonly wallet: IMarkWalletClient | null,
    private readonly market: MarketInfo,
    private readonly books: IBookSource,
    private readonly cfg: MarkConfig,
    private readonly now: () => number = Date.now,
  ) {
    this.tag = `[mark:${market.slug}]`
    this.startedAt = now()
  }

  health(): MarkMarketHealth {
    return { ...this.h, book: this.h.book ? { ...this.h.book } : null }
  }

  private read<T>(functionName: string, args?: readonly unknown[]): Promise<T> {
    return this.pub.readContract({
      address: this.market.creditMarket as Address, abi: MARK_CREDIT_MARKET_ABI, functionName, ...(args ? { args } : {}),
    }) as Promise<T>
  }

  /** Whether this wallet may call setMark here. Re-checked hourly while false. */
  private async checkWritable(): Promise<boolean> {
    if (this.writable === true) return true
    if (this.writable === false && this.now() - this.writableCheckedAt < 3_600_000) return false
    this.writableCheckedAt = this.now()
    if (this.cfg.dryRun) { this.writable = false; this.writableReason = 'MARK_DRY_RUN'; return false }
    const account = this.wallet?.account?.address
    if (!account) { this.writable = false; this.writableReason = 'no MARK_UPDATER_PRIVATE_KEY'; return false }
    let role: `0x${string}`
    try {
      role = await this.read<`0x${string}`>('MARK_ROLE')
    } catch {
      this.writable = false
      this.writableReason = 'contract has no MARK_ROLE (batch-3 contracts) — dry run'
      return false
    }
    const ok = await this.read<boolean>('hasRole', [role, account])
    this.writable = ok
    this.writableReason = ok ? null : `wallet ${account} lacks MARK_ROLE — dry run`
    if (!ok) console.error(`[ALERT] ${this.tag} ${this.writableReason}`)
    return ok
  }

  private async timestampOf(blockNumber: bigint): Promise<number> {
    const hit = this.blockTs.get(blockNumber)
    if (hit !== undefined) return hit
    const b = await this.pub.getBlock({ blockNumber })
    const t = Number(b.timestamp)
    this.blockTs.set(blockNumber, t)
    return t
  }

  /** Pull new OrderFilled logs up to `latest`; drop fills older than the window. */
  private async syncFills(latest: bigint, nowSec: number): Promise<void> {
    const windowBlocks = BigInt(Math.ceil(this.cfg.twap.windowSec / this.cfg.blockTimeSec)) + 10n
    const floor = latest > windowBlocks ? latest - windowBlocks : 0n
    let from = this.syncedTo === null ? floor : this.syncedTo + 1n
    if (from < floor) from = floor
    if (from < this.market.startBlock) from = this.market.startBlock
    const yes = this.market.yesToken.toLowerCase()
    const no = this.market.noToken.toLowerCase()
    while (from <= latest) {
      const to = from + this.cfg.logChunkBlocks - 1n < latest ? from + this.cfg.logChunkBlocks - 1n : latest
      const logs = await this.pub.getLogs({
        address: this.market.clobSettlement as Address, event: ORDER_FILLED_EVENT, fromBlock: from, toBlock: to,
      })
      for (const l of logs) {
        const tok = l.args.token?.toLowerCase()
        if (l.blockNumber === null || (tok !== yes && tok !== no)) continue
        const tokens = l.args.tokens ?? 0n
        const p = fillYesPrice(tok === yes, tokens, l.args.tradePrice ?? 0n, l.args.fee ?? 0n)
        if (p === null) continue
        this.fills.push({ blockNumber: l.blockNumber, timestamp: await this.timestampOf(l.blockNumber), yesPrice: p, tokens })
      }
      this.syncedTo = to
      from = to + 1n
    }
    const cutoff = nowSec - this.cfg.twap.windowSec
    this.fills = this.fills.filter(f => f.timestamp > cutoff)
    for (const b of this.blockTs.keys()) if (b < floor) this.blockTs.delete(b)
  }

  async runOnce(): Promise<void> {
    try {
      await this.cycle()
      this.h.consecutiveFailures = 0
      this.h.lastError = null
    } catch (err) {
      this.h.consecutiveFailures++
      this.h.lastError = brief(err)
      const lvl = this.h.consecutiveFailures >= 3 ? '[ALERT] ' : ''
      console.error(`${lvl}${this.tag} cycle failed (consecutive=${this.h.consecutiveFailures}): ${this.h.lastError}`)
    }
  }

  private async cycle(): Promise<void> {
    this.h.lastRunAt = new Date(this.now()).toISOString()
    if (await this.read<boolean>('creditEventConfirmed')) {
      this.h.lastPlan = 'hold: credit event confirmed'
      return
    }
    const writable = await this.checkWritable()
    this.h.writable = writable
    this.h.writableReason = this.writableReason
    const head = await this.pub.getBlock()
    const latest = head.number ?? 0n
    const nowSec = Number(head.timestamp)

    await this.syncFills(latest, nowSec)
    const twap = fillTwap(this.fills, nowSec, this.cfg.twap)
    this.h.fillsInWindow = this.fills.length

    let mid: BookMid | null = null
    try {
      const orders = await this.books.fetch(this.market)
      mid = bookMid(yesImpliedBook(orders, this.market, nowSec), this.cfg.bookMinDepth, this.cfg.bookMaxSpread)
    } catch (err) {
      console.error(`${this.tag} order book unavailable: ${brief(err)}`)
    }
    this.h.book = mid ? { bid: mid.bid.toString(), ask: mid.ask.toString() } : null

    const [current, lastUpdate, maxStep, minInterval] = await Promise.all([
      this.read<bigint>('currentMark'), this.read<bigint>('lastMarkUpdate'),
      this.read<bigint>('maxMarkStep'), this.read<bigint>('minMarkInterval'),
    ])
    this.h.onChainMark = current.toString()

    const t = chooseTarget(twap, mid, { min: this.cfg.minMark, max: this.cfg.maxMark })
    if (!t) {
      this.h.target = null
      this.h.source = null
      this.h.lastPlan = 'hold: no usable fills or book'
      this.maybeStaleAlert(current)
      return
    }
    this.lastSourceAt = this.now()
    this.h.lastSourceAt = new Date(this.lastSourceAt).toISOString()
    this.h.target = t.target.toString()
    this.h.source = t.source
    this.h.clampedToBook = t.clampedToBook

    const plan = planUpdate({
      target: t.target, current, lastUpdate, nowSec: BigInt(nowSec), maxStep, minInterval, deadband: this.cfg.deadband,
    })
    const desc = `target=${pct(t.target)} (${t.source}${t.clampedToBook ? ', clamped to book' : ''}) onChain=${pct(current)}`
    if (plan.action === 'hold') {
      this.h.lastPlan = `hold: ${plan.reason}`
      if (plan.reason !== 'deadband') console.log(`${this.tag} ${desc} — hold (${plan.reason})`)
      return
    }
    if (plan.stepped) {
      console.error(`[ALERT] ${this.tag} ${desc} — repricing larger than maxMarkStep; stepping to ${pct(plan.mark)} (admin can adminSetMark)`)
    }
    if (!writable) {
      this.h.lastPlan = `dry run: would setMark ${pct(plan.mark)}`
      console.log(`${this.tag} ${desc} — DRY RUN would setMark(${pct(plan.mark)}) [${this.writableReason}]`)
      return
    }
    await this.send(plan.mark, desc)
  }

  private async send(mark: bigint, desc: string): Promise<void> {
    const account = this.wallet!.account!.address
    const call = { address: this.market.creditMarket as Address, abi: MARK_CREDIT_MARKET_ABI, functionName: 'setMark', args: [mark] as const }
    let hash: Hash
    try {
      const gas = await this.pub.estimateContractGas({ ...call, account })
      hash = await this.wallet!.writeContract({ ...call, gas: (gas * 120n) / 100n })
    } catch (err) {
      // A revert here (MarkUpdateTooSoon after a race, MarkStepTooLarge after an admin
      // bounds change) is deterministic: next tick re-reads the bounds. Transient RPC
      // errors also just wait for the next tick — lastMarkUpdate makes a re-send safe.
      this.h.lastPlan = `setMark failed${isTransientError(err) ? ' (transient)' : ''}`
      throw err
    }
    const r = await this.pub.waitForTransactionReceipt({ hash })
    if (r.status !== 'success') {
      this.h.lastPlan = 'setMark reverted'
      throw new Error(`setMark REVERTED: ${hash}`)
    }
    this.h.lastSetAt = new Date(this.now()).toISOString()
    this.h.lastSetTx = hash
    this.h.lastPlan = `set ${pct(mark)}`
    this.h.onChainMark = mark.toString()
    console.log(`${this.tag} ${desc} — setMark(${pct(mark)}) tx=${hash}`)
  }

  private maybeStaleAlert(current: bigint): void {
    const since = this.lastSourceAt ?? this.startedAt
    const t = this.now()
    if (t - since < this.cfg.staleAlertSec * 1000) return
    if (this.lastStaleAlertAt !== null && t - this.lastStaleAlertAt < 3_600_000) return
    this.lastStaleAlertAt = t
    console.error(
      `[ALERT] ${this.tag} no usable fills or book for ${((t - since) / 3_600_000).toFixed(1)}h — ` +
      `mark held at ${pct(current)}; check liquidity / order-book-server`,
    )
  }
}

// ─── All markets ───────────────────────────────────────────────────────────────

export interface IMarkDirectory {
  list(opts?: { activeOnly?: boolean }): MarketInfo[]
  status(): MarketDirectoryStatus
  mode: 'registry' | 'legacy'
}

export interface IMarkWorker {
  runOnce(): Promise<void>
  health(): MarkMarketHealth
}

export class MarkUpdaterService {
  private workers = new Map<string, IMarkWorker>()
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private inFlight: Promise<void> | null = null

  constructor(
    private readonly directory: IMarkDirectory,
    private readonly makeWorker: (m: MarketInfo) => IMarkWorker,
    private readonly cfg: Pick<MarkConfig, 'pollMs' | 'dryRun'>,
    private readonly balance?: Pick<LowBalanceMonitor, 'check' | 'state'>,
  ) {}

  start(): void {
    console.log(`[mark] polling every ${this.cfg.pollMs / 1000}s${this.cfg.dryRun ? ' (MARK_DRY_RUN)' : ''}`)
    void this.runAll()
    this.timer = setInterval(() => { if (!this.stopped) void this.runAll() }, this.cfg.pollMs)
  }

  /** Single-flight; markets run one at a time (one wallet, one nonce stream). */
  runAll(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.inner()
        .catch(err => { console.error('[mark] unhandled error:', err) })
        .finally(() => { this.inFlight = null })
    }
    return this.inFlight
  }

  private async inner(): Promise<void> {
    try { await this.balance?.check() } catch { /* logged inside */ }
    for (const m of this.directory.list({ activeOnly: true })) {
      if (this.stopped) break
      let w = this.workers.get(m.slug)
      if (!w) {
        console.log(`[mark] tracking market ${m.slug}`)
        w = this.makeWorker(m)
        this.workers.set(m.slug, w)
      }
      try {
        await w.runOnce()
      } catch (err) {
        console.error(`[mark:${m.slug}] cycle failed (other markets continue):`, err)
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.inFlight) await this.inFlight
  }

  health(): object {
    const markets: Record<string, MarkMarketHealth> = {}
    const active = new Set(this.directory.list({ activeOnly: true }).map(m => m.slug))
    for (const [slug, w] of this.workers) if (active.has(slug)) markets[slug] = w.health()
    return {
      status: 'ok',
      dryRun: this.cfg.dryRun,
      registry: this.directory.status(),
      markets,
      alerts: { keeperBalance: this.balance?.state() ?? null },
    }
  }
}

export function startHealthServer(svc: { health(): object }, port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(svc.health()))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  server.listen(port, () => console.log(`[mark] health check on http://0.0.0.0:${port}/health`))
  return server
}

// ─── Entry point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const rpcUrl = rpcUrlFromEnv()
  if (!rpcUrl) throw new Error('RPC_URL (or BASE_SEPOLIA_RPC_URL) env var is required')
  const cfg = markConfigFromEnv()
  const chainId = parseInt(process.env.CHAIN_ID ?? '84532')
  const chain = chainFor(chainId, rpcUrl)
  const transport = viemHttp(rpcUrl)
  const publicClient = createPublicClient({ chain, transport })

  const rawKey = process.env.MARK_UPDATER_PRIVATE_KEY
  const account = rawKey ? privateKeyToAccount(parsePrivateKey(rawKey, 'MARK_UPDATER_PRIVATE_KEY')) : null
  const walletClient = account ? createWalletClient({ account, chain, transport }) : null
  if (!account) console.log('[mark] MARK_UPDATER_PRIVATE_KEY not set — dry run (computes and logs, sends nothing)')

  const directory = buildDirectory({ client: publicClient as unknown as IRegistryClient })
  await directory.start()

  const books = new HttpBookSource(process.env.ORDER_BOOK_URL ?? 'http://localhost:3001', directory.mode === 'registry')
  const minEth = Number(process.env.MARK_MIN_ETH ?? '0.0005')
  const balance = account
    ? new LowBalanceMonitor(publicClient as unknown as IMarkPublicClient, account.address,
        BigInt(Math.round((Number.isFinite(minEth) && minEth >= 0 ? minEth : 0.0005) * 1e18)), 3_600_000, Date.now, 'mark-updater')
    : undefined

  const svc = new MarkUpdaterService(directory, m => new MarkUpdater(
    publicClient as unknown as IMarkPublicClient,
    walletClient as unknown as IMarkWalletClient | null,
    m, books, cfg,
  ), cfg, balance)
  svc.start()
  const server = startHealthServer(svc, parseInt(process.env.HEALTH_PORT ?? '3005'))
  console.log(`[mark] started (${directory.mode} mode, ${directory.list({ activeOnly: true }).length} active market(s))`)

  installShutdownHandlers('mark-updater', [
    { name: 'mark-updater', run: () => svc.stop() },
    { name: 'health-server', run: () => closeHttpServer(server) },
    { name: 'registry', run: async () => directory.stop() },
  ])
}

if (require.main === module) {
  main().catch(err => {
    console.error('[mark] fatal:', err)
    process.exit(1)
  })
}
