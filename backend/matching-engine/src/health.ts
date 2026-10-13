// /health endpoint for the matching-engine (it previously had no HTTP server).
// Mirrors startHealthServer in backend/keepers/liquidator-bot.ts: tiny node:http
// server, GET /health -> JSON, everything else 404. Difference: 503 + status
// 'stale' when the match loop has not completed a cycle recently, so a plain
// curl status check catches a hung loop.
//
// The settler wallet's ETH balance is cached and refreshed in the background at
// most every BALANCE_REFRESH_MS — /health itself never awaits an RPC call.

import http from 'http'

export const BALANCE_REFRESH_MS = 60_000

export interface HealthSources {
  startedAtMs: number
  /** Last completed engine sweep (ms epoch) or null. */
  lastCycleAt: () => number | null
  markets: () => Record<string, { lastCycleAt: number | null; lastError: string | null }>
  /** Settler counters keyed by slug; empty when no settler is wired. */
  settlerStats: () => Record<string, { settled: number; pruned: number }>
  registry: () => unknown
  settlerWired: boolean
  /** Cached settler balance in wei, or null if unknown / RPC error. */
  balanceWei: () => bigint | null
  staleMs: number
  minBalanceWei: bigint
  now?: () => number
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString())

export function formatEth(wei: bigint): string {
  const whole = wei / 10n ** 18n
  const frac = (wei % 10n ** 18n).toString().padStart(18, '0').replace(/0+$/, '')
  return frac ? `${whole}.${frac}` : `${whole}`
}

/** Parses an ETH decimal string (e.g. "0.0001") into wei; falls back on bad input. */
export function parseEthToWei(v: string | undefined, fallback: bigint): bigint {
  if (!v || !/^\d+(\.\d{1,18})?$/.test(v.trim())) return fallback
  const [w, f = ''] = v.trim().split('.')
  return BigInt(w) * 10n ** 18n + BigInt(f.padEnd(18, '0'))
}

export function buildHealth(src: HealthSources): { httpStatus: 200 | 503; body: Record<string, unknown> } {
  const now = (src.now ?? Date.now)()
  const last = src.lastCycleAt()
  // Before the first cycle completes, measure staleness from process start.
  const ageMs = now - (last ?? src.startedAtMs)
  const stale = ageMs > src.staleMs

  const health = src.markets()
  const stats = src.settlerStats()
  const markets: Record<string, unknown> = {}
  for (const slug of new Set([...Object.keys(health), ...Object.keys(stats)])) {
    markets[slug] = {
      lastCycleAt: iso(health[slug]?.lastCycleAt ?? null),
      lastError: health[slug]?.lastError ?? null,
      settledPairs: stats[slug]?.settled ?? 0,
      prunedOrders: stats[slug]?.pruned ?? 0,
    }
  }

  const bal = src.balanceWei()
  const body = {
    status: stale ? 'stale' : 'ok',
    lastCycleAt: iso(last),
    lastCycleAgeMs: last === null ? null : now - last,
    staleAfterMs: src.staleMs,
    uptimeSec: Math.floor((now - src.startedAtMs) / 1000),
    settlerWired: src.settlerWired,
    settlerBalanceEth: bal === null ? null : formatEth(bal),
    settlerLowBalance: bal !== null && bal < src.minBalanceWei,
    registry: src.registry(),
    markets,
  }
  return { httpStatus: stale ? 503 : 200, body }
}

export function createHealthServer(src: HealthSources): http.Server {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      const { httpStatus, body } = buildHealth(src)
      res.writeHead(httpStatus, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
}

/**
 * Background balance cache: refresh now and then every BALANCE_REFRESH_MS.
 * Errors set the cached value to null. Timer is unref'd.
 */
export function startBalancePoller(
  getBalance: () => Promise<bigint>,
  refreshMs = BALANCE_REFRESH_MS,
): { get: () => bigint | null; stop: () => void } {
  let value: bigint | null = null
  const refresh = () => {
    getBalance().then(b => { value = b }, () => { value = null })
  }
  refresh()
  const timer = setInterval(refresh, refreshMs)
  timer.unref()
  return { get: () => value, stop: () => clearInterval(timer) }
}

export function closeHealthServer(server: http.Server): Promise<void> {
  return new Promise(resolve => {
    server.close(() => resolve())
    server.closeAllConnections?.()
  })
}
