import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import http from 'http'
import { installShutdownHandlers, defaultShutdownTimeoutMs, closeHttpServer } from '../shutdown'

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
    ], { exit, signals: [] })

    await shutdown('SIGTERM')

    expect(order).toEqual(['a', 'b'])
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('logs and continues past a failing step', async () => {
    const order: string[] = []
    const exit = vi.fn()
    const logger = { log: vi.fn(), error: vi.fn() }
    const { shutdown } = installShutdownHandlers('svc', [
      { name: 'a', run: async () => { throw new Error('boom') } },
      { name: 'b', run: async () => { order.push('b') } },
    ], { exit, signals: [], logger })

    await shutdown('SIGTERM')

    expect(order).toEqual(['b'])
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('shutdown step "a" failed'),
      expect.any(Error),
    )
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('respects the timeout and exits 1 without waiting for a hung step', async () => {
    const exit = vi.fn()
    const logger = { log: vi.fn(), error: vi.fn() }
    let release: (() => void) | undefined
    const hung = new Promise<void>(resolve => { release = resolve })

    installShutdownHandlers('svc', [
      { name: 'hung', run: () => hung },
    ], { exit, signals: [], timeoutMs: 1_000, logger }).shutdown('SIGTERM')

    await vi.advanceTimersByTimeAsync(1_000)

    expect(exit).toHaveBeenCalledWith(1)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('shutdown timed out'))
    release?.()
  })

  it('a second signal forces immediate exit(1)', async () => {
    const exit = vi.fn()
    const run = vi.fn().mockResolvedValue(undefined)
    const { shutdown } = installShutdownHandlers('svc', [{ name: 'a', run }], { exit, signals: [] })

    const first = shutdown('SIGTERM')
    await shutdown('SIGTERM')
    await first

    expect(exit).toHaveBeenCalledWith(1)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('defaultShutdownTimeoutMs', () => {
  it('defaults to 25000 for unset/blank/invalid values', () => {
    expect(defaultShutdownTimeoutMs({} as NodeJS.ProcessEnv)).toBe(25_000)
    expect(defaultShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: 'abc' } as NodeJS.ProcessEnv)).toBe(25_000)
    expect(defaultShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '-1' } as NodeJS.ProcessEnv)).toBe(25_000)
  })

  it('parses a valid override', () => {
    expect(defaultShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: '5000' } as NodeJS.ProcessEnv)).toBe(5_000)
  })
})

describe('closeHttpServer', () => {
  it('resolves once the server has closed', async () => {
    const server = http.createServer()
    await new Promise<void>(resolve => server.listen(0, resolve))

    await expect(closeHttpServer(server)).resolves.toBeUndefined()
    expect(server.listening).toBe(false)
  })
})
