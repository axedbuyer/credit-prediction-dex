import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { installShutdownHandlers, defaultShutdownTimeoutMs } from '../shutdown'

describe('installShutdownHandlers', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('runs steps in order and exits 0 on success', async () => {
    const order: string[] = []
    const exit = vi.fn()
    const { shutdown } = installShutdownHandlers('svc', [
      { name: 'a', run: async () => { order.push('a') } },
      { name: 'b', run: async () => { order.push('b') } },
      { name: 'c', run: async () => { order.push('c') } },
    ], { exit, signals: [] })

    await shutdown('SIGTERM')

    expect(order).toEqual(['a', 'b', 'c'])
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('logs and continues past a failing step, still running the rest', async () => {
    const order: string[] = []
    const exit = vi.fn()
    const logger = { log: vi.fn(), error: vi.fn() }
    const { shutdown } = installShutdownHandlers('svc', [
      { name: 'a', run: async () => { order.push('a') } },
      { name: 'b', run: async () => { throw new Error('boom') } },
      { name: 'c', run: async () => { order.push('c') } },
    ], { exit, signals: [], logger })

    await shutdown('SIGTERM')

    expect(order).toEqual(['a', 'c'])
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('shutdown step "b" failed'),
      expect.any(Error),
    )
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('respects the timeout: logs pending step names and exits 1 without waiting for a hung step', async () => {
    const exit = vi.fn()
    const logger = { log: vi.fn(), error: vi.fn() }
    let releaseHung: (() => void) | undefined
    const hung = new Promise<void>(resolve => { releaseHung = resolve })

    installShutdownHandlers('svc', [
      { name: 'quick', run: async () => {} },
      { name: 'hung', run: () => hung },
      { name: 'never-reached', run: async () => {} },
    ], { exit, signals: [], timeoutMs: 5_000, logger }).shutdown('SIGTERM')

    // Let the "quick" step and the microtask queue settle before advancing the clock.
    await vi.advanceTimersByTimeAsync(0)
    expect(exit).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(5_000)

    expect(exit).toHaveBeenCalledWith(1)
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('shutdown timed out after 5000ms'),
    )
    expect(logger.error.mock.calls.some(c => String(c[0]).includes('hung'))).toBe(true)
    releaseHung?.()
  })

  it('a second signal forces immediate exit(1) instead of re-running steps', async () => {
    const exit = vi.fn()
    const run = vi.fn().mockResolvedValue(undefined)
    const { shutdown } = installShutdownHandlers('svc', [
      { name: 'a', run },
    ], { exit, signals: [] })

    const first = shutdown('SIGTERM')
    // Fire a second signal while the first is (conceptually) still in flight.
    await shutdown('SIGTERM')
    await first

    expect(exit).toHaveBeenCalledWith(1)
    // The step only ever ran once — the second call short-circuited.
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('the timeout timer is unref\'d so it cannot keep the process alive by itself', async () => {
    const exit = vi.fn()
    const unref = vi.fn()
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      return { unref, hasRef: () => false } as unknown as ReturnType<typeof setTimeout>
    }) as typeof setTimeout)

    const { shutdown } = installShutdownHandlers('svc', [
      { name: 'a', run: async () => {} },
    ], { exit, signals: [] })

    await shutdown('SIGTERM')

    expect(unref).toHaveBeenCalled()
    setTimeoutSpy.mockRestore()
  })
})

describe('defaultShutdownTimeoutMs', () => {
  it('defaults to 25000 when unset', () => {
    expect(defaultShutdownTimeoutMs({} as NodeJS.ProcessEnv)).toBe(25_000)
  })

  it('defaults to 25000 for blank/invalid/negative values', () => {
    expect(defaultShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '' } as NodeJS.ProcessEnv)).toBe(25_000)
    expect(defaultShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '  ' } as NodeJS.ProcessEnv)).toBe(25_000)
    expect(defaultShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: 'abc' } as NodeJS.ProcessEnv)).toBe(25_000)
    expect(defaultShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '-5' } as NodeJS.ProcessEnv)).toBe(25_000)
  })

  it('parses a valid override', () => {
    expect(defaultShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '5000' } as NodeJS.ProcessEnv)).toBe(5_000)
  })
})
