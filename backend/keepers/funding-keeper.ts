import http from 'http'
import path from 'path'
import fs from 'fs'
import cron from 'node-cron'
import { createPublicClient, createWalletClient, defineChain, http as viemHttp } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
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

  constructor(
    private readonly publicClient: IPublicClient,
    private readonly walletClient: IWalletClient,
    private readonly holderSource: IHolderSource,
    private readonly config: KeeperConfig,
  ) {
    this.tag = config.label ? `[keeper:${config.label}]` : '[keeper]'
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

    // 1. Gas estimate
    let gasEstimate: bigint
    try {
      gasEstimate = await this.publicClient.estimateContractGas({
        address:      this.config.creditMarketAddress,
        abi:          CREDIT_MARKET_ABI,
        functionName: 'accrueFunding',
        args:         [],
        account,
      })
    } catch (err) {
      console.error(`${this.tag} ${ts} — gas estimation failed:`, err)
      return false
    }

    const gas = (gasEstimate * 120n) / 100n  // +20% buffer

    // 2. Submit tx
    let txHash: Hash
    try {
      txHash = await this.walletClient.writeContract({
        address:      this.config.creditMarketAddress,
        abi:          CREDIT_MARKET_ABI,
        functionName: 'accrueFunding',
        gas,
      })
    } catch (err) {
      console.error(`${this.tag} ${ts} — accrueFunding tx failed:`, err)
      return false
    }

    console.log(`${this.tag} ${ts} — submitted ${txHash}`)

    // 3. Wait for receipt
    let receipt: { status: 'success' | 'reverted' }
    try {
      receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash })
    } catch (err) {
      console.error(`${this.tag} ${ts} — receipt wait failed for ${txHash}:`, err)
      return false
    }

    if (receipt.status !== 'success') {
      console.error(`${this.tag} ${ts} — accrueFunding REVERTED: ${txHash}`)
      return false
    }

    // 4. Read updated indices
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
        `${this.tag} ${ts} — accrueFunding OK  tx=${txHash}` +
        `  cumulativeFundingPerYES=${cumFundingYES.toString()}` +
        `  cumFundingPerNO=${cumFundingNO.toString()}`,
      )
    } catch (err) {
      // Non-fatal: tx succeeded, just couldn't read the updated value
      console.error(`${this.tag} ${ts} — could not read funding indices:`, err)
    }

    // 5. Record last successful run
    this.lastRunAt = new Date()
    return true
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

      // Flag claimable (freezes f_now for this holder)
      console.log(`${this.tag} ${ts} — ${holder}: seizable — flagging claimable…`)

      const account = this.walletClient.account!.address
      let flagGas: bigint
      try {
        flagGas = await this.publicClient.estimateContractGas({
          address:      this.config.creditMarketAddress,
          abi:          CREDIT_MARKET_ABI,
          functionName: 'flagClaimable',
          args:         [holder],
          account,
        })
      } catch (err) {
        console.error(`${this.tag} ${ts} — gas estimation for flagClaimable(${holder}) failed:`, err)
        return
      }

      let flagHash: Hash
      try {
        flagHash = await this.walletClient.writeContract({
          address:      this.config.creditMarketAddress,
          abi:          CREDIT_MARKET_ABI,
          functionName: 'flagClaimable',
          args:         [holder],
          gas:          (flagGas * 120n) / 100n,
        })
      } catch (err) {
        console.error(`${this.tag} ${ts} — flagClaimable(${holder}) tx failed:`, err)
        return
      }

      const flagReceipt = await this.publicClient.waitForTransactionReceipt({ hash: flagHash })
      if (flagReceipt.status !== 'success') {
        console.error(`${this.tag} ${ts} — flagClaimable(${holder}) REVERTED: ${flagHash}`)
        return
      }

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
}

export interface FundingHealthExtras {
  registry: MarketDirectoryStatus
  markets: Record<string, MarketHealth>
}

export class FundingKeeperService {
  private workers = new Map<string, IMarketWorker>()
  private cronTask: ScheduledTaskHandle | null = null
  private stopped = false
  private inFlightRun: Promise<void> | null = null

  constructor(
    private readonly directory: IMarketDirectory,
    private readonly makeWorker: (market: MarketInfo) => IMarketWorker,
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
    for (const [slug, w] of this.activeWorkers()) {
      markets[slug] = {
        lastRunAt: w.getLastRunAt()?.toISOString() ?? null,
        holderIndex: w.getHolderIndexStatus(),
      }
    }
    return { registry: this.directory.status(), markets }
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

  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL
  if (!rpcUrl) throw new Error('BASE_SEPOLIA_RPC_URL env var is required')

  // Legacy mode (no MARKET_REGISTRY_ADDRESS) keeps today's requirement: the single
  // market's addresses must resolve (env, or the local deployments file).
  const registryMode = !!process.env.MARKET_REGISTRY_ADDRESS?.trim()
  if (!registryMode) resolveAddresses()

  const account   = privateKeyToAccount(parsePrivateKey(privateKey, 'KEEPER_PRIVATE_KEY'))
  const transport = viemHttp(rpcUrl)

  // CHAIN_ID env var lets local Anvil (31337) work without code changes
  const chainId = parseInt(process.env.CHAIN_ID ?? '84532')
  const chain = chainId === baseSepolia.id
    ? baseSepolia
    : defineChain({ id: chainId, name: 'Local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } })

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
  ))

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
