// The component that sells the team liquidator bot's claimed Upbet (YES) on
// the CLOB. Implements IYesSeller (see seller.ts — contract with
// liquidator-bot.ts, do not change). See root CLAUDE.md "CLOB Architecture",
// "Trading fee (CLOBSettlement)", and "Funding settlement points" (YES-sale
// Option B) for the economics this file leans on.
//
// ── What `minAmountOut` means for a YES ask (gross, not net) ───────────────
// contracts/src/CLOBSettlement.sol's `verifyAndSettle` checks
// `takerOrder.amountIn < makerOrder.minAmountOut` (line ~202) BEFORE any fee
// or funding-debt deduction — i.e. a YES ask's `minAmountOut` is a floor on
// the buyer's GROSS `amountIn` (the "tradePrice"), not on the seller's net
// proceeds. Unlike a NO sale (which gets an *additional* net-of-fee check,
// `sellerProceeds < sellerMinOut`, because the NO buyer's amountIn is
// fee-inflated), a YES sale has no such second check — net proceeds
// (`tradePrice − fee − any fundingDebt owed`) can and normally will land
// below `minAmountOut` by ~the trade fee. That's by design: YES buys are
// fee-free, YES sells pay the fee out of proceeds, and the order book's own
// price derivation (order-book-server's `derivePrice`) prices YES bids/asks
// on this exact same gross basis. So "the price of our ask" — and every
// price this file computes (`floorWad`, `markWad`, a bid's price) — is a
// GROSS USDC-per-YES price. We set `minAmountOut = yesAmount * priceWad /
// 1e18` (rounded down) to encode that gross price; the ~50bps trade fee (and
// a stale funding debt, expected to be ~0 right after a fresh claim) comes
// out of what we actually receive, on top of this floor, not counted against
// it. The FundingShortfall pre-filter below is the one path where the
// server hands us a net-aware number (`minSellProceeds`) directly usable as
// `minAmountOut`.
//
// ── Idempotency & policy ────────────────────────────────────────────────────
// floor = markWad × (10_000 − maxDiscountBps) / 10_000 (default 3% under
// mark — the claim margin, so a fire-sale doesn't hand the margin back).
// best YES bid ≥ floor  → post the full yesAmount at the best bid's price
//                          ("crossed" — expected to fill now).
// else                   → post the full yesAmount at markWad and let it
//                          rest ("rested").
// Before posting, look for our OWN resting YES asks (maker == account,
// tokenIn == YES). If they already cover yesAmount exactly at a price
// within a small tolerance of the current target and aren't expiring within
// ~1h, do nothing ("unchanged"). Otherwise cancel them (so the total YES
// offered never exceeds the balance) and post a fresh ask.
//
// ── Time ─────────────────────────────────────────────────────────────────
// Order expiry uses wall-clock seconds (`Date.now()`), NOT chain time.
// frontend/TradePanel uses chain time because the local/demo chains are
// time-warped (see docs/HANDOVER.md); the hosted Base Sepolia chain runs at
// real time, so wall clock is correct and simpler here.

import type { Address, Hex, LocalAccount } from 'viem'
import type { IYesSeller, SellAction, SellRequest, SellResult } from './seller'

// ─── Wire types mirrored from backend/order-book-server/src/types.ts ──────
// (kept local rather than imported — clob-seller.ts must not depend on the
// order-book-server package; this is the same wire shape POST /order and
// GET /orderbook use.)

interface OrderWire {
  maker: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  minAmountOut: string
  expiry: string
  nonce: string
  signature: string
}

interface StoredOrder extends OrderWire {
  id: string
  side: 'bid' | 'ask'
  price: number
  timestamp: number
}

interface OrderBookResponse {
  bids: StoredOrder[]
  asks: StoredOrder[]
}

// ─── EIP-712 — must mirror backend/order-book-server/src/validation.ts and
// scripts/demo/clob.ts / cancel-order.ts exactly ───────────────────────────

const ORDER_TYPES = {
  Order: [
    { name: 'maker', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

const CANCEL_TYPES = {
  CancelOrder: [{ name: 'orderId', type: 'string' }],
} as const

function domain(chainId: number, verifyingContract: Address) {
  return {
    name: 'CLOBSettlement',
    version: '1',
    chainId,
    verifyingContract,
  } as const
}

// ─── Constants ──────────────────────────────────────────────────────────────

const WAD = 10n ** 18n
const BPS = 10_000n
const DEFAULT_MAX_DISCOUNT_BPS = 300
const DEFAULT_ORDER_TTL_SEC = 86_400
// An own resting ask expiring within this window is treated as "not really
// covering" the balance any more — force a fresh post rather than risk it
// lapsing moments after we call it "unchanged".
const STALE_EXPIRY_BUFFER_SEC = 3_600
// How close an own ask's price has to be to the freshly-computed target to
// count as "still matches policy" (vs. a stale price from a moved mark/bid).
const PRICE_TOLERANCE_BPS = 10n

export interface ClobYesSellerConfig {
  orderBookUrl: string
  chainId: number
  clobSettlementAddress: Address
  yesTokenAddress: Address
  usdcAddress: Address
  /**
   * Multi-market: the market slug. When set, the book is read with
   * `GET /orderbook?market=<slug>`; orders are signed for THIS config's
   * clobSettlementAddress domain and YES token, and the order-book server derives
   * the market from the token. Unset (legacy mode) => no `market` param (= mstr).
   */
  marketSlug?: string
  /** viem LocalAccount, e.g. from privateKeyToAccount() */
  account: LocalAccount
  /** bps below mark the floor sits at. Default 300 (3%). */
  maxDiscountBps?: number
  /** order expiry, seconds from now. Default 86400 (24h). */
  orderTtlSec?: number
  fetchImpl?: typeof fetch
}

interface PostOutcome {
  status: number
  orderId?: string
  error?: string
  minSellProceeds?: string
}

interface BestBid {
  priceWad: bigint
  order: StoredOrder
}

interface OwnAsk {
  id: string
  amountIn: bigint
  priceWad: bigint
  expiry: bigint
}

export class ClobYesSeller implements IYesSeller {
  private readonly orderBookUrl: string
  private readonly chainId: number
  private readonly clobSettlementAddress: Address
  private readonly yesTokenAddress: Address
  private readonly usdcAddress: Address
  private readonly marketSlug: string | undefined
  private readonly account: LocalAccount
  private readonly maxDiscountBps: number
  private readonly orderTtlSec: number
  private readonly fetchImpl: typeof fetch

  // Time-based, monotonic within this process — mirrors scripts/demo/clob.ts's
  // nextNonce(). Only needs to be unique per (maker, nonce); CLOBSettlement
  // dedups per-maker so collisions across bots/processes don't matter.
  private nonceCounter: bigint

  constructor(cfg: ClobYesSellerConfig) {
    this.orderBookUrl = cfg.orderBookUrl.replace(/\/+$/, '')
    this.chainId = cfg.chainId
    this.clobSettlementAddress = cfg.clobSettlementAddress
    this.yesTokenAddress = cfg.yesTokenAddress
    this.usdcAddress = cfg.usdcAddress
    this.marketSlug = cfg.marketSlug
    this.account = cfg.account
    this.maxDiscountBps = cfg.maxDiscountBps ?? DEFAULT_MAX_DISCOUNT_BPS
    this.orderTtlSec = cfg.orderTtlSec ?? DEFAULT_ORDER_TTL_SEC
    this.fetchImpl = cfg.fetchImpl ?? fetch
    this.nonceCounter = BigInt(Date.now()) * 1_000_000n
  }

  /** Idempotent, never throws — see class doc comment for the full policy. */
  async sell(req: SellRequest): Promise<SellResult> {
    try {
      return await this.sellInner(req)
    } catch (err) {
      // Belt-and-braces: every awaited call below already catches its own
      // errors, but a defensive outer catch guarantees the "never throws"
      // contract even against something unanticipated (e.g. a bad Response
      // shape from a misbehaving fetchImpl).
      return { action: 'skipped', reason: `unexpected error: ${errMsg(err)}` }
    }
  }

  private async sellInner(req: SellRequest): Promise<SellResult> {
    const { yesAmount, markWad } = req

    if (yesAmount <= 0n) {
      return { action: 'skipped', reason: 'no YES balance to sell' }
    }
    if (markWad <= 0n) {
      return { action: 'skipped', reason: 'invalid mark (markWad <= 0)' }
    }

    const floorWad = (markWad * (BPS - BigInt(this.maxDiscountBps))) / BPS

    const book = await this.fetchOrderBook()
    if (!book) {
      return { action: 'skipped', reason: 'order book unreachable' }
    }

    const nowSec = BigInt(Math.floor(Date.now() / 1000))
    const bestBid = this.findBestYesBid(book.bids, nowSec)

    const crosses = bestBid !== null && bestBid.priceWad >= floorWad
    const targetPriceWad = crosses ? bestBid!.priceWad : markWad
    const targetAction: SellAction = crosses ? 'crossed' : 'rested'

    // ── idempotency: do we already have this covered? ────────────────────
    const ownAsks = this.findOwnYesAsks(book.asks, nowSec)
    if (this.isAlreadyCovered(ownAsks, yesAmount, targetPriceWad, nowSec)) {
      return { action: 'unchanged', amount: yesAmount, priceWad: targetPriceWad }
    }

    // Stale (or partial, or mismatched) own asks: cancel first so the total
    // YES offered never exceeds the balance. If any cancel can't be
    // confirmed, bail rather than risk posting on top of a still-live ask.
    for (const ask of ownAsks) {
      const cancelled = await this.cancelOrder(ask.id)
      if (!cancelled) {
        return { action: 'skipped', reason: `failed to cancel stale ask ${ask.id}` }
      }
    }

    const expiry = nowSec + BigInt(this.orderTtlSec)
    const minAmountOut = mulPriceFloor(yesAmount, targetPriceWad)
    const result = await this.postAskRaw(yesAmount, minAmountOut, expiry)

    if (result.status === 200 || result.status === 201) {
      return { action: targetAction, orderId: result.orderId, priceWad: targetPriceWad, amount: yesAmount }
    }

    if (result.status === 400 && result.error === 'PositionFrozen') {
      return { action: 'skipped', reason: 'PositionFrozen' }
    }

    if (result.status === 400 && result.error === 'FundingShortfall') {
      return this.handleFundingShortfall(result, yesAmount, floorWad, bestBid, expiry)
    }

    if (result.status === 429) {
      return { action: 'skipped', reason: 'rate limited (429)' }
    }

    if (result.status < 0) {
      return { action: 'skipped', reason: result.error ?? 'network error' }
    }

    return {
      action: 'skipped',
      reason: `order-book-server rejected ask: ${result.status}${result.error ? ` ${result.error}` : ''}`,
    }
  }

  // The bot's own YES has a fresh funding snapshot right after a claim (see
  // root CLAUDE.md "Liquidation math" — the liquidator's snapshot resets to
  // now), so this should be rare. If hit, `minSellProceeds` is already a
  // GROSS minAmountOut for this exact yesAmount (order-book-server's
  // minGrossForNet inversion) — usable directly, no re-derivation needed.
  private async handleFundingShortfall(
    result: PostOutcome,
    yesAmount: bigint,
    floorWad: bigint,
    bestBid: BestBid | null,
    expiry: bigint,
  ): Promise<SellResult> {
    if (result.minSellProceeds == null) {
      return { action: 'skipped', reason: 'FundingShortfall (server did not provide minSellProceeds)' }
    }
    let minSellProceeds: bigint
    try {
      minSellProceeds = BigInt(result.minSellProceeds)
    } catch {
      return { action: 'skipped', reason: 'FundingShortfall (unparseable minSellProceeds)' }
    }
    const repricedWad = (minSellProceeds * WAD) / yesAmount
    if (repricedWad < floorWad) {
      return { action: 'skipped', reason: `FundingShortfall: minSellProceeds implies a price below the ${this.maxDiscountBps}bps floor` }
    }

    const retry = await this.postAskRaw(yesAmount, minSellProceeds, expiry)
    if (retry.status === 200 || retry.status === 201) {
      const crosses = bestBid !== null && repricedWad <= bestBid.priceWad
      return { action: crosses ? 'crossed' : 'rested', orderId: retry.orderId, priceWad: repricedWad, amount: yesAmount }
    }
    return { action: 'skipped', reason: `FundingShortfall retry failed: ${retry.status}${retry.error ? ` ${retry.error}` : ''}` }
  }

  // ── order book reads ──────────────────────────────────────────────────────

  private async fetchOrderBook(): Promise<OrderBookResponse | null> {
    try {
      const q = this.marketSlug ? `?market=${encodeURIComponent(this.marketSlug)}` : ''
      const res = await this.fetchImpl(`${this.orderBookUrl}/orderbook${q}`)
      if (!res.ok) return null
      const body = await res.json().catch(() => null)
      if (!body || !Array.isArray((body as OrderBookResponse).bids) || !Array.isArray((body as OrderBookResponse).asks)) {
        return null
      }
      return body as OrderBookResponse
    } catch {
      return null
    }
  }

  // Best (highest-price) resting bid buying YES with USDC. YES bids are
  // fee-free, so amountIn/minAmountOut is already the gross price — the same
  // basis order-book-server's derivePrice uses for a YES bid.
  private findBestYesBid(bids: StoredOrder[], nowSec: bigint): BestBid | null {
    let best: BestBid | null = null
    for (const bid of bids) {
      if (!isSameAddress(bid.tokenIn, this.usdcAddress)) continue
      if (!isSameAddress(bid.tokenOut, this.yesTokenAddress)) continue
      const parsed = parseAmounts(bid)
      if (!parsed) continue
      const { amountIn, minAmountOut, expiry } = parsed
      if (expiry <= nowSec) continue
      if (minAmountOut <= 0n) continue
      const priceWad = (amountIn * WAD) / minAmountOut
      if (!best || priceWad > best.priceWad) best = { priceWad, order: bid }
    }
    return best
  }

  // Our own resting YES asks (maker == account, tokenIn == YES, tokenOut ==
  // USDC), not already expired.
  private findOwnYesAsks(asks: StoredOrder[], nowSec: bigint): OwnAsk[] {
    const out: OwnAsk[] = []
    for (const ask of asks) {
      if (!isSameAddress(ask.maker, this.account.address)) continue
      if (!isSameAddress(ask.tokenIn, this.yesTokenAddress)) continue
      if (!isSameAddress(ask.tokenOut, this.usdcAddress)) continue
      const parsed = parseAmounts(ask)
      if (!parsed) continue
      const { amountIn, minAmountOut, expiry } = parsed
      if (expiry <= nowSec) continue
      if (amountIn <= 0n) continue
      const priceWad = (minAmountOut * WAD) / amountIn
      out.push({ id: ask.id, amountIn, priceWad, expiry })
    }
    return out
  }

  private isAlreadyCovered(ownAsks: OwnAsk[], yesAmount: bigint, targetPriceWad: bigint, nowSec: bigint): boolean {
    if (ownAsks.length === 0) return false
    const totalCovered = ownAsks.reduce((sum, a) => sum + a.amountIn, 0n)
    if (totalCovered !== yesAmount) return false
    const minExpiry = ownAsks.reduce((min, a) => (a.expiry < min ? a.expiry : min), ownAsks[0]!.expiry)
    if (minExpiry <= nowSec + BigInt(STALE_EXPIRY_BUFFER_SEC)) return false
    return ownAsks.every(a => priceWithinTolerance(a.priceWad, targetPriceWad))
  }

  // ── signing + network ─────────────────────────────────────────────────────

  private async signOrder(order: {
    maker: Address
    tokenIn: Address
    tokenOut: Address
    amountIn: bigint
    minAmountOut: bigint
    expiry: bigint
    nonce: bigint
  }): Promise<Hex> {
    return this.account.signTypedData({
      domain: domain(this.chainId, this.clobSettlementAddress),
      types: ORDER_TYPES,
      primaryType: 'Order',
      message: order,
    })
  }

  private nextNonce(): bigint {
    this.nonceCounter += 1n
    return this.nonceCounter
  }

  private async postAskRaw(amountIn: bigint, minAmountOut: bigint, expiry: bigint): Promise<PostOutcome> {
    const nonce = this.nextNonce()
    const order = {
      maker: this.account.address,
      tokenIn: this.yesTokenAddress,
      tokenOut: this.usdcAddress,
      amountIn,
      minAmountOut,
      expiry,
      nonce,
    }

    let signature: Hex
    try {
      signature = await this.signOrder(order)
    } catch (err) {
      return { status: -1, error: `signing failed: ${errMsg(err)}` }
    }

    const wire: OrderWire = {
      maker: order.maker,
      tokenIn: order.tokenIn,
      tokenOut: order.tokenOut,
      amountIn: amountIn.toString(),
      minAmountOut: minAmountOut.toString(),
      expiry: expiry.toString(),
      nonce: nonce.toString(),
      signature,
    }

    try {
      const res = await this.fetchImpl(`${this.orderBookUrl}/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(wire),
      })
      const body = (await res.json().catch(() => ({}))) as {
        orderId?: string
        error?: string
        minSellProceeds?: string
      }
      return { status: res.status, orderId: body.orderId, error: body.error, minSellProceeds: body.minSellProceeds }
    } catch (err) {
      return { status: -1, error: `network error: ${errMsg(err)}` }
    }
  }

  private async cancelOrder(orderId: string): Promise<boolean> {
    try {
      const signature = await this.account.signTypedData({
        domain: domain(this.chainId, this.clobSettlementAddress),
        types: CANCEL_TYPES,
        primaryType: 'CancelOrder',
        message: { orderId },
      })
      const res = await this.fetchImpl(`${this.orderBookUrl}/order/${orderId}`, {
        method: 'DELETE',
        headers: { 'X-Maker': this.account.address, 'X-Signature': signature },
      })
      // 404 (already gone — e.g. filled or previously cancelled) counts as
      // "cancelled" for our purposes: either way it's no longer live.
      return res.ok || res.status === 404
    } catch {
      return false
    }
  }
}

// ─── free helpers ───────────────────────────────────────────────────────────

function isSameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

function parseAmounts(order: StoredOrder): { amountIn: bigint; minAmountOut: bigint; expiry: bigint } | null {
  try {
    return {
      amountIn: BigInt(order.amountIn),
      minAmountOut: BigInt(order.minAmountOut),
      expiry: BigInt(order.expiry),
    }
  } catch {
    return null
  }
}

// yesAmount (6-dec) × priceWad (1e18-scaled USDC-per-YES) / 1e18, rounded
// DOWN — an ask must never demand more USDC than the target price implies.
function mulPriceFloor(yesAmount: bigint, priceWad: bigint): bigint {
  return (yesAmount * priceWad) / WAD
}

function priceWithinTolerance(a: bigint, b: bigint): boolean {
  if (a === b) return true
  const diff = a > b ? a - b : b - a
  const base = b > 0n ? b : a
  if (base === 0n) return diff === 0n
  return diff * BPS <= base * PRICE_TOLERANCE_BPS
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
