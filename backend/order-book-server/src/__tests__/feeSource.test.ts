import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FeeSource, type IFeeBpsReader } from '../feeSource'

// ─── Test helpers ──────────────────────────────────────────────────────────────

function mockReader(impl: () => Promise<bigint>): IFeeBpsReader & { calls: number } {
  const obj = {
    calls: 0,
    getFeeBps: async () => {
      obj.calls += 1
      return impl()
    },
  }
  return obj
}

function silentLogger() {
  return { warn: vi.fn(), error: vi.fn(), log: vi.fn() }
}

describe('FeeSource', () => {
  let feeSource: FeeSource | undefined

  afterEach(async () => {
    feeSource?.stop()
    feeSource = undefined
    vi.useRealTimers()
  })

  it('resolves from chain on a successful read and reports source=chain', async () => {
    const reader = mockReader(async () => 75n)
    const logger = silentLogger()
    feeSource = new FeeSource({ envFeeBps: 50, envFeeBpsWasSet: false, reader, refreshMs: 0, logger })

    await feeSource.start()

    expect(feeSource.getFeeBps()).toBe(75)
    expect(feeSource.getSnapshot()).toMatchObject({ feeBps: 75, source: 'chain' })
    expect(feeSource.getSnapshot().lastRefreshAt).not.toBeNull()
  })

  it('chain succeeds but FEE_BPS was also set and differs → chain value wins, with a warning logged', async () => {
    const reader = mockReader(async () => 75n)
    const logger = silentLogger()
    feeSource = new FeeSource({ envFeeBps: 50, envFeeBpsWasSet: true, reader, refreshMs: 0, logger })

    await feeSource.start()

    expect(feeSource.getFeeBps()).toBe(75)
    expect(feeSource.getSnapshot().source).toBe('chain')
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('chain value wins'))
  })

  it('does not warn about a mismatch when the resolved chain value equals FEE_BPS', async () => {
    const reader = mockReader(async () => 50n)
    const logger = silentLogger()
    feeSource = new FeeSource({ envFeeBps: 50, envFeeBpsWasSet: true, reader, refreshMs: 0, logger })

    await feeSource.start()

    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('falls back to FEE_BPS when the chain read fails, logging loudly', async () => {
    const reader = mockReader(async () => { throw new Error('RPC down') })
    const logger = silentLogger()
    feeSource = new FeeSource({ envFeeBps: 50, envFeeBpsWasSet: false, reader, refreshMs: 0, logger })

    await feeSource.start()

    expect(feeSource.getFeeBps()).toBe(50)
    expect(feeSource.getSnapshot().source).toBe('env-fallback')
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('falling back to'), expect.anything(),
    )
  })

  it('uses FEE_BPS with source=env-fallback when no reader/address is configured', async () => {
    const logger = silentLogger()
    feeSource = new FeeSource({ envFeeBps: 50, envFeeBpsWasSet: false, reader: undefined, refreshMs: 0, logger })

    await feeSource.start()

    expect(feeSource.getFeeBps()).toBe(50)
    expect(feeSource.getSnapshot().source).toBe('env-fallback')
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no CLOB_SETTLEMENT_ADDRESS/RPC configured'))
  })

  it('start() never throws even when the underlying reader rejects', async () => {
    const reader = mockReader(async () => { throw new Error('boom') })
    feeSource = new FeeSource({ envFeeBps: 50, envFeeBpsWasSet: false, reader, refreshMs: 0, logger: silentLogger() })

    await expect(feeSource.start()).resolves.toBeUndefined()
  })

  it('rejects an out-of-range chain value (>500) and keeps the previous value', async () => {
    const reader = mockReader(async () => 999n)
    const logger = silentLogger()
    feeSource = new FeeSource({ envFeeBps: 50, envFeeBpsWasSet: false, reader, refreshMs: 0, logger })

    await feeSource.start()

    // Initial read was invalid → stays on the env fallback (no valid chain value seen yet).
    expect(feeSource.getFeeBps()).toBe(50)
    expect(feeSource.getSnapshot().source).toBe('env-fallback')
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('out of range'))
  })

  it('rejects a negative chain value the same way as out-of-range', async () => {
    const reader = mockReader(async () => -1n)
    const logger = silentLogger()
    feeSource = new FeeSource({ envFeeBps: 50, envFeeBpsWasSet: false, reader, refreshMs: 0, logger })

    await feeSource.start()

    expect(feeSource.getFeeBps()).toBe(50)
    expect(feeSource.getSnapshot().source).toBe('env-fallback')
  })

  describe('periodic refresh (fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers()
    })

    it('refreshes on the configured interval and picks up a changed on-chain value', async () => {
      let value = 50n
      const reader = mockReader(async () => value)
      const logger = silentLogger()
      feeSource = new FeeSource({ envFeeBps: 50, envFeeBpsWasSet: false, reader, refreshMs: 1_000, logger })

      await feeSource.start()
      expect(feeSource.getFeeBps()).toBe(50)

      value = 80n
      await vi.advanceTimersByTimeAsync(1_000)

      expect(feeSource.getFeeBps()).toBe(80)
      expect(feeSource.getSnapshot().source).toBe('chain')
    })

    it('a failed refresh keeps the last good value (does not flap to the env fallback)', async () => {
      let shouldFail = false
      const reader = mockReader(async () => {
        if (shouldFail) throw new Error('RPC blip')
        return 80n
      })
      const logger = silentLogger()
      feeSource = new FeeSource({ envFeeBps: 50, envFeeBpsWasSet: false, reader, refreshMs: 1_000, logger })

      await feeSource.start()
      expect(feeSource.getFeeBps()).toBe(80)

      shouldFail = true
      await vi.advanceTimersByTimeAsync(1_000)

      // Still 80 (last good chain value), NOT 50 (the env fallback) — a transient
      // RPC blip must never regress a previously-good chain value.
      expect(feeSource.getFeeBps()).toBe(80)
      expect(feeSource.getSnapshot().source).toBe('chain')
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('refresh failed — keeping last good value'), expect.anything(),
      )
    })

    it('FEE_REFRESH_MS=0 disables the periodic timer (only the one-shot startup read runs)', async () => {
      const reader = mockReader(async () => 75n)
      const logger = silentLogger()
      feeSource = new FeeSource({ envFeeBps: 50, envFeeBpsWasSet: false, reader, refreshMs: 0, logger })

      await feeSource.start()
      expect(reader.calls).toBe(1)

      await vi.advanceTimersByTimeAsync(10 * 60_000) // way past any real interval

      expect(reader.calls).toBe(1) // no further reads — timer never registered
      expect(feeSource.getFeeBps()).toBe(75)
    })

    it('stop() clears the timer so no further reads happen', async () => {
      const reader = mockReader(async () => 75n)
      feeSource = new FeeSource({ envFeeBps: 50, envFeeBpsWasSet: false, reader, refreshMs: 1_000, logger: silentLogger() })

      await feeSource.start()
      expect(reader.calls).toBe(1)

      feeSource.stop()
      await vi.advanceTimersByTimeAsync(10_000)

      expect(reader.calls).toBe(1) // stopped — no leaked timers/reads
    })
  })
})
