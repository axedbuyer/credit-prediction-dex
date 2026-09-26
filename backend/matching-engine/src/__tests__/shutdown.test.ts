import { describe, it, expect, vi } from 'vitest'
import { gracefulShutdown, createShutdownHandler } from '../shutdown'
import type { ShutdownDeps } from '../shutdown'

function sleep(ms: number) {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

function baseDeps(overrides: Partial<ShutdownDeps> = {}): ShutdownDeps & {
  logs: string[]
  exitCalls: number[]
} {
  const logs: string[] = []
  const exitCalls: number[] = []
  return {
    log: (msg: string) => logs.push(msg),
    stopEngine: async () => {},
    exit: (code: number) => exitCalls.push(code),
    timeoutMs: 200,
    ...overrides,
    logs,
    exitCalls,
  }
}

describe('gracefulShutdown', () => {
  it('logs the drain message, stops the engine, drains the settler, closes redis, and exits 0', async () => {
    const order: string[] = []
    const deps = baseDeps({
      stopEngine: async () => { order.push('stopEngine') },
      drainSettler: async () => { order.push('drainSettler') },
      closeRedis: async () => { order.push('closeRedis') },
    })

    await gracefulShutdown('SIGTERM', deps)

    expect(deps.logs[0]).toBe('[matching-engine] SIGTERM received — draining')
    expect(order).toEqual(['stopEngine', 'drainSettler', 'closeRedis'])
    expect(deps.exitCalls).toEqual([0])
    expect(deps.logs.some(l => l.includes('drained — exiting'))).toBe(true)
  })

  it('skips drainSettler/closeRedis when not provided (log-only settler mode) and still exits 0', async () => {
    const deps = baseDeps()
    await gracefulShutdown('SIGINT', deps)
    expect(deps.exitCalls).toEqual([0])
  })

  it('respects the timeout and reports pending work, exiting 1', async () => {
    let releaseStop: (() => void) | undefined
    const deps = baseDeps({
      timeoutMs: 30,
      stopEngine: () => new Promise(resolve => { releaseStop = resolve }),
      drainSettler: async () => {},
      describePending: () => 'maker=ask1 taker=bid1 tx=0xdeadbeef',
    })

    await gracefulShutdown('SIGTERM', deps)

    expect(deps.exitCalls).toEqual([1])
    expect(deps.logs.some(l =>
      l.includes('shutdown timed out') && l.includes('maker=ask1 taker=bid1 tx=0xdeadbeef'),
    )).toBe(true)

    // Clean up the dangling promise so it doesn't leak into other tests.
    releaseStop?.()
  })

  it('on timeout with no pending description available, logs that nothing was reported pending', async () => {
    const deps = baseDeps({
      timeoutMs: 30,
      stopEngine: () => new Promise(() => { /* never resolves */ }),
    })

    await gracefulShutdown('SIGTERM', deps)

    expect(deps.exitCalls).toEqual([1])
    expect(deps.logs.some(l => l.includes('no settlement was reported pending'))).toBe(true)
  })

  it('does not double-exit when stopEngine resolves shortly after the timeout already fired', async () => {
    let releaseStop: (() => void) | undefined
    const deps = baseDeps({
      timeoutMs: 20,
      stopEngine: () => new Promise(resolve => { releaseStop = resolve }),
    })

    await gracefulShutdown('SIGTERM', deps)
    expect(deps.exitCalls).toEqual([1])  // timed out first

    releaseStop!()
    await sleep(30)
    expect(deps.exitCalls).toEqual([1])  // still just the one exit(1) — no exit(0) sneaking in after
  })

  it('exits 1 (without a second exit) when a drain step throws before the timeout', async () => {
    const deps = baseDeps({
      timeoutMs: 5000,
      stopEngine: async () => { throw new Error('boom') },
    })

    await gracefulShutdown('SIGTERM', deps)

    expect(deps.exitCalls).toEqual([1])
    expect(deps.logs.some(l => l.includes('error while draining') && l.includes('boom'))).toBe(true)
  })
})

describe('createShutdownHandler', () => {
  it('runs the drain sequence on the first signal', async () => {
    const deps = baseDeps({
      drainSettler: async () => {},
      closeRedis: async () => {},
    })
    const handler = createShutdownHandler(deps)

    handler('SIGTERM')
    await sleep(20)

    expect(deps.exitCalls).toEqual([0])
  })

  it('a second signal forces an immediate exit(1) instead of starting a second drain', async () => {
    let stopCalls = 0
    let releaseStop: (() => void) | undefined
    const deps = baseDeps({
      // First drain never finishes on its own within the test — lets us prove
      // the second signal doesn't wait for it and doesn't run stopEngine again.
      stopEngine: () => {
        stopCalls++
        return new Promise(resolve => { releaseStop = resolve })
      },
      timeoutMs: 5000,
    })
    const handler = createShutdownHandler(deps)

    handler('SIGTERM')
    await sleep(10)  // let the first drain start and enter stopEngine()

    handler('SIGTERM')  // second signal — must force exit(1) synchronously, not re-drain

    expect(stopCalls).toBe(1)
    expect(deps.exitCalls).toEqual([1])
    expect(deps.logs.some(l => l.includes('received again — forcing exit'))).toBe(true)

    // Deliberately leave the first drain's stopEngine() unresolved — it has no
    // timer of its own, so it can't leak into other tests; releasing it here
    // would let the backgrounded drain reach exit(0) after this test's
    // assertions already ran (harmless, but noisy — see the timeout-race
    // tests above for that exact "background finishes after timeout" case).
    void releaseStop
  })
})
