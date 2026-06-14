'use client'

import { useEffect, useRef, useState } from 'react'
import { usePublicClient, useChainId } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { parseAbiItem } from 'viem'
import { CONTRACT_ADDRESSES, type SupportedChainId } from '@/lib/contracts'

// ── Types ────────────────────────────────────────────────────────────────────

type TimeRange = '1D' | '1W' | '1M'

type PricePoint = {
  time: number  // unix seconds — Lightweight Charts UTCTimestamp
  value: number // 0–100 probability %
}

// ── Constants ─────────────────────────────────────────────────────────────────

const RANGE_SECONDS: Record<TimeRange, number> = {
  '1D': 86_400,
  '1W': 604_800,
  '1M': 2_592_000,
}

// ~27h at 2s/block on Base — keeps within public RPC limits
const BLOCK_RANGE_CAP = 50_000n

const TOKENS_MINTED = parseAbiItem(
  'event TokensMinted(address indexed user, uint256 usdcAmount, uint256 yesAmount, uint256 noAmount)'
)

// ── Chart theme ───────────────────────────────────────────────────────────────

const CHART_OPTS = {
  layout: {
    background: { color: 'transparent' },
    textColor: '#94a3b8',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontSize: 11,
  },
  grid: {
    vertLines: { color: '#1e293b' },
    horzLines: { color: '#1e293b' },
  },
  rightPriceScale: {
    borderColor: '#1e293b',
    scaleMargins: { top: 0.12, bottom: 0.08 },
  },
  timeScale: {
    borderColor: '#1e293b',
    timeVisible: true,
    secondsVisible: false,
    fixLeftEdge: false,
    fixRightEdge: false,
  },
  crosshair: {
    vertLine: { color: '#475569', width: 1 as const, style: 2 },
    horzLine: { color: '#475569', width: 1 as const, style: 2 },
  },
  handleScroll: true,
  handleScale: true,
} as const

const AREA_OPTS = {
  lineColor: '#3b82f6',
  topColor: 'rgba(59,130,246,0.25)',
  bottomColor: 'rgba(59,130,246,0.02)',
  lineWidth: 2 as const,
  priceLineVisible: false,
  lastValueVisible: false,
}

// ── Component ─────────────────────────────────────────────────────────────────

interface PriceChartProps {
  marketId: string
}

export function PriceChart({ marketId }: PriceChartProps) {
  const chainId = useChainId()
  const publicClient = usePublicClient()
  const contracts = CONTRACT_ADDRESSES[chainId as SupportedChainId] ?? CONTRACT_ADDRESSES[84532]

  const [range, setRange] = useState<TimeRange>('1W')

  const containerRef = useRef<HTMLDivElement>(null)
  // Use `any` to stay version-agnostic between LC v4 (addAreaSeries) and v5 (addSeries)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartRef  = useRef<any>(null)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const seriesRef = useRef<any>(null)

  // ── Fetch ──────────────────────────────────────────────────────────────────

  const { data: points = [], isLoading } = useQuery<PricePoint[]>({
    queryKey: ['price-history', chainId, contracts.creditMarket, marketId],
    queryFn: async () => {
      if (!publicClient) return []

      const currentBlock = await publicClient.getBlockNumber()
      const fromBlock = currentBlock > BLOCK_RANGE_CAP ? currentBlock - BLOCK_RANGE_CAP : 0n

      const logs = await publicClient.getLogs({
        address: contracts.creditMarket,
        event: TOKENS_MINTED,
        fromBlock,
        toBlock: 'latest',
      })

      if (logs.length === 0) return []

      // Fetch timestamps for each unique block in one pass
      const blockNums = [...new Set(logs.map((l) => l.blockNumber!))]
      const blocks = await Promise.all(
        blockNums.map((n) => publicClient.getBlock({ blockNumber: n }))
      )
      const tsMap = new Map(blocks.map((b) => [b.number, Number(b.timestamp)]))

      return logs
        .filter((l) => l.args.usdcAmount && l.args.usdcAmount > 0n)
        .map((l) => ({
          time: tsMap.get(l.blockNumber!) ?? 0,
          value: (Number(l.args.yesAmount!) / Number(l.args.usdcAmount!)) * 100,
        }))
        .filter((p) => p.time > 0)
        .sort((a, b) => a.time - b.time)
        // Dedupe by time (LC requires unique timestamps)
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

      const chart = createChart(containerRef.current, {
        ...CHART_OPTS,
        layout: {
          ...CHART_OPTS.layout,
          background: { type: ColorType.Solid, color: 'transparent' },
        },
        autoSize: true,
      })

      const series = chart.addSeries(AreaSeries, AREA_OPTS)

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
    const now = Math.floor(Date.now() / 1000)
    chartRef.current.timeScale().setVisibleRange({
      from: now - RANGE_SECONDS[range],
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
            <div className="h-5 w-48 rounded bg-slate-800 animate-pulse" />
          ) : latestPrice != null ? (
            <p className="text-xl font-bold text-slate-100">
              {latestPrice.toFixed(1)}%{' '}
              <span className="text-sm font-normal text-slate-400">
                annual default probability
              </span>
            </p>
          ) : null}
        </div>

        <div className="flex gap-1">
          {(['1D', '1W', '1M'] as TimeRange[]).map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                range === r
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
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
              <div className="h-3 w-40 rounded bg-slate-800 animate-pulse" />
              <div className="h-3 w-24 rounded bg-slate-800 animate-pulse" />
            </div>
          </div>
        )}
        {isEmpty && (
          <div className="absolute inset-0 flex items-center justify-center">
            <p className="text-slate-500 text-sm">No price history yet</p>
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
