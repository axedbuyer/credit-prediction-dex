'use client'

import { useEffect, useRef, useState } from 'react'
import { usePublicClient, useChainId } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { parseAbiItem } from 'viem'
import { CONTRACT_ADDRESSES, type SupportedChainId } from '@/lib/contracts'
import { CREDIT_MARKET_ABI } from '@/lib/creditMarketAbi'

// ── Types ────────────────────────────────────────────────────────────────────

type TimeRange = '1D' | '1W' | '1M' | 'ALL'

type PricePoint = {
  time: number  // unix seconds — Lightweight Charts UTCTimestamp
  value: number // 0–100 probability %
}

// ── Constants ─────────────────────────────────────────────────────────────────

// 'ALL' has no fixed window — it fits the chart to every point instead (see
// the zoom effect below), since the full history can span far more than a
// month (e.g. scripts/demo seeds ~13 months of simulated chart history).
const RANGE_SECONDS: Partial<Record<TimeRange, number>> = {
  '1D': 86_400,
  '1W': 604_800,
  '1M': 2_592_000,
}

// ~27h at 2s/block on Base — keeps within public RPC limits
const BLOCK_RANGE_CAP = 50_000n

const YEAR_SECONDS = 365n * 86_400n

const FUNDING_ACCRUED = parseAbiItem(
  'event FundingAccrued(uint256 cumulativeFundingPerYES, uint256 cumFundingPerNO, uint256 timestamp)'
)

// wad (1e18-scaled, 1e18 == 100%) -> percent. Bigint division happens before
// the cast to Number so precision survives values well past
// Number.MAX_SAFE_INTEGER at the 1e18 scale.
function wadToPercent(wad: bigint): number {
  return Number(wad / 10n ** 10n) / 1e6
}

// ── Component ─────────────────────────────────────────────────────────────────

interface PriceChartProps {
  marketId: string
}

export function PriceChart({ marketId }: PriceChartProps) {
  const chainId = useChainId()
  const publicClient = usePublicClient()
  const contracts = CONTRACT_ADDRESSES[chainId as SupportedChainId] ?? CONTRACT_ADDRESSES[84532]

  const [range, setRange] = useState<TimeRange>('ALL')

  const containerRef = useRef<HTMLDivElement>(null)
  // Use `any` to stay version-agnostic between LC v4 (addAreaSeries) and v5 (addSeries)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartRef  = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seriesRef = useRef<any>(null)

  // ── Fetch ──────────────────────────────────────────────────────────────────
  // Mark series derived from consecutive FundingAccrued events: between events
  // i and i+1, mark_i = (cumYES_{i+1} - cumYES_i) * 365d / (t_{i+1} - t_i).
  // A live tail point (via currentMark + latest block) keeps the chart moving
  // between accrual epochs — e.g. during a demo time-warp.

  const { data: points = [], isLoading } = useQuery<PricePoint[]>({
    queryKey: ['price-history', chainId, contracts.creditMarket, marketId],
    queryFn: async () => {
      if (!publicClient) return []

      const currentBlock = await publicClient.getBlockNumber()
      const fromBlock = currentBlock > BLOCK_RANGE_CAP ? currentBlock - BLOCK_RANGE_CAP : 0n

      const logs = await publicClient.getLogs({
        address: contracts.creditMarket,
        event: FUNDING_ACCRUED,
        fromBlock,
        toBlock: 'latest',
      })

      // Chronological order (block, then log index tie-break). The event
      // carries its own block.timestamp arg, so no per-block RPC lookup needed.
      const sorted = [...logs].sort((a, b) => {
        if (a.blockNumber !== b.blockNumber) return a.blockNumber! < b.blockNumber! ? -1 : 1
        return (a.logIndex ?? 0) - (b.logIndex ?? 0)
      })

      const events = sorted.map((l) => ({
        cumYES: l.args.cumulativeFundingPerYES!,
        ts: Number(l.args.timestamp!),
      }))

      const derived: PricePoint[] = []
      for (let i = 0; i < events.length - 1; i++) {
        const dt = events[i + 1].ts - events[i].ts
        if (dt === 0) continue // skip same-block duplicate accruals
        const deltaCum = events[i + 1].cumYES - events[i].cumYES
        const markWad = (deltaCum * YEAR_SECONDS) / BigInt(dt)
        derived.push({ time: events[i].ts, value: wadToPercent(markWad) })
      }

      // Live tail point at the current mark / latest block timestamp.
      try {
        const [mark, block] = await Promise.all([
          publicClient.readContract({
            address: contracts.creditMarket,
            abi: CREDIT_MARKET_ABI,
            functionName: 'currentMark',
          }),
          publicClient.getBlock(),
        ])
        derived.push({ time: Number(block.timestamp), value: wadToPercent(mark as bigint) })
      } catch {
        // no-op — fall back to whatever derived history we have
      }

      return derived
        .sort((a, b) => a.time - b.time)
        // Dedupe by time (LC requires unique ascending timestamps)
        .filter((p, i, arr) => i === 0 || p.time !== arr[i - 1].time)
    },
    refetchInterval: 30_000,
    enabled: !!publicClient,
    retry: false,
    throwOnError: false,
  })

  // ── Mount chart (client-only) ──────────────────────────────────────────────

  useEffect(() => {
    if (!containerRef.current) return
    let aborted = false

    // Dynamic import keeps the heavy LC bundle out of SSR
    import('lightweight-charts').then(({ createChart, ColorType, AreaSeries }) => {
      if (aborted || !containerRef.current) return

      // Resolve token colors at mount — Lightweight Charts renders to canvas
      // and cannot read CSS custom properties itself, so these read the
      // computed value once and pass literal colors into the JS options.
      const styles = getComputedStyle(document.documentElement)
      const teal      = styles.getPropertyValue('--color-teal-400').trim()   || '#00C4B4'
      const tealFill  = styles.getPropertyValue('--color-teal-a16').trim()   || 'rgba(0, 196, 180, 0.16)'
      const tealFaint = styles.getPropertyValue('--color-teal-a10').trim()   || 'rgba(0, 196, 180, 0.08)'
      const textMuted = styles.getPropertyValue('--color-text-muted').trim() || '#7A8499'

      const chart = createChart(containerRef.current, {
        layout: {
          background: { type: ColorType.Solid, color: 'transparent' },
          textColor: textMuted,
          fontFamily: 'Barlow, system-ui, -apple-system, sans-serif',
          fontSize: 11,
        },
        grid: {
          vertLines: { color: tealFaint },
          horzLines: { color: tealFaint },
        },
        rightPriceScale: {
          borderColor: tealFaint,
          scaleMargins: { top: 0.12, bottom: 0.08 },
        },
        timeScale: {
          borderColor: tealFaint,
          timeVisible: true,
          secondsVisible: false,
          fixLeftEdge: false,
          fixRightEdge: false,
        },
        crosshair: {
          vertLine: { color: teal, width: 1 as const, style: 2 },
          horzLine: { color: teal, width: 1 as const, style: 2 },
        },
        handleScroll: true,
        handleScale: true,
        autoSize: true,
      })

      const series = chart.addSeries(AreaSeries, {
        lineColor: teal,
        topColor: tealFill,
        bottomColor: 'rgba(0, 196, 180, 0.02)',
        lineWidth: 2 as const,
        priceLineVisible: false,
        lastValueVisible: false,
      })

      series.applyOptions({
        priceFormat: {
          type: 'custom',
          formatter: (p: number) => `${p.toFixed(1)}%`,
          minMove: 0.1,
        },
      })

      chartRef.current  = chart
      seriesRef.current = series
    })

    return () => {
      aborted = true
      chartRef.current?.remove()
      chartRef.current  = null
      seriesRef.current = null
    }
  }, [])

  // ── Sync data ──────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!seriesRef.current) return
    seriesRef.current.setData(points)
    if (points.length > 0 && chartRef.current) {
      chartRef.current.timeScale().fitContent()
    }
  }, [points])

  // ── Apply time range zoom ──────────────────────────────────────────────────

  useEffect(() => {
    if (!chartRef.current || points.length === 0) return
    // Anchor "now" to the latest data point's (chain) timestamp, not real
    // wall-clock Date.now(). On a chain whose time has been fast-forwarded
    // (scripts/demo's warp.sh jumps chain time ~13 months ahead to seed
    // chart history), using real time here would put every zoom window in
    // the past relative to the data — 1D/1W/1M would show only the sliver
    // of history recorded before the first warp, never the seeded climb.
    // In production, chain time tracks real time anyway, so this is a no-op.
    if (range === 'ALL') {
      chartRef.current.timeScale().fitContent()
      return
    }
    const now = points[points.length - 1].time
    chartRef.current.timeScale().setVisibleRange({
      from: now - RANGE_SECONDS[range]!,
      to: now,
    })
  }, [range, points])

  // ── Derived display ────────────────────────────────────────────────────────

  const latestPrice = points.at(-1)?.value
  const isEmpty = !isLoading && points.length === 0

  return (
    <div>
      {/* Price label + range toggle */}
      <div className="flex items-center justify-between mb-3">
        <div className="min-h-[28px]">
          {isLoading ? (
            <div className="h-5 w-48 rounded bg-surface-2 animate-pulse" />
          ) : latestPrice != null ? (
            <p className="font-serif text-xl text-text-1 tabular">
              {latestPrice.toFixed(1)}%{' '}
              <span className="font-sans text-xs uppercase tracking-widest text-text-muted">
                annual probability
              </span>
            </p>
          ) : null}
        </div>

        <div className="flex gap-1">
          {(['1D', '1W', '1M', 'ALL'] as TimeRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={
                range === r
                  ? 'pari-b-btn pari-b-btn--secondary'
                  : 'pari-b-btn bg-transparent text-text-muted hover:text-teal'
              }
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {/* Chart area */}
      <div className="relative h-[240px]">
        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <div className="h-3 w-40 rounded bg-surface-2 animate-pulse" />
              <div className="h-3 w-24 rounded bg-surface-2 animate-pulse" />
            </div>
          </div>
        )}
        {isEmpty && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-xs uppercase tracking-widest text-text-muted">
              No price history yet
            </p>
          </div>
        )}
        <div
          ref={containerRef}
          className="h-full w-full"
          style={{ visibility: isEmpty || isLoading ? 'hidden' : 'visible' }}
        />
      </div>
    </div>
  )
}
