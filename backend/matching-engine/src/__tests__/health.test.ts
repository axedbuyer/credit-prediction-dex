import { describe, it, expect, afterEach, vi } from 'vitest'
import type http from 'http'
import type { AddressInfo } from 'net'
import {
  buildHealth, createHealthServer, startBalancePoller, parseEthToWei, formatEth,
} from '../health'
import type { HealthSources } from '../health'
import { gracefulShutdown } from '../shutdown'

const NOW = 1_700_000_000_000

function sources(over: Partial<HealthSources> = {}): HealthSources {
  return {
    startedAtMs: NOW - 60_000,
    lastCycleAt: () => NOW - 100,
    markets: () => ({ mstr: { lastCycleAt: NOW - 100, lastError: null } }),
    settlerStats: () => ({ mstr: { settled: 3, pruned: 2 } }),
    registry: () => ({ mode: 'registry' }),
    settlerWired: true,
    balanceWei: () => 10n ** 17n,
    staleMs: 2500,
    minBalanceWei: 10n ** 14n,
    now: () => NOW,
    ...over,
  }
}

describe('buildHealth', () => {
  it('reports ok with per-market stats', () => {
    const { httpStatus, body } = buildHealth(sources())
    expect(httpStatus).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.lastCycleAt).toBe(new Date(NOW - 100).toISOString())
    expect(body.settlerWired).toBe(true)
    expect(body.settlerBalanceEth).toBe('0.1')
    expect(body.settlerLowBalance).toBe(false)
    expect((body.markets as any).mstr).toMatchObject({ settledPairs: 3, prunedOrders: 2, lastError: null })
  })

  it('is stale (503) when the last cycle is older than staleMs', () => {
    const { httpStatus, body } = buildHealth(sources({ lastCycleAt: () => NOW - 2501 }))
    expect(httpStatus).toBe(503)
    expect(body.status).toBe('stale')
  })

  it('is not stale exactly at the threshold', () => {
    expect(buildHealth(sources({ lastCycleAt: () => NOW - 2500 })).httpStatus).toBe(200)
  })

  it('measures staleness from start time before the first cycle', () => {
    expect(buildHealth(sources({ lastCycleAt: () => null, startedAtMs: NOW - 1000 })).httpStatus).toBe(200)
    const r = buildHealth(sources({ lastCycleAt: () => null, startedAtMs: NOW - 10_000 }))
    expect(r.httpStatus).toBe(503)
    expect(r.body.lastCycleAt).toBeNull()
  })

  it('flags low balance without failing the check', () => {
    const { httpStatus, body } = buildHealth(sources({ balanceWei: () => 10n ** 13n }))
    expect(httpStatus).toBe(200)
    expect(body.settlerLowBalance).toBe(true)
  })

  it('null balance (unknown/RPC error/log-only) is not flagged low', () => {
    const { body } = buildHealth(sources({ balanceWei: () => null, settlerWired: false, settlerStats: () => ({}) }))
    expect(body.settlerBalanceEth).toBeNull()
    expect(body.settlerLowBalance).toBe(false)
    expect(body.settlerWired).toBe(false)
  })

  it('surfaces a market lastError', () => {
    const { body } = buildHealth(sources({
      markets: () => ({ crwv: { lastCycleAt: null, lastError: 'fetch failed' } }),
      settlerStats: () => ({}),
    }))
    expect((body.markets as any).crwv).toMatchObject({ lastError: 'fetch failed', settledPairs: 0, prunedOrders: 0 })
  })
})

describe('eth helpers', () => {
  it('parses and formats', () => {
    expect(parseEthToWei('0.0001', 0n)).toBe(10n ** 14n)
    expect(parseEthToWei('2', 0n)).toBe(2n * 10n ** 18n)
    expect(parseEthToWei('junk', 5n)).toBe(5n)
    expect(parseEthToWei(undefined, 7n)).toBe(7n)
    expect(formatEth(10n ** 14n)).toBe('0.0001')
    expect(formatEth(0n)).toBe('0')
  })
})

describe('startBalancePoller', () => {
  it('caches the balance and nulls it on RPC error', async () => {
    let fail = false
    const getBalance = vi.fn(async () => { if (fail) throw new Error('rpc'); return 5n })
    const p = startBalancePoller(getBalance, 10)
    expect(p.get()).toBeNull()
    await new Promise(r => setTimeout(r, 5))
    expect(p.get()).toBe(5n)
    fail = true
    await new Promise(r => setTimeout(r, 25))
    expect(p.get()).toBeNull()
    p.stop()
  })
})

describe('HTTP server', () => {
  let server: http.Server | undefined
  afterEach(() => new Promise<void>(r => (server ? server.close(() => r()) : r())))

  async function start(src: HealthSources): Promise<string> {
    server = createHealthServer(src)
    await new Promise<void>(r => server!.listen(0, '127.0.0.1', r))
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  it('GET /health -> 200 JSON', async () => {
    const base = await start(sources({ now: undefined, lastCycleAt: () => Date.now() }))
    const res = await fetch(`${base}/health`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/json')
    expect((await res.json()).status).toBe('ok')
  })

  it('GET /health -> 503 when stale', async () => {
    const base = await start(sources())  // fixed NOW in 2023 vs real clock irrelevant: now() is injected
    expect((await fetch(`${base}/health`)).status).toBe(200)
    server!.close()
    const base2 = await start(sources({ lastCycleAt: () => NOW - 999_999 }))
    const res = await fetch(`${base2}/health`)
    expect(res.status).toBe(503)
    expect((await res.json()).status).toBe('stale')
  })

  it('404 for other paths and methods', async () => {
    const base = await start(sources())
    expect((await fetch(`${base}/`)).status).toBe(404)
    expect((await fetch(`${base}/health/x`)).status).toBe(404)
    expect((await fetch(`${base}/health`, { method: 'POST' })).status).toBe(404)
  })
})

describe('shutdown integration', () => {
  it('closes the health server before stopping the engine', async () => {
    const order: string[] = []
    await gracefulShutdown('SIGTERM', {
      log: () => {},
      closeHealth: async () => { order.push('health') },
      stopEngine: async () => { order.push('engine') },
      exit: () => {},
      timeoutMs: 200,
    })
    expect(order).toEqual(['health', 'engine'])
  })
})
