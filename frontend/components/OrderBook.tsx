'use client'

import type { CSSProperties } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useChainId } from 'wagmi'
import { ORDER_BOOK_URL } from '@/lib/constants'
import { CONTRACT_ADDRESSES, type SupportedChainId } from '@/lib/contracts'

// Raw shape returned by GET /orderbook (backend/order-book-server's
// StoredOrder — full signed order, not a simplified {price, size} level).
// amountIn/minAmountOut are 6-decimal-scaled raw integers (as strings).
// The book is shared across YES and NO orders for the market (tokenIn/
// tokenOut disambiguate which); this component shows the Upbet (YES) side
// only — mixing NO-token orders in unfiltered makes the book look crossed,
// since a NO price isn't comparable to a YES price on the same axis.
type RawOrder = {
  side: 'bid' | 'ask'
  price: number // 0–1 float, e.g. 0.234 = 23.4% annual probability
  amountIn: string
  minAmountOut: string
  tokenIn: string
  tokenOut: string
}

type Level = {
  price: number
  size: number // USDC notional, derived below (not present on the wire)
}

type OrderBookData = {
  bids: RawOrder[] // descending price (best bid first)
  asks: RawOrder[] // ascending price  (best ask first)
}

// USDC notional resting on this order: for a bid, tokenIn is USDC
// (amountIn is the USDC offered); for an ask, tokenOut is USDC
// (minAmountOut is the minimum USDC proceeds) — mirrors the price
// derivation in order-book-server's derivePrice().
function toLevel(o: RawOrder): Level {
  const raw = o.side === 'bid' ? o.amountIn : o.minAmountOut
  return { price: o.price, size: Number(raw) / 1_000_000 }
}

const LEVELS = 8
const CLOB_COLS = '1fr 1fr'
const CLOB_STYLE = { '--clob-cols': CLOB_COLS } as CSSProperties

function pct(p: number) {
  return `${(p * 100).toFixed(1)}%`
}

function usd(n: number) {
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}k`
  return `$${n.toFixed(0)}`
}

async function fetchOrderBook(marketId: string): Promise<OrderBookData> {
  const res = await fetch(`${ORDER_BOOK_URL}/orderbook?market=${marketId}`, {
    signal: AbortSignal.timeout(3_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function SkeletonRow({ side }: { side: 'upbet' | 'downbet' }) {
  return (
    <div className={`pari-clob__row pari-clob__row--${side}`} style={{ opacity: 0.35 }}>
      <div className="h-3 w-12 rounded bg-surface-2 animate-pulse" />
      <div className="h-3 w-10 rounded bg-surface-2 animate-pulse justify-self-end" />
    </div>
  )
}

interface OrderBookProps {
  marketId: string
}

export function OrderBook({ marketId }: OrderBookProps) {
  const chainId = useChainId()
  const contracts = CONTRACT_ADDRESSES[chainId as SupportedChainId] ?? CONTRACT_ADDRESSES[84532]
  const yesToken = contracts.yesToken.toLowerCase()

  const { data, isLoading } = useQuery<OrderBookData>({
    queryKey: ['orderbook', marketId],
    queryFn: () => fetchOrderBook(marketId),
    refetchInterval: 2_000,
    retry: false,       // graceful empty state when server is offline
    throwOnError: false,
  })

  // Upbet (YES) side only: a bid buys YES (tokenOut === yesToken), an ask
  // sells YES (tokenIn === yesToken).
  const isYes = (o: RawOrder) =>
    (o.side === 'bid' ? o.tokenOut : o.tokenIn).toLowerCase() === yesToken

  const bids = (data?.bids ?? []).filter(isYes).slice(0, LEVELS).map(toLevel)
  const asks = (data?.asks ?? []).filter(isYes).slice(0, LEVELS).map(toLevel)
  const isEmpty = !isLoading && bids.length === 0 && asks.length === 0

  const bestBid = bids[0]?.price
  const bestAsk = asks[0]?.price
  const midPrice =
    bestBid != null && bestAsk != null
      ? (bestBid + bestAsk) / 2
      : (bestBid ?? bestAsk)

  // Asks are ascending (best ask first); render farthest-from-mid at the top,
  // best ask (nearest mid) at the bottom, just above the mid strip.
  const asksDisplay = [...asks].reverse()

  return (
    <div className="pari-clob select-none tabular" style={CLOB_STYLE}>
      <div className="pari-clob__header">
        <span>Price</span>
        <span className="text-right">Size</span>
      </div>

      {isLoading ? (
        <>
          {Array.from({ length: LEVELS }).map((_, i) => (
            <SkeletonRow key={`sk-ask-${i}`} side="upbet" />
          ))}
          {Array.from({ length: LEVELS }).map((_, i) => (
            <SkeletonRow key={`sk-bid-${i}`} side="downbet" />
          ))}
        </>
      ) : isEmpty ? (
        <div className="py-6 text-center text-xs uppercase tracking-widest text-text-muted">
          No resting orders
        </div>
      ) : (
        <>
          {asksDisplay.map((lvl, i) => (
            <div key={`ask-${i}`} className="pari-clob__row pari-clob__row--upbet">
              <span>{pct(lvl.price)}</span>
              <span className="text-right">{usd(lvl.size)}</span>
            </div>
          ))}

          <div className="pari-clob__mid">
            <span className="col-span-2 text-center">
              {midPrice != null ? `${(midPrice * 100).toFixed(1)}% chance` : '—'}
            </span>
          </div>

          {bids.map((lvl, i) => (
            <div key={`bid-${i}`} className="pari-clob__row pari-clob__row--downbet">
              <span>{pct(lvl.price)}</span>
              <span className="text-right">{usd(lvl.size)}</span>
            </div>
          ))}
        </>
      )}
    </div>
  )
}
