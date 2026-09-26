// Live, on-chain-backed trading-fee rate.
//
// Historically the server's fee rate came only from env FEE_BPS and had to be
// hand-kept in sync with CLOBSettlement.feeBps on-chain — overstating skips
// marginal crosses, understating causes deterministic SlippageExceeded
// reverts (see root CLAUDE.md's "Trading fee" section). This module makes the
// ON-CHAIN value the source of truth: it reads `feeBps()` at startup, uses it
// if the read succeeds, and refreshes it periodically so an admin
// `setFeeConfig` change is picked up without a restart. FEE_BPS becomes a
// fallback only — used when no chain is configured, or when a chain read
// fails (RPC down).
//
// The fee MATH itself (fee.ts) is untouched — this only supplies the rate.

import { createPublicClient, http } from 'viem'
import type { Address } from 'viem'
import { resolveViemChain, type IPublicClient } from './chain'

// ─── CLOBSettlement ABI fragment (public `feeBps` state var ⇒ a zero-arg getter) ──

export const CLOB_SETTLEMENT_FEE_ABI = [
  {
    name: 'feeBps',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

// Mirrors CLOBSettlement.sol's `MAX_FEE_BPS = 500` cap — any on-chain read
// outside [0, MAX_FEE_BPS] is treated as corrupt/unexpected and rejected.
export const MAX_FEE_BPS = 500

// ─── IFeeBpsReader — narrow, injectable interface (mirrors chain.ts's IChainReader) ──
//
// Deliberately just one method so it's trivially mockable in unit tests
// without spinning up RPC.

export interface IFeeBpsReader {
  getFeeBps(): Promise<bigint>
}

export class ViemFeeBpsReader implements IFeeBpsReader {
  constructor(
    private readonly publicClient: IPublicClient,
    private readonly clobSettlementAddress: Address,
  ) {}

  async getFeeBps(): Promise<bigint> {
    return await this.publicClient.readContract({
      address:      this.clobSettlementAddress,
      abi:          CLOB_SETTLEMENT_FEE_ABI,
      functionName: 'feeBps',
    }) as bigint
  }
}

// ─── FeeSource — the live, refreshing fee-rate holder ─────────────────────────

export type FeeBpsSourceKind = 'chain' | 'env-fallback'

export interface FeeSourceSnapshot {
  feeBps: number
  source: FeeBpsSourceKind
  // epoch ms of the last successful read that produced the CURRENT value.
  // null until a value has actually been resolved (set synchronously in the
  // constructor to the env fallback, so in practice this is only null before
  // `start()` has been awaited at least once — main.ts always awaits it).
  lastRefreshAt: number | null
}

// The minimal surface server.ts needs — satisfied by FeeSource itself, and by
// a hand-rolled fake in tests (no RPC/timers required).
export interface FeeSourceReader {
  getFeeBps(): number
  getSnapshot(): FeeSourceSnapshot
}

type Logger = Pick<typeof console, 'warn' | 'error' | 'log'>

export interface FeeSourceOptions {
  envFeeBps: number
  // Whether FEE_BPS was actually set in the environment (vs. defaulted) —
  // only used to decide whether to log the "chain value wins" mismatch
  // warning on the initial resolution.
  envFeeBpsWasSet: boolean
  // Undefined ⇒ no chain configured (no RPC URL / no CLOBSettlement address):
  // the source stays 'env-fallback' forever, no reads are attempted.
  reader?: IFeeBpsReader
  // Periodic refresh interval in ms. Default 60_000; 0 disables the timer
  // entirely (still does the one-shot initial read in start()).
  refreshMs?: number
  // Bounded per-read timeout so a hung/flaky RPC can't block startup or pile
  // up concurrent reads. Default 5_000ms.
  timeoutMs?: number
  maxFeeBps?: number
  now?: () => number
  logger?: Logger
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`fee read timed out after ${ms}ms`)), ms)
    // Node timers keeping a short-lived script alive is never desirable here.
    ;(timer as unknown as { unref?: () => void }).unref?.()
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

export class FeeSource implements FeeSourceReader {
  private feeBps: number
  private source: FeeBpsSourceKind = 'env-fallback'
  private lastRefreshAt: number | null = null
  private timer: ReturnType<typeof setInterval> | undefined

  private readonly reader?: IFeeBpsReader
  private readonly envFeeBps: number
  private readonly envFeeBpsWasSet: boolean
  private readonly refreshMs: number
  private readonly timeoutMs: number
  private readonly maxFeeBps: number
  private readonly now: () => number
  private readonly logger: Logger

  constructor(opts: FeeSourceOptions) {
    this.reader = opts.reader
    this.envFeeBps = opts.envFeeBps
    this.envFeeBpsWasSet = opts.envFeeBpsWasSet
    this.refreshMs = opts.refreshMs ?? DEFAULT_FEE_REFRESH_MS
    this.timeoutMs = opts.timeoutMs ?? 5_000
    this.maxFeeBps = opts.maxFeeBps ?? MAX_FEE_BPS
    this.now = opts.now ?? (() => Date.now())
    this.logger = opts.logger ?? console

    // Synchronous default so getFeeBps()/getSnapshot() are always well-defined,
    // even before start() has been awaited.
    this.feeBps = opts.envFeeBps
  }

  getFeeBps(): number {
    return this.feeBps
  }

  getSnapshot(): FeeSourceSnapshot {
    return { feeBps: this.feeBps, source: this.source, lastRefreshAt: this.lastRefreshAt }
  }

  /**
   * Resolves the initial value (chain if configured and reachable within
   * timeoutMs, else the FEE_BPS fallback) and starts the periodic refresh
   * timer. Never throws and never blocks longer than timeoutMs — safe to
   * await unconditionally at startup.
   */
  async start(): Promise<void> {
    await this.refreshOnce(true)
    if (this.refreshMs > 0 && this.reader) {
      this.timer = setInterval(() => {
        this.refreshOnce(false).catch((err) => {
          // refreshOnce already catches read/validation errors internally —
          // this only guards against a truly unexpected throw.
          this.logger.error('[order-book-server] fee source: refresh threw unexpectedly:', err)
        })
      }, this.refreshMs)
      this.timer.unref?.()
    }
  }

  /** Stops the periodic refresh timer, if running. Idempotent. */
  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private isValid(n: number): boolean {
    return Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= this.maxFeeBps
  }

  private async refreshOnce(isInitial: boolean): Promise<void> {
    if (!this.reader) {
      if (isInitial) {
        this.logger.warn(
          `[order-book-server] fee source: no CLOB_SETTLEMENT_ADDRESS/RPC configured — ` +
          `using FEE_BPS=${this.envFeeBps} (source=env-fallback)`,
        )
      }
      return
    }

    try {
      const raw = await withTimeout(this.reader.getFeeBps(), this.timeoutMs)
      const n = Number(raw)

      if (!this.isValid(n)) {
        this.logger.warn(
          `[order-book-server] fee source: chain feeBps=${raw} is out of range [0, ${this.maxFeeBps}] — ` +
          `rejecting, keeping previous value feeBps=${this.feeBps} (source=${this.source})`,
        )
        return
      }

      if (isInitial && this.envFeeBpsWasSet && n !== this.envFeeBps) {
        this.logger.warn(
          `[order-book-server] fee source: on-chain feeBps=${n} differs from FEE_BPS env=${this.envFeeBps} — ` +
          `the chain value wins; FEE_BPS is now only a startup/RPC-outage fallback`,
        )
      } else if (!isInitial && n !== this.feeBps) {
        this.logger.log(
          `[order-book-server] fee source: feeBps refreshed ${this.feeBps} -> ${n} (source=chain)`,
        )
      } else if (isInitial) {
        this.logger.log(`[order-book-server] fee source: resolved feeBps=${n} from chain (source=chain)`)
      }

      this.feeBps = n
      this.source = 'chain'
      this.lastRefreshAt = this.now()
    } catch (err) {
      if (isInitial) {
        this.logger.warn(
          `[order-book-server] fee source: initial chain read failed — falling back to ` +
          `FEE_BPS=${this.envFeeBps} (source=env-fallback):`, err,
        )
        this.feeBps = this.envFeeBps
        this.source = 'env-fallback'
        this.lastRefreshAt = null
      } else {
        this.logger.warn(
          `[order-book-server] fee source: refresh failed — keeping last good value ` +
          `feeBps=${this.feeBps} (source=${this.source}):`, err,
        )
      }
    }
  }
}

// ─── Production factory ───────────────────────────────────────────────────────

export interface FeeSourceInit {
  // Both must be set for the chain reader to be constructed at all — mirrors
  // main.ts's existing chainReader gating (rpcUrl && creditMarketAddress).
  rpcUrl?: string
  chainId: number
  clobSettlementAddress?: Address
  envFeeBps: number
  envFeeBpsWasSet: boolean
  refreshMs?: number
  timeoutMs?: number
}

export function createFeeSource(init: FeeSourceInit): FeeSource {
  let reader: IFeeBpsReader | undefined
  if (init.rpcUrl && init.clobSettlementAddress) {
    const chain = resolveViemChain(init.chainId, init.rpcUrl)
    const publicClient = createPublicClient({ chain, transport: http(init.rpcUrl) })
    reader = new ViemFeeBpsReader(publicClient as unknown as IPublicClient, init.clobSettlementAddress)
  }

  return new FeeSource({
    envFeeBps: init.envFeeBps,
    envFeeBpsWasSet: init.envFeeBpsWasSet,
    reader,
    refreshMs: init.refreshMs,
    timeoutMs: init.timeoutMs,
  })
}

// ─── Env parsing ──────────────────────────────────────────────────────────────

export const DEFAULT_ENV_FEE_BPS = 50
export const DEFAULT_FEE_REFRESH_MS = 60_000

/** FEE_BPS fallback value. Unset/blank/invalid/negative → default 50. */
export function parseEnvFeeBps(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') return DEFAULT_ENV_FEE_BPS
  const n = Number(raw.trim())
  if (!Number.isFinite(n) || n < 0) return DEFAULT_ENV_FEE_BPS
  return Math.trunc(n)
}

/** Whether FEE_BPS was actually set (vs. defaulted) — used for the "chain wins" mismatch warning. */
export function envFeeBpsWasSet(raw: string | undefined): boolean {
  return raw != null && raw.trim() !== ''
}

/**
 * FEE_REFRESH_MS — periodic refresh interval in ms. Unset/blank/invalid/negative
 * → default 60_000. 0 disables the periodic refresh (the one-shot startup
 * read still runs).
 */
export function parseFeeRefreshMs(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') return DEFAULT_FEE_REFRESH_MS
  const n = Number(raw.trim())
  if (!Number.isFinite(n) || n < 0) return DEFAULT_FEE_REFRESH_MS
  return Math.trunc(n)
}
