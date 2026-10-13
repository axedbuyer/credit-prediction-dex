import http from 'http'
import path from 'path'
import fs from 'fs'
import cron from 'node-cron'
import { createPublicClient, createWalletClient, defineChain, http as viemHttp } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { chainFor, rpcUrlFromEnv } from './chains'
import type { Address, Hash } from 'viem'
import { createMarketHolderIndex, HolderIndexManager, aggregateHolderStatus } from './holder-index'
import type { ILogClient, HolderIndexStatus } from './holder-index'
import { installShutdownHandlers, closeHttpServer } from './shutdown'
import { buildDirectory } from './markets'
import type { IRegistryClient, MarketInfo, MarketDirectoryStatus } from './registry'

// ─── CreditMarket ABI (minimal) ───────────────────────────────────────────────

export const CREDIT_MARKET_ABI = [
  {
    name: 'accrueFunding',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [],
    outputs: [],
  },
  {
    name: 'lastFundingTime',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'cumulativeFundingPerYES',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'cumFundingPerNO',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'isSeizable',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'claimable',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'flagClaimable',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [],
  },
  {
    name: 'owed',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

// ─── Narrow client interfaces ─────────────────────────────────────────────────

export interface IPublicClient {
  estimateContractGas(args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
    account: Address
  }): Promise<bigint>
  waitForTransactionReceipt(args: {
    hash: Hash
  }): Promise<{ status: 'success' | 'reverted' }>
  readContract(args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args?: readonly unknown[]
  }): Promise<unknown>
  /** Optional — only needed by the low-ETH-balance alert (viem's PublicClient has it). */
  getBalance?(args: { address: Address }): Promise<bigint>
}

export interface IWalletClient {
  writeContract(args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args?: readonly unknown[]
    gas: bigint
  }): Promise<Hash>
  account: { address: Address } | undefined
}

// Narrow interface for the holder source — HolderIndex (holder-index.ts) satisfies
// this structurally. Lets tests inject a fake instead of driving a real backfill.
export interface IHolderSource {
  refresh(): Promise<void>
  holders(): Address[]
  status(): HolderIndexStatus
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface KeeperConfig {
  creditMarketAddress: Address
  /** Market slug — log prefix only (multi-market). */
  label?: string
  /** Retry tuning; defaults to retryConfigFromEnv(). Tests inject a no-op sleep / tiny base. */
  retry?: Partial<RetryConfig>
}

// ─── Retry + alert helpers ────────────────────────────────────────────────────

export interface RetryConfig {
  /** Total attempts per operation (1 = no retry). */
  maxAttempts: number
  /** Backoff base in ms: delay before retry n = base * 2^(n-1) + jitter(0..25% of that). */
  baseMs: number
  sleep: (ms: number) => Promise<void>
}

function positiveIntEnv(raw: string | undefined, fallback: number, min: number): number {
  const n = Number.parseInt((raw ?? '').trim(), 10)
  return Number.isFinite(n) && n >= min ? n : fallback
}

export function retryConfigFromEnv(env: NodeJS.ProcessEnv = process.env): RetryConfig {
  return {
    maxAttempts: positiveIntEnv(env.ACCRUE_MAX_ATTEMPTS, 4, 1),
    baseMs:      positiveIntEnv(env.ACCRUE_RETRY_BASE_MS, 2000, 0),
    sleep:       ms => new Promise(r => setTimeout(r, ms)),
  }
}

export function backoffDelayMs(baseMs: number, retryNumber: number, random: () => number = Math.random): number {
  const d = baseMs * 2 ** (retryNumber - 1)
  return Math.round(d + random() * d * 0.25)
}

const TRANSIENT_RE = new RegExp([
  'timeout', 'timed out', 'etimedout', 'econnreset', 'econnrefused', 'enotfound', 'eai_again',
  'epipe', 'socket', 'fetch failed', 'network', 'http request failed', 'httprequesterror',
  'rate limit', 'too many requests', '\\b429\\b', '\\b50[234]\\b', 'bad gateway',
  'service unavailable', 'gateway', 'internal error', 'missing response', 'header not found',
  'nonce too low', 'nonce has already been used', 'replacement transaction underpriced',
  'replacement fee too low', 'transaction underpriced', 'already known',
].join('|'), 'i')

/**
 * True only for errors worth retrying: RPC/network/timeouts and nonce/replacement races.
 * A contract revert (viem ContractFunctionRevertedError anywhere in the cause chain, or an
 * "execution reverted" message) is deterministic and NEVER transient — same decoding idea
 * as matching-engine/src/settler.ts decodeSettlementError.
 */
export function isTransientError(err: unknown): boolean {
  const seen = new Set<unknown>()
  let cur: unknown = err
  const texts: string[] = []
  for (let i = 0; i < 8 && cur && typeof cur === 'object' && !seen.has(cur); i++) {
    seen.add(cur)
    const e = cur as { name?: unknown; message?: unknown; shortMessage?: unknown; details?: unknown; code?: unknown; cause?: unknown }
    if (e.name === 'ContractFunctionRevertedError') return false
    for (const t of [e.name, e.message, e.shortMessage, e.details, e.code]) {
      if (typeof t === 'string') texts.push(t)
    }
    cur = e.cause
  }
  if (typeof err === 'string') texts.push(err)
  const all = texts.join(' | ')
  if (/execution reverted|reverted with/i.test(all)) return false
  return TRANSIENT_RE.test(all)
}

function briefError(err: unknown): string {
  const e = err as { shortMessage?: unknown; message?: unknown } | null
  const m = typeof e?.shortMessage === 'string' ? e.shortMessage : typeof e?.message === 'string' ? e.message : String(err)
  return m.split('\n')[0].slice(0, 300)
}


export interface AccrualState {
  consecutiveFailures: number
  lastSuccessAt: string | null
  lastError: string | null
}

/**
 * Low keeper-wallet ETH alert, shared by all markets (one wallet). Emits at most one
 * `[ALERT]` line per `intervalMs` (default 1h) while the balance stays below the threshold.
 */
export class LowBalanceMonitor {
  private lastAlertAt: number | null = null
  private lastBalance: bigint | null = null

  constructor(
    private readonly client: Pick<IPublicClient, 'getBalance'>,
    private readonly address: Address,
    private readonly minWei: bigint,
    private readonly intervalMs: number = 3_600_000,
    private readonly now: () => number = Date.now,
  ) {}

  async check(): Promise<void> {
    if (!this.client.getBalance) return
    let bal: bigint
    try {
      bal = await this.client.getBalance({ address: this.address })
    } catch (err) {
      console.error('[keeper] could not read keeper wallet ETH balance:', briefError(err))
      return
    }
    this.lastBalance = bal
    if (bal >= this.minWei) { this.lastAlertAt = null; return }
    const t = this.now()
    if (this.lastAlertAt !== null && t - this.lastAlertAt < this.intervalMs) return
    this.lastAlertAt = t
    console.error(
      `[ALERT] funding-keeper wallet low on ETH address=${this.address} ` +
      `balanceWei=${bal} minWei=${this.minWei} — accrueFunding/flagClaimable txs will fail; top up gas`,
    )
  }

  state(): { lowBalance: boolean; balanceWei: string | null; minWei: string } {
    return {
      lowBalance: this.lastBalance !== null && this.lastBalance < this.minWei,
      balanceWei: this.lastBalance?.toString() ?? null,
      minWei: this.minWei.toString(),
    }
  }
}

export function minEthWeiFromEnv(env: NodeJS.ProcessEnv = process.env): bigint {
  const raw = (env.KEEPER_MIN_ETH ?? '').trim()
  const eth = raw === '' ? 0.0005 : Number(raw)
  if (!Number.isFinite(eth) || eth < 0) return 500_000_000_000_000n
  return BigInt(Math.round(eth * 1e18))
}

// ─── Scheduler interface (injected for testability) ───────────────────────────

export interface ScheduledTaskHandle {
  stop(): void
}

export interface CronScheduler {
  schedule(expression: string, callback: () => void | Promise<void>): ScheduledTaskHandle
}

// ─── FundingKeeper ────────────────────────────────────────────────────────────

export class FundingKeeper {
  private lastRunAt: Date | null = null
  private cronTask: ScheduledTaskHandle | null = null
  private stopped = false
  private inFlightRun: Promise<void> | null = null
  private readonly tag: string
  private readonly retry: RetryConfig
  private consecutiveFailures = 0
  private lastSuccessAt: Date | null = null
  private lastError: string | null = null

  constructor(
    private readonly publicClient: IPublicClient,
    private readonly walletClient: IWalletClient,
    private readonly holderSource: IHolderSource,
    private readonly config: KeeperConfig,
  ) {
    this.tag = config.label ? `[keeper:${config.label}]` : '[keeper]'
    this.retry = { ...retryConfigFromEnv(), ...config.retry }
  }

  getAccrualState(): AccrualState {
    return {
      consecutiveFailures: this.consecutiveFailures,
      lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null,
      lastError: this.lastError,
    }
  }

  private recordSuccess(): void {
    this.consecutiveFailures = 0
    this.lastSuccessAt = new Date()
    this.lastError = null
  }

  private async readLastFundingTime(): Promise<bigint> {
    return await this.publicClient.readContract({
      address:      this.config.creditMarketAddress,
      abi:          CREDIT_MARKET_ABI,
      functionName: 'lastFundingTime',
      args:         [],
    }) as bigint
  }

  private async recordAccrualFailure(err: unknown, attempts: number): Promise<void> {
    this.consecutiveFailures++
    this.lastError = briefError(err)
    let behind = 'unknown'
    try {
      const last = await this.readLastFundingTime()
      const ageSec = Math.max(0, Math.floor(Date.now() / 1000) - Number(last))
      // Hours, not "epochs": on-chain epochLength (1 day) differs from the keeper's 8h cron.
      behind = (ageSec / 3600).toFixed(1) + 'h'
    } catch { /* RPC may be the very thing that is down */ }
    console.error(
      `[ALERT] funding-keeper accrual failed market=${this.config.label ?? 'default'} ` +
      `attempts=${attempts} sinceLastAccrual=${behind} consecutiveFailures=${this.consecutiveFailures} ` +
      `error=${this.lastError}`,
    )
  }

  /** Kick off holder-index discovery now (fire-and-forget); used by FundingKeeperService at boot. */
  warmHolderIndex(): void {
    this.holderSource.refresh().catch(err => {
      console.error(`${this.tag} holder index refresh failed at startup:`, err)
    })
  }

  /**
   * Single-market driver (kept for tests/local use). Production runs
   * FundingKeeperService, which drives one FundingKeeper per market through
   * runOnce().
   *
   * Register the 8-hour cron schedule. Also kicks off the holder-index backfill
   * immediately (fire-and-forget) so discovery starts at boot rather than waiting
   * for the first cron tick up to 8h later.
   * Pass a mock scheduler in tests to capture the callback and drive it manually.
   */
  start(scheduler: CronScheduler = cron): void {
    this.holderSource.refresh().catch(err => {
      console.error('[keeper] holder index refresh failed at startup:', err)
    })

    console.log('[keeper] scheduling accrueFunding @ "0 */8 * * *"')
    this.cronTask = scheduler.schedule('0 */8 * * *', async () => {
      // Guards against a tick that was already queued/firing the instant
      // stop() flipped this — the scheduler's own stop() prevents FUTURE
      // ticks, this only guards the race on the current one.
      if (this.stopped) return

      const run = this.runOnce().catch(err => {
        console.error('[keeper] unhandled error in runOnce:', err)
      })
      this.inFlightRun = run
      try {
        await run
      } finally {
        if (this.inFlightRun === run) this.inFlightRun = null
      }
    })
  }

  /**
   * Graceful-shutdown hook: stops scheduling new cron ticks, then — if a
   * runOnce() is currently in flight (it may be waiting on an
   * accrueFunding/flagClaimable tx receipt) — waits for it to finish rather
   * than abandoning a submitted transaction mid-flight. Safe to call once
   * during shutdown; idempotent if called again (no in-flight run left to
   * await).
   */
  async stop(): Promise<void> {
    this.stopped = true
    this.cronTask?.stop()
    if (this.inFlightRun) await this.inFlightRun
  }

  /**
   * Run one cycle, split into two independent phases:
   *
   *  Phase A — accrue(): estimate gas (+20% buffer), call accrueFunding(),
   *    wait for receipt, read the updated indices and log, then set
   *    lastRunAt — ONLY on full success (this is exactly what /health's
   *    lastRunAt reflects; unchanged from before).
   *  Phase B — checkHolders(): refresh the holder index and check every
   *    known YES holder for seizure, flagging newly-seizable ones.
   *
   * Phase B ALWAYS runs, whether or not Phase A succeeded: an RPC blip or a
   * revert at accrual time must not also cost up to 8h of missed
   * liquidation coverage — the two concerns are independent. Caveat:
   * isSeizable() reads the STORED cumulativeFundingPerYES (funding accrued
   * since lastFundingTime is not included), so checking against a failed
   * accrual may under-detect by the unaccrued interval — still strictly
   * better than not checking at all, and flagClaimable() re-accrues before
   * snapshotting, so a flag succeeds even off a stale index.
   *
   * Any failure in either phase (including an unexpected throw out of
   * accrue() itself) is logged and swallowed — the keeper stays alive and
   * will retry at the next scheduled tick.
   */
  async runOnce(): Promise<void> {
    const account = this.walletClient.account?.address
    if (!account) throw new Error('wallet client has no account')

    const ts = new Date().toISOString()

    let accrued = false
    try {
      accrued = await this.accrue(account, ts)
    } catch (err) {
      console.error(`${this.tag} ${ts} — unexpected error during accrual phase:`, err)
    }

    if (!accrued) {
      console.log(`${this.tag} ${ts} — accrual failed — seizure-checking anyway against the stored index`)
    }

    await this.checkHolders(ts)
  }

  /**
   * Phase A: accrueFunding(). Returns true only on full success (tx sent,
   * receipt succeeded) — that's the sole condition under which lastRunAt is
   * updated. Every failure point below logs and returns false rather than
   * throwing, so callers don't need a try/catch for the "expected" failure
   * modes (runOnce still wraps the call defensively for anything else).
   */
  private async accrue(account: Address, ts: string): Promise<boolean> {
    console.log(`${this.tag} ${ts} — accruing funding…`)

    const { maxAttempts } = this.retry
    // Snapshot BEFORE the first submission: a later lastFundingTime > t0 proves some
    // attempt (ours, even one whose receipt we lost) already accrued — never re-submit then.
    let t0: bigint | null = null
    try { t0 = await this.readLastFundingTime() } catch { /* re-read inside the attempt loop */ }

    let pendingHash: Hash | undefined
    let lastErr: unknown = new Error('no attempt made')
    let attempts = 0
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt
      try {
        if (attempt > 1) {
          const lf = await this.readLastFundingTime()
          if (t0 !== null && lf > t0) {
            console.log(`${this.tag} ${ts} — earlier attempt already landed (lastFundingTime ${t0} -> ${lf}); not re-submitting`)
            await this.logIndices(ts, pendingHash)
            this.recordSuccess()
            this.lastRunAt = new Date()
            return true
          }
          if (t0 === null) t0 = lf
        }

        if (!pendingHash) {
          const gasEstimate = await this.publicClient.estimateContractGas({
            address:      this.config.creditMarketAddress,
            abi:          CREDIT_MARKET_ABI,
            functionName: 'accrueFunding',
            args:         [],
            account,
          })
          const gas = (gasEstimate * 120n) / 100n  // +20% buffer
          pendingHash = await this.walletClient.writeContract({
            address:      this.config.creditMarketAddress,
            abi:          CREDIT_MARKET_ABI,
            functionName: 'accrueFunding',
            gas,
          })
          console.log(`${this.tag} ${ts} — submitted ${pendingHash}`)
        }

        const receipt = await this.publicClient.waitForTransactionReceipt({ hash: pendingHash })
        if (receipt.status !== 'success') {
          lastErr = new Error(`accrueFunding REVERTED: ${pendingHash}`)
          console.error(`${this.tag} ${ts} — accrueFunding REVERTED: ${pendingHash}`)
          break  // deterministic
        }
        await this.logIndices(ts, pendingHash)
        this.recordSuccess()
        this.lastRunAt = new Date()
        return true
      } catch (err) {
        lastErr = err
        const transient = isTransientError(err)
        console.error(
          `${this.tag} ${ts} — accrueFunding attempt ${attempt}/${maxAttempts} failed` +
          `${transient ? ' (transient)' : ' (not retryable)'}:`, briefError(err),
        )
        if (!transient) break
        if (attempt < maxAttempts) await this.retry.sleep(backoffDelayMs(this.retry.baseMs, attempt))
      }
    }
    await this.recordAccrualFailure(lastErr, attempts)
    return false
  }

  private async logIndices(ts: string, txHash: Hash | undefined): Promise<void> {
    try {
      const cumFundingYES = await this.publicClient.readContract({
        address:      this.config.creditMarketAddress,
        abi:          CREDIT_MARKET_ABI,
        functionName: 'cumulativeFundingPerYES',
        args:         [],
      }) as bigint

      const cumFundingNO = await this.publicClient.readContract({
        address:      this.config.creditMarketAddress,
        abi:          CREDIT_MARKET_ABI,
        functionName: 'cumFundingPerNO',
        args:         [],
      }) as bigint

      console.log(
        `${this.tag} ${ts} — accrueFunding OK  tx=${txHash ?? 'n/a'}` +
        `  cumulativeFundingPerYES=${cumFundingYES.toString()}` +
        `  cumFundingPerNO=${cumFundingNO.toString()}`,
      )
    } catch (err) {
      // Non-fatal: accrual succeeded, just couldn't read the updated value
      console.error(`${this.tag} ${ts} — could not read funding indices:`, err)
    }
  }

  /**
   * Phase B: refresh the holder index, then seizure-check every known YES
   * holder — flag newly-seizable ones. Runs unconditionally from runOnce,
   * independent of whether Phase A (accrual) succeeded.
   * refresh() never blocks on a long backfill (see holder-index.ts) — it
   * awaits only a cheap incremental sync once caught up.
   */
  private async checkHolders(ts: string): Promise<void> {
    await this.holderSource.refresh()
    const holders = this.holderSource.holders()
    const idxStatus = this.holderSource.status()
    console.log(
      `${this.tag} ${ts} — checking ${holders.length} holder(s) for seizure` +
      (idxStatus.backfillComplete
        ? ''
        : `  [holder index backfill INCOMPLETE — synced to block ${idxStatus.syncedToBlock ?? 'none'}]`),
    )
    for (const holder of holders) {
      await this.checkAndFlagHolder(holder, ts)
    }
  }

  /**
   * Check one holder for seizure eligibility and flag them claimable if:
   *   - not already claimable (would revert on-chain anyway, but skip to save gas)
   *   - isSeizable() returns true
   */
  private async checkAndFlagHolder(holder: Address, ts: string): Promise<void> {
    try {
      // Skip if already flagged claimable
      const alreadyClaimable = await this.publicClient.readContract({
        address:      this.config.creditMarketAddress,
        abi:          CREDIT_MARKET_ABI,
        functionName: 'claimable',
        args:         [holder],
      }) as boolean

      if (alreadyClaimable) {
        console.log(`${this.tag} ${ts} — ${holder}: already claimable, skipping`)
        return
      }

      // Check seizure trigger
      const seizable = await this.publicClient.readContract({
        address:      this.config.creditMarketAddress,
        abi:          CREDIT_MARKET_ABI,
        functionName: 'isSeizable',
        args:         [holder],
      }) as boolean

      if (!seizable) return

      // Flag claimable (locks this holder). Transient RPC/nonce errors are retried;
      // before each retry claimable() is re-read so a flag that already landed is never re-sent.
      console.log(`${this.tag} ${ts} — ${holder}: seizable — flagging claimable…`)

      const account = this.walletClient.account!.address
      let flagHash: Hash | undefined
      for (let attempt = 1; attempt <= this.retry.maxAttempts; attempt++) {
        try {
          if (attempt > 1 && !flagHash) {
            const done = await this.publicClient.readContract({
              address: this.config.creditMarketAddress, abi: CREDIT_MARKET_ABI,
              functionName: 'claimable', args: [holder],
            }) as boolean
            if (done) {
              console.log(`${this.tag} ${ts} — flagClaimable(${holder}) already landed; not re-sending`)
              return
            }
          }
          if (!flagHash) {
            const flagGas = await this.publicClient.estimateContractGas({
              address:      this.config.creditMarketAddress,
              abi:          CREDIT_MARKET_ABI,
              functionName: 'flagClaimable',
              args:         [holder],
              account,
            })
            flagHash = await this.walletClient.writeContract({
              address:      this.config.creditMarketAddress,
              abi:          CREDIT_MARKET_ABI,
              functionName: 'flagClaimable',
              args:         [holder],
              gas:          (flagGas * 120n) / 100n,
            })
          }
          const flagReceipt = await this.publicClient.waitForTransactionReceipt({ hash: flagHash })
          if (flagReceipt.status !== 'success') {
            console.error(`${this.tag} ${ts} — flagClaimable(${holder}) REVERTED: ${flagHash}`)
            return
          }
          break
        } catch (err) {
          const last = attempt >= this.retry.maxAttempts
          if (!isTransientError(err) || last) {
            console.error(`${this.tag} ${ts} — flagClaimable(${holder}) failed (attempt ${attempt}/${this.retry.maxAttempts}):`, err)
            return
          }
          console.error(`${this.tag} ${ts} — flagClaimable(${holder}) attempt ${attempt} transient failure, retrying:`, briefError(err))
          await this.retry.sleep(backoffDelayMs(this.retry.baseMs, attempt))
        }
      }
      if (!flagHash) return

      // Log the live funding obligation after successful flag. There is no freeze —
      // owed() keeps growing after this point until the position is claimed, cured,
      // or settled — this log is a snapshot, not a fixed value.
      try {
        const owedAmount = await this.publicClient.readContract({
          address:      this.config.creditMarketAddress,
          abi:          CREDIT_MARKET_ABI,
          functionName: 'owed',
          args:         [holder],
        }) as bigint

        console.log(
          `${this.tag} ${ts} — flagged ${holder}  tx=${flagHash}` +
          `  owed=${owedAmount.toString()}`,
        )
      } catch (err) {
        console.error(`${this.tag} ${ts} — could not read owed(${holder}):`, err)
      }
    } catch (err) {
      console.error(`${this.tag} ${ts} — unexpected error for holder ${holder}:`, err)
    }
  }

  getLastRunAt(): Date | null {
    return this.lastRunAt
  }

  getHolderIndexStatus(): HolderIndexStatus {
    return this.holderSource.status()
  }
}

// ─── FundingKeeperService — all markets ──────────────────────────────────────
//
// One FundingKeeper (the per-market worker above) per ACTIVE market in the
// MarketDirectory. Each cron tick runs the markets ONE AT A TIME: the keeper wallet
// is a single nonce stream, and every worker awaits its tx receipts, so sequential
// execution is what keeps accrueFunding/flagClaimable txs from colliding. Markets
// are isolated — a throw out of one market's cycle is logged and the next market
// still runs (and inside a market, an accrual failure still doesn't skip that
// market's seizure check — see FundingKeeper.runOnce).
//
// A market that appears on a later registry refresh gets its worker (and holder
// index, starting at its registry startBlock) on the next tick — or immediately via
// ensureWorkers(), called at start. Inactive markets are not run, but their holder
// indexes (and workers) are kept: indexes are never pruned.

export interface IMarketWorker {
  runOnce(): Promise<void>
  warmHolderIndex(): void
  getLastRunAt(): Date | null
  getHolderIndexStatus(): HolderIndexStatus
  getAccrualState?(): AccrualState
}

export interface IMarketDirectory {
  list(opts?: { activeOnly?: boolean }): MarketInfo[]
  bySlug(slug: string): MarketInfo | undefined
  status(): MarketDirectoryStatus
  mode: 'registry' | 'legacy'
}

export interface MarketHealth {
  lastRunAt: string | null
  holderIndex: HolderIndexStatus
  accrual?: AccrualState
}

export interface FundingHealthExtras {
  registry: MarketDirectoryStatus
  markets: Record<string, MarketHealth>
  alerts: {
    /** Markets whose last accrual cycle failed (consecutiveFailures > 0). */
    accrualFailing: Record<string, AccrualState>
    keeperBalance: ReturnType<LowBalanceMonitor['state']> | null
  }
}

export class FundingKeeperService {
  private workers = new Map<string, IMarketWorker>()
  private cronTask: ScheduledTaskHandle | null = null
  private stopped = false
  private inFlightRun: Promise<void> | null = null

  constructor(
    private readonly directory: IMarketDirectory,
    private readonly makeWorker: (market: MarketInfo) => IMarketWorker,
    private readonly balanceMonitor?: Pick<LowBalanceMonitor, 'check' | 'state'>,
  ) {}

  /** Create workers for any active market that doesn't have one yet (new registry entries). */
  private ensureWorkers(): MarketInfo[] {
    const active = this.directory.list({ activeOnly: true })
    for (const m of active) {
      if (!this.workers.has(m.slug)) {
        console.log(`[keeper] tracking market ${m.slug}`)
        const w = this.makeWorker(m)
        this.workers.set(m.slug, w)
        w.warmHolderIndex()
      }
    }
    return active
  }

  start(scheduler: CronScheduler = cron): void {
    this.ensureWorkers()
    console.log('[keeper] scheduling accrueFunding @ "0 */8 * * *"')
    this.cronTask = scheduler.schedule('0 */8 * * *', async () => {
      if (this.stopped) return
      await this.runAll()
    })
  }

  /** Single-flight: a tick that fires while a pass is still running joins it. */
  runAll(): Promise<void> {
    if (!this.inFlightRun) {
      this.inFlightRun = this.runAllInner()
        .catch(err => { console.error('[keeper] unhandled error in runAll:', err) })
        .finally(() => { this.inFlightRun = null })
    }
    return this.inFlightRun
  }

  private async runAllInner(): Promise<void> {
    const markets = this.ensureWorkers()
    try { await this.balanceMonitor?.check() } catch (err) {
      console.error('[keeper] balance check failed:', err)
    }
    for (const m of markets) {
      if (this.stopped) break
      const worker = this.workers.get(m.slug)!
      try {
        await worker.runOnce()
      } catch (err) {
        console.error(`[keeper:${m.slug}] market cycle failed (other markets continue):`, err)
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true
    this.cronTask?.stop()
    if (this.inFlightRun) await this.inFlightRun
  }

  private activeWorkers(): Array<[string, IMarketWorker]> {
    return [...this.workers].filter(([slug]) => this.directory.bySlug(slug)?.active)
  }

  /**
   * Oldest per-market last successful accrual — the worst case. null if any
   * tracked market has never accrued successfully (or none are tracked).
   */
  getLastRunAt(): Date | null {
    const ws = this.activeWorkers()
    if (ws.length === 0) return null
    let oldest: Date | null = null
    for (const [, w] of ws) {
      const t = w.getLastRunAt()
      if (t === null) return null
      if (oldest === null || t < oldest) oldest = t
    }
    return oldest
  }

  getHolderIndexStatus(): HolderIndexStatus {
    const by: Record<string, HolderIndexStatus> = {}
    for (const [slug, w] of this.activeWorkers()) by[slug] = w.getHolderIndexStatus()
    return aggregateHolderStatus(by, { prefixErrors: this.directory.mode === 'registry' })
  }

  getHealthExtras(): FundingHealthExtras {
    const markets: Record<string, MarketHealth> = {}
    const accrualFailing: Record<string, AccrualState> = {}
    for (const [slug, w] of this.activeWorkers()) {
      const accrual = w.getAccrualState?.()
      markets[slug] = {
        lastRunAt: w.getLastRunAt()?.toISOString() ?? null,
        holderIndex: w.getHolderIndexStatus(),
        ...(accrual ? { accrual } : {}),
      }
      if (accrual && accrual.consecutiveFailures > 0) accrualFailing[slug] = accrual
    }
    return {
      registry: this.directory.status(),
      markets,
      alerts: { accrualFailing, keeperBalance: this.balanceMonitor?.state() ?? null },
    }
  }
}

// ─── Health-check HTTP server ─────────────────────────────────────────────────

export interface IHealthSource {
  getLastRunAt(): Date | null
  getHolderIndexStatus(): HolderIndexStatus
  /** Multi-market additions (`registry`, `markets`) merged into /health. */
  getHealthExtras?(): object
}

export function startHealthServer(keeper: IHealthSource, port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        lastRunAt: keeper.getLastRunAt()?.toISOString() ?? null,
        schedule: '0 */8 * * *',
        holderIndex: keeper.getHolderIndexStatus(),
        ...(keeper.getHealthExtras?.() ?? {}),
      }))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  server.listen(port, () => {
    console.log(`[keeper] health check on http://0.0.0.0:${port}/health`)
  })
  return server
}

// ─── Contract address resolution (env var wins; deployments file is a local-dev
// fallback that does not exist inside containers, e.g. Railway) ───────────────

export function resolveAddresses(
  env: NodeJS.ProcessEnv = process.env,
  // Path: keepers/ → ../../ → project root → contracts/deployments/
  deploymentsPath: string = path.join(
    __dirname, '..', '..', 'contracts', 'deployments', 'base-sepolia.json',
  ),
): { creditMarketAddress: string; yesTokenAddress: string } {
  let creditMarketAddress: string | undefined = env.CREDIT_MARKET_ADDRESS
  let yesTokenAddress: string | undefined     = env.YES_TOKEN_ADDRESS

  if (!creditMarketAddress || !yesTokenAddress) {
    let deployments: { creditMarket?: string; yesToken?: string }
    try {
      deployments = JSON.parse(fs.readFileSync(deploymentsPath, 'utf8'))
    } catch (err) {
      const missing = [
        !creditMarketAddress ? 'CREDIT_MARKET_ADDRESS' : null,
        !yesTokenAddress ? 'YES_TOKEN_ADDRESS' : null,
      ].filter(Boolean).join(', ')
      throw new Error(
        `${missing} is not set and ${deploymentsPath} could not be read: ${err}. ` +
        `Set ${missing} (hosted images do not include the deployments file).`,
      )
    }
    creditMarketAddress ??= deployments.creditMarket
    yesTokenAddress     ??= deployments.yesToken
  }

  if (!creditMarketAddress) {
    throw new Error(
      `CREDIT_MARKET_ADDRESS is not set and ${deploymentsPath} has no "creditMarket" key. ` +
      'Set CREDIT_MARKET_ADDRESS (hosted images do not include the deployments file).',
    )
  }
  if (!yesTokenAddress) {
    throw new Error(
      `YES_TOKEN_ADDRESS is not set and ${deploymentsPath} has no "yesToken" key. ` +
      'Set YES_TOKEN_ADDRESS (hosted images do not include the deployments file).',
    )
  }

  return { creditMarketAddress, yesTokenAddress }
}

// Accepts a hex private key with or without the 0x prefix (wallet exports often
// omit it) and tolerates surrounding whitespace/quotes; throws a clear error
// naming the env var — never echoing the value — if it isn't 32 bytes of hex.
export function parsePrivateKey(raw: string, envName: string): `0x${string}` {
  const body = raw.trim().replace(/^['"]|['"]$/g, '').replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]{64}$/.test(body)) {
    throw new Error(`${envName} must be a 32-byte hex private key (64 hex chars, 0x optional)`)
  }
  return `0x${body}`
}

// ─── Production entry point ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const privateKey = process.env.KEEPER_PRIVATE_KEY
  if (!privateKey) throw new Error('KEEPER_PRIVATE_KEY env var is required')

  const rpcUrl = rpcUrlFromEnv()
  if (!rpcUrl) throw new Error('RPC_URL (or BASE_SEPOLIA_RPC_URL) env var is required')

  // Legacy mode (no MARKET_REGISTRY_ADDRESS) keeps today's requirement: the single
  // market's addresses must resolve (env, or the local deployments file).
  const registryMode = !!process.env.MARKET_REGISTRY_ADDRESS?.trim()
  if (!registryMode) resolveAddresses()

  const account   = privateKeyToAccount(parsePrivateKey(privateKey, 'KEEPER_PRIVATE_KEY'))
  const transport = viemHttp(rpcUrl)

  // CHAIN_ID env var lets local Anvil (31337) work without code changes
  const chainId = parseInt(process.env.CHAIN_ID ?? '84532')
  const chain = chainFor(chainId, rpcUrl)

  const publicClient  = createPublicClient({ chain, transport })
  const walletClient  = createWalletClient({ account, chain, transport })

  const directory = buildDirectory({ client: publicClient as unknown as IRegistryClient })
  await directory.start()

  const indexes = new HolderIndexManager(market =>
    createMarketHolderIndex(publicClient as unknown as ILogClient, market, chainId, directory.mode),
  )

  const keeper = new FundingKeeperService(directory, market => new FundingKeeper(
    publicClient  as unknown as IPublicClient,
    walletClient  as unknown as IWalletClient,
    indexes.get(market),
    { creditMarketAddress: market.creditMarket, label: market.slug },
  ), new LowBalanceMonitor(publicClient as unknown as IPublicClient, account.address, minEthWeiFromEnv()))

  keeper.start()
  const healthServer = startHealthServer(keeper, parseInt(process.env.HEALTH_PORT ?? '3002'))

  console.log(`[keeper] started (${directory.mode} mode, ${directory.list({ activeOnly: true }).length} active market(s))`)

  // Graceful shutdown: every Railway redeploy sends SIGTERM to this process
  // (it's PID 1 under the exec-form CMD `node -r ts-node/register`). Order:
  // stop scheduling new work and let an in-flight accrueFunding/flagClaimable
  // tx finish (keeper.stop()), THEN close the health server, stop the registry
  // refresh timer and release the holder indexes' Redis connections.
  installShutdownHandlers('funding-keeper', [
    { name: 'funding-keeper', run: () => keeper.stop() },
    { name: 'health-server', run: () => closeHttpServer(healthServer) },
    { name: 'registry', run: async () => directory.stop() },
    { name: 'holder-index', run: () => indexes.close() },
  ])
}

if (require.main === module) {
  main().catch(err => {
    console.error('[keeper] fatal:', err)
    process.exit(1)
  })
}
