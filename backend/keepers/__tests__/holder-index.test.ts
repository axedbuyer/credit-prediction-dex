import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Address } from 'viem'
import {
  HolderIndex,
  MemoryHolderStore,
  RedisHolderStore,
  createHolderIndex,
  TRANSFER_EVENT,
  type ILogClient,
  type HolderIndexConfig,
} from '../holder-index'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TOKEN = '0x1111111111111111111111111111111111111111' as Address
const HOLDER_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as Address
const HOLDER_B = '0xBbBbBBbbbBBBbBbBbbBbbbbBbBbbbbbBBbBbbBb' as Address
const HOLDER_C = '0xCcccccccccccccccccccccccccccccccccccccc' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address

type LogEntry = { from?: Address; to?: Address; value?: bigint }
type GetLogsArgs = { address: Address; event: typeof TRANSFER_EVENT; fromBlock: bigint; toBlock: bigint }

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

// Flushes pending microtasks (and one macrotask tick) so any synchronously-kicked-off
// async work has a chance to run before we assert on call counts.
async function flush(): Promise<void> {
  await new Promise<void>(r => setImmediate(r))
}

/** Fake ILogClient: records every requested range, returns logs from a block->entries map. */
class FakeLogClient implements ILogClient {
  head: bigint
  readonly calls: Array<{ fromBlock: bigint; toBlock: bigint }> = []
  blockNumberCalls = 0
  private override: ((args: GetLogsArgs) => Promise<ReadonlyArray<{ args: LogEntry }>>) | null = null

  constructor(private readonly logs: Map<bigint, LogEntry[]> = new Map(), head: bigint = 0n) {
    this.head = head
  }

  setOverride(fn: typeof this.override) { this.override = fn }

  async getBlockNumber(): Promise<bigint> {
    this.blockNumberCalls++
    return this.head
  }

  async getLogs(args: GetLogsArgs): Promise<ReadonlyArray<{ args: LogEntry }>> {
    this.calls.push({ fromBlock: args.fromBlock, toBlock: args.toBlock })
    if (this.override) return this.override(args)
    const out: Array<{ args: LogEntry }> = []
    for (const [block, entries] of this.logs) {
      if (block >= args.fromBlock && block <= args.toBlock) {
        for (const e of entries) out.push({ args: e })
      }
    }
    return out
  }
}

function baseConfig(overrides: Partial<HolderIndexConfig> = {}): HolderIndexConfig {
  return { tokenAddress: TOKEN, fromBlock: 0n, ...overrides }
}

/** Asserts that `calls` exactly tile [from, to] inclusive with each range <= chunkSize, no gaps/overlaps. */
function assertTiles(calls: Array<{ fromBlock: bigint; toBlock: bigint }>, from: bigint, to: bigint, chunkSize: bigint) {
  expect(calls.length).toBeGreaterThan(0)
  expect(calls[0].fromBlock).toBe(from)
  expect(calls[calls.length - 1].toBlock).toBe(to)
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]
    expect(c.toBlock).toBeGreaterThanOrEqual(c.fromBlock)
    expect(c.toBlock - c.fromBlock + 1n).toBeLessThanOrEqual(chunkSize)
    if (i > 0) expect(c.fromBlock).toBe(calls[i - 1].toBlock + 1n) // no gap, no overlap
  }
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// ─── 1. Address collection invariants ─────────────────────────────────────────

describe('HolderIndex — address collection', () => {
  it('adds every non-zero `to`, lowercased and deduped; never adds `from`; never adds burns (to=0)', async () => {
    const logs = new Map<bigint, LogEntry[]>([
      [0n, [
        { from: ZERO, to: HOLDER_A, value: 1n },              // mint to A
        { from: HOLDER_A, to: HOLDER_B, value: 1n },           // A -> B (A must NOT be added via `from`)
        { from: HOLDER_B, to: ZERO, value: 1n },               // burn (to=0, must NOT be added)
        { from: HOLDER_C, to: (HOLDER_A.toLowerCase() as Address), value: 1n }, // dup of A, mixed case
      ]],
    ])
    const client = new FakeLogClient(logs, 0n)
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig())

    await index.sync()

    const holders = index.holders().sort()
    expect(holders).toEqual([HOLDER_A.toLowerCase(), HOLDER_B.toLowerCase()].sort())
    expect(holders).not.toContain(HOLDER_C.toLowerCase()) // C only ever appears as `from`
    expect(holders).not.toContain(ZERO)
  })
})

// ─── 2. Seed holders ──────────────────────────────────────────────────────────

describe('HolderIndex — seed holders', () => {
  it('are included (lowercased) before any sync', () => {
    const client = new FakeLogClient(new Map(), 0n)
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig({
      seedHolders: [HOLDER_A, HOLDER_B.toLowerCase()],
    }))

    expect(index.holders().sort()).toEqual([HOLDER_A.toLowerCase(), HOLDER_B.toLowerCase()].sort())
    expect(client.calls.length).toBe(0) // no sync happened yet
  })

  it('survive alongside discovered holders after sync', async () => {
    const logs = new Map<bigint, LogEntry[]>([[0n, [{ to: HOLDER_C, value: 1n }]]])
    const client = new FakeLogClient(logs, 0n)
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig({ seedHolders: [HOLDER_A] }))

    await index.sync()

    expect(index.holders().sort()).toEqual(
      [HOLDER_A.toLowerCase(), HOLDER_C.toLowerCase()].sort(),
    )
  })
})

// ─── 3. Chunk tiling ──────────────────────────────────────────────────────────

describe('HolderIndex — chunk tiling', () => {
  it('H == F: a single one-block range', async () => {
    const client = new FakeLogClient(new Map(), 5n)
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig({ fromBlock: 5n, chunkSize: 1000n, concurrency: 4 }))

    await index.sync()

    expect(client.calls).toEqual([{ fromBlock: 5n, toBlock: 5n }])
  })

  it('(H-F+1) an exact multiple of chunkSize', async () => {
    const client = new FakeLogClient(new Map(), 2999n) // 3000 blocks, chunkSize 1000 -> 3 chunks
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig({ fromBlock: 0n, chunkSize: 1000n, concurrency: 10 }))

    await index.sync()

    assertTiles(client.calls, 0n, 2999n, 1000n)
    expect(client.calls.length).toBe(3)
  })

  it('(H-F+1) NOT a multiple of chunkSize — last chunk is partial', async () => {
    const client = new FakeLogClient(new Map(), 2500n)
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig({ fromBlock: 0n, chunkSize: 1000n, concurrency: 10 }))

    await index.sync()

    assertTiles(client.calls, 0n, 2500n, 1000n)
    expect(client.calls.length).toBe(3)
    expect(client.calls[2]).toEqual({ fromBlock: 2000n, toBlock: 2500n })
  })

  it('chunkSize = 1 — one block per range', async () => {
    const client = new FakeLogClient(new Map(), 3n)
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig({ fromBlock: 0n, chunkSize: 1n, concurrency: 10 }))

    await index.sync()

    assertTiles(client.calls, 0n, 3n, 1n)
    expect(client.calls).toEqual([
      { fromBlock: 0n, toBlock: 0n },
      { fromBlock: 1n, toBlock: 1n },
      { fromBlock: 2n, toBlock: 2n },
      { fromBlock: 3n, toBlock: 3n },
    ])
  })

  it('concurrency larger than the number of chunks — still tiles correctly, one batch', async () => {
    const client = new FakeLogClient(new Map(), 2500n) // 3 chunks at chunkSize 1000
    const store = new MemoryHolderStore()
    const commitSpy = vi.spyOn(store, 'commit')
    const index = new HolderIndex(client, store, baseConfig({ fromBlock: 0n, chunkSize: 1000n, concurrency: 50 }))

    await index.sync()

    assertTiles(client.calls, 0n, 2500n, 1000n)
    expect(client.calls.length).toBe(3)
    expect(commitSpy).toHaveBeenCalledOnce() // all 3 chunks fit in one batch of 50
  })

  it('head < fromBlock — no getLogs calls, no crash, backfillComplete true', async () => {
    const client = new FakeLogClient(new Map(), 3n) // head behind fromBlock
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig({ fromBlock: 10n }))

    await expect(index.sync()).resolves.not.toThrow()

    expect(client.calls.length).toBe(0)
    expect(index.status().backfillComplete).toBe(true)
    expect(index.status().lastError).toBeNull()
  })
})

// ─── 4. Store commit ordering & cursor monotonicity ───────────────────────────

describe('HolderIndex — store commits and cursor', () => {
  it('commits once per batch of <= concurrency chunks, with cursor = end of that batch, never decreasing', async () => {
    const client = new FakeLogClient(new Map(), 39n) // 40 blocks, chunkSize 10 -> 4 chunks
    const store = new MemoryHolderStore()
    const commitSpy = vi.spyOn(store, 'commit')
    const index = new HolderIndex(client, store, baseConfig({ fromBlock: 0n, chunkSize: 10n, concurrency: 2 }))

    await index.sync()

    expect(commitSpy).toHaveBeenCalledTimes(2) // 4 chunks / concurrency 2 = 2 batches
    const cursors = commitSpy.mock.calls.map(c => c[1] as bigint)
    expect(cursors).toEqual([19n, 39n])
    for (let i = 1; i < cursors.length; i++) expect(cursors[i]).toBeGreaterThan(cursors[i - 1])
  })

  it('MemoryHolderStore never moves its cursor backwards', async () => {
    const store = new MemoryHolderStore()
    await store.commit([], 100n)
    await store.commit([], 50n) // attempted regression
    const { cursor } = await store.load()
    expect(cursor).toBe(100n)
  })
})

// ─── 5. Resume + reorg overlap ─────────────────────────────────────────────────

describe('HolderIndex — resume and reorg overlap', () => {
  it('resumes the next sync at max(fromBlock, priorHead + 1 - reorgOverlap) and ends at the new head', async () => {
    const client = new FakeLogClient(new Map(), 100n)
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig({ fromBlock: 0n, chunkSize: 1000n, reorgOverlap: 10n }))

    await index.sync() // backfill to 100
    client.calls.length = 0
    client.head = 150n

    await index.sync()

    expect(client.calls[0].fromBlock).toBe(91n) // 100 + 1 - 10
    expect(client.calls[client.calls.length - 1].toBlock).toBe(150n)
  })

  it('reorgOverlap clamps to fromBlock when it would go below it', async () => {
    const client = new FakeLogClient(new Map(), 5n)
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig({ fromBlock: 0n, reorgOverlap: 64n }))

    await index.sync() // head 5, overlap 64 -> resume would be negative
    client.calls.length = 0
    client.head = 8n

    await index.sync()

    expect(client.calls[0].fromBlock).toBe(0n) // clamped to fromBlock, not negative
    expect(client.calls[client.calls.length - 1].toBlock).toBe(8n)
  })

  it('a NEW HolderIndex on a store with an existing cursor/holders loads them and resumes from cursor + 1 - overlap', async () => {
    const store = new MemoryHolderStore()
    await store.commit([HOLDER_A.toLowerCase()], 100n)

    const client = new FakeLogClient(new Map(), 150n)
    const index = new HolderIndex(client, store, baseConfig({ fromBlock: 0n, reorgOverlap: 10n }))

    await index.sync()

    expect(index.holders()).toContain(HOLDER_A.toLowerCase())
    expect(client.calls[0].fromBlock).toBe(91n) // 100 + 1 - 10, NOT fromBlock (0)
  })
})

// ─── 6. Shared store across two instances ─────────────────────────────────────

describe('HolderIndex — shared store', () => {
  it('two instances sharing a store each see holders the other discovered', async () => {
    const store = new MemoryHolderStore()
    const logsA = new Map<bigint, LogEntry[]>([[0n, [{ to: HOLDER_A, value: 1n }]]])
    const logsB = new Map<bigint, LogEntry[]>([[0n, [{ to: HOLDER_B, value: 1n }]]])

    const clientA = new FakeLogClient(logsA, 0n)
    const clientB = new FakeLogClient(logsB, 0n)
    const indexA = new HolderIndex(clientA, store, baseConfig({ fromBlock: 0n }))
    const indexB = new HolderIndex(clientB, store, baseConfig({ fromBlock: 0n }))

    await indexA.sync() // A discovers HOLDER_A, commits to shared store
    await indexB.sync() // B discovers HOLDER_B, and loads HOLDER_A from the shared store

    expect(indexB.holders().sort()).toEqual([HOLDER_A.toLowerCase(), HOLDER_B.toLowerCase()].sort())

    // A hasn't rescanned, but a subsequent sync's store.load() picks up B's holder too
    clientA.head = 0n
    await indexA.sync()
    expect(indexA.holders()).toContain(HOLDER_B.toLowerCase())
  })
})

// ─── 7. Failure mid-backfill ───────────────────────────────────────────────────

describe('HolderIndex — failure mid-backfill', () => {
  it('does not throw; keeps prior progress; resumes (not from fromBlock) and clears lastError once fixed', async () => {
    const client = new FakeLogClient(new Map(), 39n) // 4 chunks of 10: [0-9][10-19][20-29][30-39]
    const store = new MemoryHolderStore()
    const commitSpy = vi.spyOn(store, 'commit')
    // concurrency 1 + reorgOverlap 0 => one chunk per batch, deterministic resume point
    const index = new HolderIndex(client, store, baseConfig({
      fromBlock: 0n, chunkSize: 10n, concurrency: 1, reorgOverlap: 0n,
    }))

    let callCount = 0
    client.setOverride(async (args) => {
      callCount++
      if (callCount === 3) throw new Error('RPC timeout')
      return []
    })

    await expect(index.sync()).resolves.not.toThrow()

    expect(index.status().backfillComplete).toBe(false)
    expect(index.status().lastError).toBe('RPC timeout')
    expect(index.status().syncedToBlock).toBe('19') // batches 1 & 2 committed (cursor 9, then 19)
    expect(commitSpy).toHaveBeenCalledTimes(2)
    const { cursor } = await store.load()
    expect(cursor).toBe(19n)

    // Fix the client and resume.
    client.setOverride(async () => [])
    await index.sync()

    expect(index.status().backfillComplete).toBe(true)
    expect(index.status().lastError).toBeNull()
    // Resumed from cursor+1 (19+1=20), not from fromBlock (0): calls 3 & 4 total after fix -> [20,29],[30,39]
    expect(client.calls[client.calls.length - 2]).toEqual({ fromBlock: 20n, toBlock: 29n })
    expect(client.calls[client.calls.length - 1]).toEqual({ fromBlock: 30n, toBlock: 39n })
  })
})

// ─── 8. Store failure ──────────────────────────────────────────────────────────

describe('HolderIndex — store failure', () => {
  it('store.load() throwing resolves sync with lastError set, no crash', async () => {
    const client = new FakeLogClient(new Map(), 10n)
    const store = new MemoryHolderStore()
    vi.spyOn(store, 'load').mockRejectedValueOnce(new Error('redis down'))
    const index = new HolderIndex(client, store, baseConfig())

    await expect(index.sync()).resolves.not.toThrow()

    expect(index.status().lastError).toBe('redis down')
    expect(index.status().backfillComplete).toBe(false)
  })

  it('store.commit() throwing resolves sync with lastError set; the batch\'s holders stay in memory but the cursor does not advance', async () => {
    const logs = new Map<bigint, LogEntry[]>([[0n, [{ to: HOLDER_A, value: 1n }]]])
    const client = new FakeLogClient(logs, 0n)
    const store = new MemoryHolderStore()
    vi.spyOn(store, 'commit').mockRejectedValueOnce(new Error('write failed'))
    const index = new HolderIndex(client, store, baseConfig())

    await expect(index.sync()).resolves.not.toThrow()

    expect(index.status().lastError).toBe('write failed')
    // A store outage must not hide freshly-found holders from this keeper...
    expect(index.holders()).toContain(HOLDER_A.toLowerCase())
    // ...but nothing was persisted, so the batch is re-scanned next time.
    expect(index.status().syncedToBlock).toBeNull()
    expect((await store.load()).cursor).toBeNull()

    await index.sync()
    expect(index.status().lastError).toBeNull()
    expect((await store.load()).holders).toContain(HOLDER_A.toLowerCase())
  })
})

// ─── 9. Single-flight ───────────────────────────────────────────────────────────

describe('HolderIndex — single-flight sync', () => {
  it('two concurrent sync() calls share one scan; a later sync() starts a new one', async () => {
    const client = new FakeLogClient(new Map(), 100n)
    const { promise, resolve } = deferred<ReadonlyArray<{ args: LogEntry }>>()
    client.setOverride(() => promise)
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig({ fromBlock: 0n, chunkSize: 1000n, concurrency: 4 }))

    const p1 = index.sync()
    const p2 = index.sync()
    await flush() // let both calls run up to the pending getLogs

    expect(client.blockNumberCalls).toBe(1) // only one scan actually started

    resolve([])
    await Promise.all([p1, p2])
    expect(client.blockNumberCalls).toBe(1)

    client.setOverride(null)
    await index.sync()
    expect(client.blockNumberCalls).toBe(2) // a fresh sync after completion is a new scan
  })
})

// ─── 10. refresh() ──────────────────────────────────────────────────────────────

describe('HolderIndex — refresh()', () => {
  it('returns promptly without waiting for backfill; a background sync keeps running', async () => {
    const client = new FakeLogClient(new Map(), 100n)
    const { promise } = deferred<ReadonlyArray<{ args: LogEntry }>>() // never resolves
    client.setOverride(() => promise)
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig({ fromBlock: 0n }))

    await index.refresh() // must resolve even though the underlying sync is stuck

    expect(index.status().backfillComplete).toBe(false)
    expect(client.blockNumberCalls).toBe(1) // background sync did kick off

    // Calling sync() now should just join the still-pending background sync
    // (no new getBlockNumber call), proving it is genuinely still in flight.
    void index.sync()
    await flush()
    expect(client.blockNumberCalls).toBe(1)
  })

  it('awaits the sync once backfill is complete — new holders are visible immediately after await', async () => {
    const logs = new Map<bigint, LogEntry[]>()
    const client = new FakeLogClient(logs, 10n)
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig({ fromBlock: 0n, reorgOverlap: 0n }))

    await index.sync()
    expect(index.status().backfillComplete).toBe(true)

    client.head = 11n
    logs.set(11n, [{ to: HOLDER_A, value: 1n }])

    await index.refresh()

    expect(index.holders()).toContain(HOLDER_A.toLowerCase())
  })
})

// ─── 11. status() fields ────────────────────────────────────────────────────────

describe('HolderIndex — status()', () => {
  it('reports holders, syncedToBlock, backfillComplete, lastSyncAt', async () => {
    const logs = new Map<bigint, LogEntry[]>([[0n, [{ to: HOLDER_A, value: 1n }]]])
    const client = new FakeLogClient(logs, 5n)
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig({ fromBlock: 0n }))

    const before = index.status()
    expect(before.holders).toBe(0)
    expect(before.syncedToBlock).toBeNull()
    expect(before.backfillComplete).toBe(false)
    expect(before.lastSyncAt).toBeNull()

    await index.sync()

    const after = index.status()
    expect(after.holders).toBe(1)
    expect(after.syncedToBlock).toBe('5')
    expect(after.backfillComplete).toBe(true)
    expect(after.lastSyncAt).not.toBeNull()
    expect(() => new Date(after.lastSyncAt as string)).not.toThrow()
    expect(after.lastError).toBeNull()
  })
})

// ─── 12. createHolderIndex(env) ─────────────────────────────────────────────────

describe('createHolderIndex', () => {
  it('throws mentioning HOLDER_INDEX_FROM_BLOCK when unset', () => {
    const client = new FakeLogClient(new Map(), 0n)
    expect(() => createHolderIndex(client, TOKEN, 1, {} as NodeJS.ProcessEnv))
      .toThrow(/HOLDER_INDEX_FROM_BLOCK/)
  })

  it('throws mentioning HOLDER_INDEX_FROM_BLOCK when set to an empty/whitespace string', () => {
    const client = new FakeLogClient(new Map(), 0n)
    expect(() => createHolderIndex(client, TOKEN, 1, { HOLDER_INDEX_FROM_BLOCK: '   ' } as NodeJS.ProcessEnv))
      .toThrow(/HOLDER_INDEX_FROM_BLOCK/)
  })

  it('throws on a non-numeric HOLDER_INDEX_FROM_BLOCK', () => {
    const client = new FakeLogClient(new Map(), 0n)
    expect(() => createHolderIndex(client, TOKEN, 1, { HOLDER_INDEX_FROM_BLOCK: 'abc' } as NodeJS.ProcessEnv))
      .toThrow(/HOLDER_INDEX_FROM_BLOCK must be a block number/)
  })

  it('parses TRACKED_HOLDERS into seeds, trimming whitespace and skipping empties', () => {
    const client = new FakeLogClient(new Map(), 0n)
    const index = createHolderIndex(client, TOKEN, 1, {
      HOLDER_INDEX_FROM_BLOCK: '0',
      TRACKED_HOLDERS: ` ${HOLDER_A} , ,${HOLDER_B},`,
    } as NodeJS.ProcessEnv)

    expect(index.holders().sort()).toEqual(
      [HOLDER_A.toLowerCase(), HOLDER_B.toLowerCase()].sort(),
    )
  })

  it('uses MemoryHolderStore (in-memory, no Redis) when REDIS_URL is unset — sync works end to end', async () => {
    const client = new FakeLogClient(new Map(), 0n)
    const index = createHolderIndex(client, TOKEN, 1, {
      HOLDER_INDEX_FROM_BLOCK: '0',
    } as NodeJS.ProcessEnv)

    await index.sync()

    expect(index.status().backfillComplete).toBe(true)
    expect(index.status().lastError).toBeNull()
  })

  it('sets backfillRetryMs=30000 on the returned index (verified via fake-timer retry behaviour)', async () => {
    vi.useFakeTimers()
    const client = new FakeLogClient(new Map(), 10n)
    const index = createHolderIndex(client, TOKEN, 1, {
      HOLDER_INDEX_FROM_BLOCK: '0',
    } as NodeJS.ProcessEnv)

    let calls = 0
    client.setOverride(async () => {
      calls++
      throw new Error('fails once')
    })

    await index.sync()
    expect(index.status().lastError).toBe('fails once')
    expect(index.status().backfillComplete).toBe(false)

    client.setOverride(async () => [])
    await vi.advanceTimersByTimeAsync(30_000)

    expect(index.status().backfillComplete).toBe(true)
    expect(index.status().lastError).toBeNull()
  })
})

// ─── backfillRetryMs (direct construction) ─────────────────────────────────────

describe('HolderIndex — backfillRetryMs auto-retry', () => {
  it('schedules exactly one retry on failure before backfill completes; advancing the timer retries and completes', async () => {
    vi.useFakeTimers()
    const client = new FakeLogClient(new Map(), 10n)
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig({ fromBlock: 0n, backfillRetryMs: 1000 }))

    let callCount = 0
    client.setOverride(async () => {
      callCount++
      if (callCount === 1) throw new Error('boom')
      return []
    })

    await index.sync()
    expect(index.status().lastError).toBe('boom')
    expect(index.status().backfillComplete).toBe(false)

    await vi.advanceTimersByTimeAsync(1000)

    expect(index.status().backfillComplete).toBe(true)
    expect(index.status().lastError).toBeNull()
    expect(callCount).toBeGreaterThanOrEqual(2)
  })

  it('does not schedule a retry when backfillRetryMs is 0 (default off) — existing behaviour unchanged', async () => {
    vi.useFakeTimers()
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')
    const client = new FakeLogClient(new Map(), 10n)
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig({ fromBlock: 0n })) // backfillRetryMs defaults to 0

    client.setOverride(async () => { throw new Error('boom') })

    await index.sync()
    expect(index.status().lastError).toBe('boom')
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })

  it('does not schedule a retry for a failure once backfillComplete is already true (incremental sync failure)', async () => {
    vi.useFakeTimers()
    const client = new FakeLogClient(new Map(), 10n)
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig({ fromBlock: 0n, backfillRetryMs: 1000 }))

    // First sync succeeds and completes the backfill.
    await index.sync()
    expect(index.status().backfillComplete).toBe(true)

    // Now a later incremental sync fails — should NOT schedule a retry timer.
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')
    client.head = 20n
    client.setOverride(async () => { throw new Error('later failure') })

    await index.sync()

    expect(index.status().lastError).toBe('later failure')
    expect(index.status().backfillComplete).toBe(true) // stays true — once true, always true
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })

  it('does not stack multiple retry timers on repeated failures (single pending timer)', async () => {
    vi.useFakeTimers()
    const client = new FakeLogClient(new Map(), 10n)
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig({ fromBlock: 0n, backfillRetryMs: 1000 }))
    client.setOverride(async () => { throw new Error('boom') })

    await index.sync() // fails, schedules retry #1

    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')
    await index.sync() // manual second call while a retry is already pending; still fails
    expect(index.status().lastError).toBe('boom')
    // retryTimer was already non-null from the first failure, so this failure must not add another
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })
})

// ─── 12b. close() ───────────────────────────────────────────────────────────────

describe('MemoryHolderStore — close()', () => {
  it('is a no-op that resolves', async () => {
    const store = new MemoryHolderStore()
    await expect(store.close()).resolves.toBeUndefined()
  })
})

describe('HolderIndex — close()', () => {
  it('cancels a pending backfill-retry timer — a later tick does not retry', async () => {
    vi.useFakeTimers()
    const client = new FakeLogClient(new Map(), 10n)
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig({ fromBlock: 0n, backfillRetryMs: 1000 }))
    client.setOverride(async () => { throw new Error('boom') })

    await index.sync()   // fails, schedules a retry timer
    expect(index.status().lastError).toBe('boom')

    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout')
    await index.close()
    expect(clearTimeoutSpy).toHaveBeenCalled()

    // Advancing time after close() must NOT trigger a retry (timer was cancelled).
    client.setOverride(async () => [])
    await vi.advanceTimersByTimeAsync(2000)
    expect(index.status().backfillComplete).toBe(false)
  })

  it('awaits an in-flight sync before resolving', async () => {
    const client = new FakeLogClient(new Map(), 100n)
    const { promise, resolve } = deferred<ReadonlyArray<{ args: LogEntry }>>()
    client.setOverride(() => promise)
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig({ fromBlock: 0n }))

    void index.sync()   // kicks off a sync that blocks on the deferred getLogs
    await flush()

    let closeResolved = false
    const closePromise = index.close().then(() => { closeResolved = true })
    await flush()
    expect(closeResolved).toBe(false)

    resolve([])
    await closePromise
    expect(closeResolved).toBe(true)
  })

  it('closes the underlying store', async () => {
    const client = new FakeLogClient(new Map(), 0n)
    const store = new MemoryHolderStore()
    const closeSpy = vi.spyOn(store, 'close')
    const index = new HolderIndex(client, store, baseConfig())

    await index.close()

    expect(closeSpy).toHaveBeenCalledOnce()
  })

  it('is safe to call with no prior sync and no pending timer', async () => {
    const client = new FakeLogClient(new Map(), 0n)
    const store = new MemoryHolderStore()
    const index = new HolderIndex(client, store, baseConfig())

    await expect(index.close()).resolves.toBeUndefined()
  })
})

// ─── 13. RedisHolderStore (fake redis client) ──────────────────────────────────

class FakeRedis {
  private store = new Map<string, string>()
  private sets = new Map<string, Set<string>>()
  readonly callOrder: string[] = []

  async get(key: string): Promise<string | null> {
    this.callOrder.push(`get:${key}`)
    return this.store.get(key) ?? null
  }

  async smembers(key: string): Promise<string[]> {
    this.callOrder.push(`smembers:${key}`)
    return [...(this.sets.get(key) ?? [])]
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    this.callOrder.push(`sadd:${key}`)
    if (!this.sets.has(key)) this.sets.set(key, new Set())
    const set = this.sets.get(key)!
    let added = 0
    for (const m of members) { if (!set.has(m)) { set.add(m); added++ } }
    return added
  }

  // Emulates SET_CURSOR_IF_GREATER: set-if-greater semantics.
  async eval(_script: string, _numKeys: number, key: string, value: string): Promise<number> {
    this.callOrder.push(`eval:${key}:${value}`)
    const cur = this.store.get(key)
    if (cur === undefined || BigInt(cur) < BigInt(value)) this.store.set(key, value)
    return 1
  }

  async quit(): Promise<string> {
    this.callOrder.push('quit')
    return 'OK'
  }

  disconnect(): void {
    this.callOrder.push('disconnect')
  }
}

describe('RedisHolderStore', () => {
  it('load() parses the cursor to bigint, or null when unset', async () => {
    const redis = new FakeRedis()
    const store = new RedisHolderStore(redis as unknown as import('ioredis').default, 'prefix')

    const empty = await store.load()
    expect(empty.cursor).toBeNull()
    expect(empty.holders).toEqual([])

    await redis.sadd('prefix:holders', HOLDER_A.toLowerCase())
    await redis.eval('script', 1, 'prefix:cursor', '42')

    const loaded = await store.load()
    expect(loaded.cursor).toBe(42n)
    expect(loaded.holders).toEqual([HOLDER_A.toLowerCase()])
  })

  it('commit() calls sadd BEFORE the cursor eval, in that order', async () => {
    const redis = new FakeRedis()
    const store = new RedisHolderStore(redis as unknown as import('ioredis').default, 'prefix')

    await store.commit([HOLDER_A.toLowerCase()], 10n)

    const saddIdx = redis.callOrder.findIndex(c => c.startsWith('sadd:'))
    const evalIdx = redis.callOrder.findIndex(c => c.startsWith('eval:'))
    expect(saddIdx).toBeGreaterThanOrEqual(0)
    expect(evalIdx).toBeGreaterThan(saddIdx)
  })

  it('commit() skips sadd when newHolders is empty, but still evals the cursor', async () => {
    const redis = new FakeRedis()
    const store = new RedisHolderStore(redis as unknown as import('ioredis').default, 'prefix')

    await store.commit([], 10n)

    expect(redis.callOrder.some(c => c.startsWith('sadd:'))).toBe(false)
    expect(redis.callOrder.some(c => c.startsWith('eval:prefix:cursor:10'))).toBe(true)
  })

  it('commit() invokes eval with the cursor key and the cursor value as a string', async () => {
    const redis = new FakeRedis()
    const evalSpy = vi.spyOn(redis, 'eval')
    const store = new RedisHolderStore(redis as unknown as import('ioredis').default, 'prefix')

    await store.commit([HOLDER_A.toLowerCase()], 123n)

    expect(evalSpy).toHaveBeenCalledWith(expect.any(String), 1, 'prefix:cursor', '123')
  })

  it('the cursor set-if-greater semantics never move the cursor backwards', async () => {
    const redis = new FakeRedis()
    const store = new RedisHolderStore(redis as unknown as import('ioredis').default, 'prefix')

    await store.commit([], 100n)
    await store.commit([], 50n)

    const { cursor } = await store.load()
    expect(cursor).toBe(100n)
  })

  it('close() quits the redis connection', async () => {
    const redis = new FakeRedis()
    const quitSpy = vi.spyOn(redis, 'quit')
    const store = new RedisHolderStore(redis as unknown as import('ioredis').default, 'prefix')

    await store.close()

    expect(quitSpy).toHaveBeenCalledOnce()
  })

  it('close() falls back to disconnect() when quit() rejects', async () => {
    const redis = new FakeRedis()
    vi.spyOn(redis, 'quit').mockRejectedValue(new Error('quit failed'))
    const disconnectSpy = vi.spyOn(redis, 'disconnect')
    const store = new RedisHolderStore(redis as unknown as import('ioredis').default, 'prefix')

    await expect(store.close()).resolves.toBeUndefined()
    expect(disconnectSpy).toHaveBeenCalledOnce()
  })
})
