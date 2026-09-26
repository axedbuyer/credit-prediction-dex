import Redis from 'ioredis'
import { parseAbiItem } from 'viem'
import type { Address } from 'viem'

// ─── Holder discovery from YES Transfer events ────────────────────────────────
//
// Replaces the hand-maintained TRACKED_HOLDERS list as the source of "who holds
// YES". Every YES balance change — mint (from = 0), burn (to = 0), CLOB swap,
// LiquidationEngine forcedTransfer — goes through OZ ERC20._update and emits a
// standard Transfer, so the set of non-zero `to` addresses over the token's
// whole history is a superset of current holders. Keepers read on-chain state
// per holder anyway (claimable / isSeizable / balanceOf), so a stale
// ex-holder in the set costs one read and is otherwise harmless — whereas a
// MISSING holder is never flagged and silently shifts tail risk onto the
// InsuranceFund. The set therefore only ever grows.
//
// Persistence invariant: a stored cursor C means "every Transfer recipient in
// blocks <= C is in the stored set". commit() writes holders BEFORE the
// cursor, and the cursor only moves forward, so a crash between the two
// merely re-scans. Both keepers may share one store (same keys): each loads
// a valid (cursor, set) pair and extends it, so either keeper's progress is
// valid for the other.
//
// Reorgs: every sync re-scans the last `reorgOverlap` blocks below the cursor
// — adding is idempotent, so the overlap is free and a shallow reorg that
// moves a Transfer into an already-scanned block is still caught.

export const TRANSFER_EVENT = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
)

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

// ─── Narrow client interface ──────────────────────────────────────────────────

export interface ILogClient {
  getBlockNumber(): Promise<bigint>
  getLogs(args: {
    address: Address
    event: typeof TRANSFER_EVENT
    fromBlock: bigint
    toBlock: bigint
  }): Promise<ReadonlyArray<{ args: { from?: Address; to?: Address; value?: bigint } }>>
}

// ─── Stores ───────────────────────────────────────────────────────────────────

export interface HolderStore {
  load(): Promise<{ cursor: bigint | null; holders: string[] }>
  /** Persist newly-found holders, THEN advance the cursor (never backwards). */
  commit(newHolders: string[], cursor: bigint): Promise<void>
}

export class MemoryHolderStore implements HolderStore {
  private cursor: bigint | null = null
  private readonly holders = new Set<string>()

  async load(): Promise<{ cursor: bigint | null; holders: string[] }> {
    return { cursor: this.cursor, holders: [...this.holders] }
  }

  async commit(newHolders: string[], cursor: bigint): Promise<void> {
    for (const h of newHolders) this.holders.add(h)
    if (this.cursor === null || cursor > this.cursor) this.cursor = cursor
  }
}

// Forward-only cursor write: two keepers sharing the keys must never move it back.
const SET_CURSOR_IF_GREATER = `
local cur = redis.call('GET', KEYS[1])
if (not cur) or (tonumber(cur) < tonumber(ARGV[1])) then
  redis.call('SET', KEYS[1], ARGV[1])
end
return 1`

export class RedisHolderStore implements HolderStore {
  private readonly holdersKey: string
  private readonly cursorKey: string

  constructor(private readonly redis: Redis, keyPrefix: string) {
    this.holdersKey = `${keyPrefix}:holders`
    this.cursorKey  = `${keyPrefix}:cursor`
  }

  async load(): Promise<{ cursor: bigint | null; holders: string[] }> {
    const [cursor, holders] = await Promise.all([
      this.redis.get(this.cursorKey),
      this.redis.smembers(this.holdersKey),
    ])
    return { cursor: cursor === null ? null : BigInt(cursor), holders }
  }

  async commit(newHolders: string[], cursor: bigint): Promise<void> {
    if (newHolders.length > 0) await this.redis.sadd(this.holdersKey, ...newHolders)
    await this.redis.eval(SET_CURSOR_IF_GREATER, 1, this.cursorKey, cursor.toString())
  }
}

// ─── HolderIndex ──────────────────────────────────────────────────────────────

export interface HolderIndexConfig {
  tokenAddress: Address
  /** First block to scan — the token's deploy block. */
  fromBlock: bigint
  /** Blocks per eth_getLogs call. Public Base RPC caps a call at a 1,000-block range. */
  chunkSize?: bigint
  /** eth_getLogs calls in flight per batch; the cursor is committed once per batch. */
  concurrency?: number
  /** Blocks below the cursor re-scanned on every sync (reorg safety). */
  reorgOverlap?: bigint
  /** Addresses always included (e.g. legacy TRACKED_HOLDERS). */
  seedHolders?: string[]
  /**
   * If > 0, a sync that fails before the backfill has ever completed schedules
   * its own retry after this many ms, so a rate-limited backfill heals without
   * waiting for the keeper's next cycle (8h for funding-keeper). 0 = off.
   */
  backfillRetryMs?: number
}

export interface HolderIndexStatus {
  holders: number
  syncedToBlock: string | null
  backfillComplete: boolean
  lastSyncAt: string | null
  lastError: string | null
}

export class HolderIndex {
  private readonly known = new Set<string>()
  private readonly chunkSize: bigint
  private readonly concurrency: number
  private readonly reorgOverlap: bigint
  private readonly backfillRetryMs: number
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private syncedToBlock: bigint | null = null
  private backfillComplete = false
  private lastSyncAt: Date | null = null
  private lastError: string | null = null
  private inFlight: Promise<void> | null = null

  constructor(
    private readonly client: ILogClient,
    private readonly store: HolderStore,
    private readonly config: HolderIndexConfig,
  ) {
    this.chunkSize    = config.chunkSize ?? 1000n
    this.concurrency  = config.concurrency ?? 4
    this.reorgOverlap = config.reorgOverlap ?? 64n
    this.backfillRetryMs = config.backfillRetryMs ?? 0
    if (this.chunkSize < 1n) throw new Error('HolderIndex chunkSize must be >= 1')
    if (this.concurrency < 1) throw new Error('HolderIndex concurrency must be >= 1')
    for (const h of config.seedHolders ?? []) this.known.add(h.toLowerCase())
  }

  /**
   * Scan from the stored cursor up to the current head. Single-flight: a call
   * made while a sync is running joins it. Never throws — failures are logged
   * and recorded in status().lastError; progress committed before the failure
   * is kept and the next sync resumes from it.
   */
  sync(): Promise<void> {
    if (!this.inFlight) {
      this.inFlight = this.runSync().finally(() => { this.inFlight = null })
    }
    return this.inFlight
  }

  /**
   * Keeper hot-path entry point: never blocks on a long backfill. Once the
   * index has caught up to head, awaits an (incremental, cheap) sync; until
   * then, starts or continues the backfill in the background and returns
   * immediately so keepers keep serving the holders found so far.
   */
  async refresh(): Promise<void> {
    if (this.backfillComplete) {
      await this.sync()
    } else {
      void this.sync()
    }
  }

  /** Seeds ∪ every Transfer recipient discovered so far (lowercased, deduped). */
  holders(): Address[] {
    return [...this.known] as Address[]
  }

  status(): HolderIndexStatus {
    return {
      holders:          this.known.size,
      syncedToBlock:    this.syncedToBlock?.toString() ?? null,
      backfillComplete: this.backfillComplete,
      lastSyncAt:       this.lastSyncAt?.toISOString() ?? null,
      lastError:        this.lastError,
    }
  }

  private async runSync(): Promise<void> {
    try {
      // Reload every time: another keeper sharing the store may have advanced it.
      const stored = await this.store.load()
      for (const h of stored.holders) this.known.add(h.toLowerCase())
      if (stored.cursor !== null && (this.syncedToBlock === null || stored.cursor > this.syncedToBlock)) {
        this.syncedToBlock = stored.cursor
      }

      const head = await this.client.getBlockNumber()

      let start = this.config.fromBlock
      if (this.syncedToBlock !== null) {
        const resume = this.syncedToBlock + 1n - this.reorgOverlap
        if (resume > start) start = resume
      }

      const isBackfill = !this.backfillComplete
      if (isBackfill && start <= head) {
        console.log(`[holder-index] backfilling Transfer logs ${start}..${head} (${head - start + 1n} blocks)`)
      }

      while (start <= head) {
        const ranges: Array<[bigint, bigint]> = []
        let s = start
        while (ranges.length < this.concurrency && s <= head) {
          const e = s + this.chunkSize - 1n < head ? s + this.chunkSize - 1n : head
          ranges.push([s, e])
          s = e + 1n
        }

        const results = await Promise.all(ranges.map(([fromBlock, toBlock]) =>
          this.client.getLogs({
            address: this.config.tokenAddress,
            event:   TRANSFER_EVENT,
            fromBlock,
            toBlock,
          }),
        ))

        const found = new Set<string>()
        for (const logs of results) {
          for (const log of logs) {
            const to = log.args.to?.toLowerCase()
            if (to && to !== ZERO_ADDRESS) found.add(to)
          }
        }

        const batchEnd = ranges[ranges.length - 1][1]
        const newHolders = [...found].filter(h => !this.known.has(h))
        // In-memory first: if the store write fails (Redis outage), this keeper
        // still checks the holders it just found; the cursor doesn't advance, so
        // the batch is re-scanned and re-committed on the next sync.
        for (const h of found) this.known.add(h)
        await this.store.commit([...found], batchEnd)
        if (this.syncedToBlock === null || batchEnd > this.syncedToBlock) this.syncedToBlock = batchEnd
        if (newHolders.length > 0) {
          console.log(`[holder-index] +${newHolders.length} holder(s) through block ${batchEnd}: ${newHolders.join(', ')}`)
        }
        start = batchEnd + 1n
      }

      if (isBackfill) {
        console.log(`[holder-index] backfill complete at block ${head}: ${this.known.size} holder(s)`)
      }
      this.backfillComplete = true
      this.lastSyncAt = new Date()
      this.lastError = null
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      console.error('[holder-index] sync failed (progress so far is kept):', err)
      if (!this.backfillComplete && this.backfillRetryMs > 0 && this.retryTimer === null) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null
          void this.sync()
        }, this.backfillRetryMs)
        this.retryTimer.unref?.()
      }
    }
  }
}

// ─── Env wiring (shared by both keepers) ──────────────────────────────────────

/**
 * Build a HolderIndex from env:
 *   HOLDER_INDEX_FROM_BLOCK   REQUIRED — the YES token's deploy block (0 on a fresh anvil)
 *   HOLDER_INDEX_CHUNK_SIZE   blocks per eth_getLogs call (default 1000)
 *   HOLDER_INDEX_CONCURRENCY  calls in flight per batch (default 4)
 *   REDIS_URL                 optional — persist progress so a restart doesn't re-backfill
 *   TRACKED_HOLDERS           optional — comma-separated seed addresses
 */
export function createHolderIndex(
  client: ILogClient,
  tokenAddress: Address,
  chainId: number,
  env: NodeJS.ProcessEnv = process.env,
): HolderIndex {
  const rawFrom = env.HOLDER_INDEX_FROM_BLOCK?.trim()
  if (!rawFrom) {
    throw new Error(
      'HOLDER_INDEX_FROM_BLOCK is not set. Set it to the YES token deploy block ' +
      '(Base Sepolia: 43766743; a fresh anvil: 0) — scanning from genesis would take ' +
      'tens of thousands of eth_getLogs calls.',
    )
  }
  if (!/^\d+$/.test(rawFrom)) throw new Error(`HOLDER_INDEX_FROM_BLOCK must be a block number, got "${rawFrom}"`)

  const chunkSize   = BigInt(env.HOLDER_INDEX_CHUNK_SIZE ?? '1000')
  const concurrency = parseInt(env.HOLDER_INDEX_CONCURRENCY ?? '4')

  const seedHolders = (env.TRACKED_HOLDERS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0)

  let store: HolderStore
  if (env.REDIS_URL) {
    const keyPrefix = `holder-index:${chainId}:${tokenAddress.toLowerCase()}`
    store = new RedisHolderStore(new Redis(env.REDIS_URL, { lazyConnect: true }), keyPrefix)
    console.log(`[holder-index] persisting progress in Redis under ${keyPrefix}:*`)
  } else {
    store = new MemoryHolderStore()
    console.log('[holder-index] REDIS_URL not set — progress is in-memory; a restart re-backfills')
  }

  return new HolderIndex(client, store, {
    tokenAddress,
    fromBlock: BigInt(rawFrom),
    chunkSize,
    concurrency,
    seedHolders,
    backfillRetryMs: 30_000,
  })
}
