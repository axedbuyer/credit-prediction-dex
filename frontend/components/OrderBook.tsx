'use client'

import { useQuery } from '@tanstack/react-query'
import { ORDER_BOOK_URL } from '@/lib/constants'

type Level = {
  price: number // 0–1 float, e.g. 0.234 = 23.4% annual probability
  size: number  // USDC
}

type OrderBookData = {
  bids: Level[] // descending price (best bid first)
  asks: Level[] // ascending price  (best ask first)
}

const LEVELS = 8

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

function SkeletonRow() {
  return (
    <div className="flex items-center justify-between px-2 py-[5px]">
      <div className="h-3 w-10 rounded bg-slate-800 animate-pulse" />
      <div className="h-3 w-14 rounded bg-slate-800 animate-pulse" />
    </div>
  )
}

// Keeps column height stable when fewer than LEVELS rows are present
function EmptyFill({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="py-[5px] h-[25px]" />
      ))}
    </>
  )
}

interface OrderBookProps {
  marketId: string
}

export function OrderBook({ marketId }: OrderBookProps) {
  const { data, isLoading } = useQuery<OrderBookData>({
    queryKey: ['orderbook', marketId],
    queryFn: () => fetchOrderBook(marketId),
    refetchInterval: 2_000,
    retry: false,       // graceful empty state when server is offline
    throwOnError: false,
  })

  const bids = (data?.bids ?? []).slice(0, LEVELS)
  const asks = (data?.asks ?? []).slice(0, LEVELS)
  const isEmpty = !isLoading && bids.length === 0 && asks.length === 0

  const bestBid = bids[0]?.price
  const bestAsk = asks[0]?.price
  const midPrice =
    bestBid != null && bestAsk != null
      ? (bestBid + bestAsk) / 2
      : (bestBid ?? bestAsk)

  return (
    <div className="select-none font-mono text-xs">

      {/* Column headers */}
      <div className="flex">
        <div className="flex-1 min-w-0">
          <p className="px-2 pb-0.5 text-[10px] uppercase tracking-widest text-emerald-500/70">
            Bids · YES buyers
          </p>
          <div className="flex justify-between px-2 pb-1 text-[10px] uppercase tracking-wide text-slate-500">
            <span>Price</span><span>Size</span>
          </div>
        </div>

        <div className="w-px bg-slate-800 mx-1 self-stretch" />

        <div className="flex-1 min-w-0">
          <p className="px-2 pb-0.5 text-[10px] uppercase tracking-widest text-red-500/70">
            Asks · YES sellers
          </p>
          <div className="flex justify-between px-2 pb-1 text-[10px] uppercase tracking-wide text-slate-500">
            <span>Price</span><span>Size</span>
          </div>
        </div>
      </div>

      <div className="border-t border-slate-800" />

      {/* Rows */}
      <div className="flex mt-0.5">

        {/* Bids */}
        <div className="flex-1 min-w-0">
          {isLoading
            ? Array.from({ length: LEVELS }).map((_, i) => <SkeletonRow key={i} />)
            : <>
                {bids.map((lvl, i) => (
                  <div
                    key={`bid-${i}`}
                    className={`flex items-center justify-between px-2 py-[5px] rounded-sm ${
                      i === 0
                        ? 'bg-emerald-950/60 text-emerald-300 font-semibold'
                        : 'text-emerald-600 hover:bg-slate-800/40'
                    }`}
                  >
                    <span>{pct(lvl.price)}</span>
                    <span className={i === 0 ? 'text-emerald-400' : 'text-slate-500'}>
                      {usd(lvl.size)}
                    </span>
                  </div>
                ))}
                <EmptyFill count={LEVELS - bids.length} />
              </>
          }
        </div>

        <div className="w-px bg-slate-800 mx-1 self-stretch" />

        {/* Asks */}
        <div className="flex-1 min-w-0">
          {isLoading
            ? Array.from({ length: LEVELS }).map((_, i) => <SkeletonRow key={i} />)
            : <>
                {asks.map((lvl, i) => (
                  <div
                    key={`ask-${i}`}
                    className={`flex items-center justify-between px-2 py-[5px] rounded-sm ${
                      i === 0
                        ? 'bg-red-950/60 text-red-300 font-semibold'
                        : 'text-red-600 hover:bg-slate-800/40'
                    }`}
                  >
                    <span>{pct(lvl.price)}</span>
                    <span className={i === 0 ? 'text-red-400' : 'text-slate-500'}>
                      {usd(lvl.size)}
                    </span>
                  </div>
                ))}
                <EmptyFill count={LEVELS - asks.length} />
              </>
          }
        </div>
      </div>

      {/* Mid price / empty state */}
      <div className="border-t border-slate-800 mt-0.5" />
      <div className="flex items-center justify-center gap-3 py-2">
        <div className="flex-1 h-px bg-slate-800/60" />
        {isLoading ? (
          <div className="h-4 w-24 rounded bg-slate-800 animate-pulse" />
        ) : isEmpty || midPrice == null ? (
          <span className="text-slate-600 text-[11px] whitespace-nowrap">No orders</span>
        ) : (
          <span className="text-slate-200 text-sm font-semibold whitespace-nowrap">
            {(midPrice * 100).toFixed(1)}% chance
          </span>
        )}
        <div className="flex-1 h-px bg-slate-800/60" />
      </div>
    </div>
  )
}
