import http from 'http'
import path from 'path'
import fs from 'fs'
import { createPublicClient, defineChain, http as viemHttp } from 'viem'
import { baseSepolia } from 'viem/chains'
import type { Address } from 'viem'
import { createMarketHolderIndex, HolderIndexManager, aggregateHolderStatus } from './holder-index'
import type { ILogClient, HolderIndexStatus } from './holder-index'
import { installShutdownHandlers, closeHttpServer } from './shutdown'
import { buildDirectory } from './markets'
import type { IRegistryClient, MarketInfo, MarketDirectoryStatus } from './registry'

// ─── WAD constant (1e18, for fixed-point arithmetic) ──────────────────────────

const WAD = 1_000_000_000_000_000_000n

// ─── ABIs ─────────────────────────────────────────────────────────────────────

export const CREDIT_MARKET_ABI = [
  {
    name: 'claimable',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'owed',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'currentMark',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'motionPending',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

export const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface ClaimablePosition {
  user: string
  notional: string  // YES balance (bigint as string)
  owed: string      // owed(user) — ledger debt + live YES accrual projected to now;
                     // NOT frozen — this changes every poll while the position waits
                     // to be claimed (see CreditMarket.owed / LiquidationEngine.claim)
  tokenValue: string // Q * currentMark / WAD
  claimPrice: string  // min(owed, tokenValue) — priced fresh each poll, not fixed at flag time
  tailCase: boolean
  frozen: boolean        // true while motionPending — claim() will revert
  frozenReason?: string  // only set when frozen === true
}

/** A claimable position tagged with the market it lives in (what GET /claimable serves). */
export interface MarketClaimablePosition extends ClaimablePosition {
  market: string             // registry slug (`mstr` in legacy mode)
  creditMarket: string
  liquidationEngine: string  // claim() goes to THIS engine
}

export interface IPublicClient {
  readContract(args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args?: readonly unknown[]
  }): Promise<unknown>
}

// Narrow view of HolderIndex needed here — lets tests inject a fake without
// depending on the real Redis/RPC-backed implementation.
export interface IHolderSource {
  refresh(): Promise<void>
  holders(): Address[]
  status(): HolderIndexStatus
}

export interface KeeperConfig {
  creditMarketAddress: Address
  yesTokenAddress: Address
  pollIntervalMs?: number  // default 30_000
}

// ─── computePosition ─────────────────────────────────────────────────────────
// Pure formula — mirrors LiquidationEngine.sol claim() math exactly.
// `owed` is read straight from CreditMarket.owed(user) — no freeze, so this is
// priced at whatever block the caller read it in (the poll interval, here).

export function computePosition(
  user: string,
  Q: bigint,
  currentMark: bigint,
  owed: bigint,
  motionPending: boolean,
): ClaimablePosition {
  const tokenValue = (Q * currentMark) / WAD
  const tailCase   = owed > tokenValue
  const claimPrice = tailCase ? tokenValue : owed

  const position: ClaimablePosition = {
    user,
    notional:   Q.toString(),
    owed:       owed.toString(),
    tokenValue: tokenValue.toString(),
    claimPrice: claimPrice.toString(),
    tailCase,
    frozen:     motionPending,
  }
  if (motionPending) position.frozenReason = 'credit event under review'
  return position
}

// ─── LiquidationKeeper ────────────────────────────────────────────────────────

export class LiquidationKeeper {
  private positions: ClaimablePosition[] = []
  private lastPolledAt: Date | null = null
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private inFlightPoll: Promise<void> | null = null

  constructor(
    private readonly publicClient: IPublicClient,
    private readonly holderSource: IHolderSource,
    private readonly config: KeeperConfig,
  ) {}

  start(): void {
    const interval = this.config.pollIntervalMs ?? 30_000
    console.log(`[liq-keeper] polling every ${interval / 1000}s`)
    // Fire immediately, then on every interval.
    this.trackPoll(this.poll().catch(err => console.error('[liq-keeper] initial poll error:', err)))
    this.intervalHandle = setInterval(() => {
      if (this.stopped) return
      this.trackPoll(this.poll().catch(err => console.error('[liq-keeper] poll error:', err)))
    }, interval)
  }

  private trackPoll(p: Promise<void>): void {
    this.inFlightPoll = p
    void p.finally(() => {
      if (this.inFlightPoll === p) this.inFlightPoll = null
    })
  }

  /**
   * Graceful-shutdown hook: clears the poll interval (no more polls will
   * fire), then — if a poll() is currently in flight — waits for it to
   * finish before resolving.
   */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
    if (this.inFlightPoll) await this.inFlightPoll
  }

  async poll(): Promise<void> {
    const ts = new Date().toISOString()

    // Never blocks on a long backfill (see HolderIndex.refresh doc comment);
    // defensive try/catch so a rejecting source can't take the poll down —
    // the real HolderIndex never rejects (failures are swallowed internally
    // and surfaced via status().lastError instead).
    try {
      await this.holderSource.refresh()
    } catch (err) {
      console.error(`[liq-keeper] ${ts} — holder source refresh failed (continuing with known holders):`, err)
    }
    const holders = this.holderSource.holders()

    // Read market-level state first (single RPC calls shared across all holders).
    let currentMark: bigint
    let motionPending: boolean
    try {
      ;[currentMark, motionPending] = await Promise.all([
        this.publicClient.readContract({
          address:      this.config.creditMarketAddress,
          abi:          CREDIT_MARKET_ABI,
          functionName: 'currentMark',
        }) as Promise<bigint>,
        this.publicClient.readContract({
          address:      this.config.creditMarketAddress,
          abi:          CREDIT_MARKET_ABI,
          functionName: 'motionPending',
        }) as Promise<boolean>,
      ])
    } catch (err) {
      console.error(`[liq-keeper] ${ts} — failed to read market state:`, err)
      return
    }

    const positions: ClaimablePosition[] = []

    for (const holder of holders) {
      try {
        const isClaimable = await this.publicClient.readContract({
          address:      this.config.creditMarketAddress,
          abi:          CREDIT_MARKET_ABI,
          functionName: 'claimable',
          args:         [holder],
        }) as boolean

        if (!isClaimable) continue

        const [owed, Q] = await Promise.all([
          this.publicClient.readContract({
            address:      this.config.creditMarketAddress,
            abi:          CREDIT_MARKET_ABI,
            functionName: 'owed',
            args:         [holder],
          }) as Promise<bigint>,
          this.publicClient.readContract({
            address:      this.config.yesTokenAddress,
            abi:          ERC20_ABI,
            functionName: 'balanceOf',
            args:         [holder],
          }) as Promise<bigint>,
        ])

        const position = computePosition(
          holder,
          Q,
          currentMark,
          owed,
          motionPending,
        )

        positions.push(position)
        console.log(
          `[liq-keeper] ${ts} — ${holder}` +
          `  claimPrice=${position.claimPrice}` +
          `  tailCase=${position.tailCase}` +
          (motionPending ? '  [FROZEN: motion pending]' : ''),
        )
      } catch (err) {
        console.error(`[liq-keeper] ${ts} — error for holder ${holder}:`, err)
      }
    }

    this.positions = positions
    this.lastPolledAt = new Date()
    console.log(`[liq-keeper] ${ts} — poll done: ${positions.length} claimable (checked ${holders.length} holder(s))`)
  }

  getPositions(): ClaimablePosition[] {
    return this.positions
  }

  getLastPolledAt(): Date | null {
    return this.lastPolledAt
  }

  getHolderIndexStatus(): HolderIndexStatus {
    return this.holderSource.status()
  }
}

// ─── LiquidationKeeperService — all markets ──────────────────────────────────
//
// One LiquidationKeeper (per-market poller above) per market in the directory.
// Unlike the funding-keeper this covers INACTIVE markets too: claiming a flagged
// position is always desirable (stalls cost the InsuranceFund), and a market flipped
// inactive can still hold flagged positions. Markets poll independently — one
// market's RPC failure leaves the others' positions fresh.

export interface IMarketDirectory {
  list(opts?: { activeOnly?: boolean }): MarketInfo[]
  bySlug(slug: string): MarketInfo | undefined
  status(): MarketDirectoryStatus
  mode: 'registry' | 'legacy'
}

export interface IMarketPoller {
  poll(): Promise<void>
  getPositions(): ClaimablePosition[]
  getLastPolledAt(): Date | null
  getHolderIndexStatus(): HolderIndexStatus
}

export interface LiquidationMarketHealth {
  /** Lets external monitors (uptime.yml) check each market's CreditMarket on-chain without the registry. */
  creditMarket: string
  active: boolean
  lastPolledAt: string | null
  claimable: number
  holderIndex: HolderIndexStatus
}

export class LiquidationKeeperService {
  private pollers = new Map<string, IMarketPoller>()
  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private inFlightPoll: Promise<void> | null = null

  constructor(
    private readonly directory: IMarketDirectory,
    private readonly makePoller: (market: MarketInfo) => IMarketPoller,
    private readonly pollIntervalMs: number = 30_000,
  ) {}

  start(): void {
    console.log(`[liq-keeper] polling every ${this.pollIntervalMs / 1000}s`)
    this.trackPoll(this.poll().catch(err => console.error('[liq-keeper] initial poll error:', err)))
    this.intervalHandle = setInterval(() => {
      if (this.stopped) return
      this.trackPoll(this.poll().catch(err => console.error('[liq-keeper] poll error:', err)))
    }, this.pollIntervalMs)
  }

  private trackPoll(p: Promise<void>): void {
    this.inFlightPoll = p
    void p.finally(() => {
      if (this.inFlightPoll === p) this.inFlightPoll = null
    })
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
    if (this.inFlightPoll) await this.inFlightPoll
  }

  /** Poll every market concurrently; a market's failure is contained to that market. */
  async poll(): Promise<void> {
    const markets = this.directory.list()
    for (const m of markets) {
      if (!this.pollers.has(m.slug)) this.pollers.set(m.slug, this.makePoller(m))
    }
    await Promise.all(markets.map(async m => {
      try {
        await this.pollers.get(m.slug)!.poll()
      } catch (err) {
        console.error(`[liq-keeper:${m.slug}] poll failed:`, err)
      }
    }))
  }

  hasMarket(slug: string): boolean {
    return this.directory.bySlug(slug) !== undefined
  }

  /** All markets' positions (each tagged), or just one market's. */
  getPositions(slug?: string): MarketClaimablePosition[] {
    const out: MarketClaimablePosition[] = []
    for (const m of this.directory.list()) {
      if (slug !== undefined && m.slug !== slug) continue
      for (const p of this.pollers.get(m.slug)?.getPositions() ?? []) {
        out.push({
          ...p,
          market:            m.slug,
          creditMarket:      m.creditMarket,
          liquidationEngine: m.liquidationEngine,
        })
      }
    }
    return out
  }

  /** Oldest per-market poll — null if any market has not completed a poll yet. */
  getLastPolledAt(): Date | null {
    const markets = this.directory.list()
    if (markets.length === 0) return null
    let oldest: Date | null = null
    for (const m of markets) {
      const t = this.pollers.get(m.slug)?.getLastPolledAt() ?? null
      if (t === null) return null
      if (oldest === null || t < oldest) oldest = t
    }
    return oldest
  }

  private statusBySlug(): Record<string, HolderIndexStatus> {
    const by: Record<string, HolderIndexStatus> = {}
    for (const m of this.directory.list()) {
      const p = this.pollers.get(m.slug)
      if (p) by[m.slug] = p.getHolderIndexStatus()
    }
    return by
  }

  getHolderIndexStatus(): HolderIndexStatus {
    return aggregateHolderStatus(this.statusBySlug(), { prefixErrors: this.directory.mode === 'registry' })
  }

  getHealthExtras(): { registry: MarketDirectoryStatus; markets: Record<string, LiquidationMarketHealth> } {
    const markets: Record<string, LiquidationMarketHealth> = {}
    for (const m of this.directory.list()) {
      const p = this.pollers.get(m.slug)
      markets[m.slug] = {
        creditMarket: m.creditMarket,
        active:       m.active,
        lastPolledAt: p?.getLastPolledAt()?.toISOString() ?? null,
        claimable:    p?.getPositions().length ?? 0,
        holderIndex:  p?.getHolderIndexStatus() ?? { holders: 0, syncedToBlock: null, backfillComplete: false, lastSyncAt: null, lastError: null },
      }
    }
    return { registry: this.directory.status(), markets }
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
//
// CORS — same rationale as order-book-server: this is a read-only API with no
// auth/cookies, consumed directly by the frontend's browser fetch(). Without
// an ACAO header the browser silently blocks the response and the UI falls
// back to placeholder fixtures even though /claimable itself returns real
// data. No credentials are used, so a bare wildcard is safe and remains the
// default.
//
// corsOrigins (from CORS_ORIGINS env, parsed by parseCorsOrigins) lets an
// operator lock this down to an exact allow-list instead: unset/empty ⇒
// unchanged wildcard behaviour; otherwise only an exact Origin match gets
// echoed back (with Vary: Origin) and a non-matching/missing Origin gets no
// ACAO header at all.

/** What the HTTP server needs — LiquidationKeeper (single market) and LiquidationKeeperService both satisfy it. */
export interface IKeeperApi {
  getPositions(slug?: string): ClaimablePosition[]
  getLastPolledAt(): Date | null
  getHolderIndexStatus(): HolderIndexStatus
  /** Multi-market: false => GET /claimable?market=<slug> answers 404 UnknownMarket. */
  hasMarket?(slug: string): boolean
  /** Multi-market additions (`registry`, `markets`) merged into /health. */
  getHealthExtras?(): object
}

export function startServer(keeper: IKeeperApi, port: number, corsOrigins?: string[]): http.Server {
  const server = http.createServer((req, res) => {
    if (!corsOrigins || corsOrigins.length === 0) {
      res.setHeader('Access-Control-Allow-Origin', '*')
    } else {
      const origin = req.headers.origin
      if (origin && corsOrigins.includes(origin.trim().replace(/\/+$/, ''))) {
        res.setHeader('Access-Control-Allow-Origin', origin)
        res.setHeader('Vary', 'Origin')
      }
      // no match (or no Origin header) ⇒ omit Access-Control-Allow-Origin entirely
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' })
      res.end()
      return
    }
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (req.method === 'GET' && url.pathname === '/claimable') {
      // GET /claimable[?market=<slug>] — every entry carries market/creditMarket/
      // liquidationEngine; an unknown slug is a 404 {error:'UnknownMarket'}.
      const slug = url.searchParams.get('market')
      if (slug !== null && keeper.hasMarket && !keeper.hasMarket(slug)) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'UnknownMarket' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(slug !== null ? keeper.getPositions(slug) : keeper.getPositions()))
    } else if (req.method === 'GET' && url.pathname === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status:       'ok',
        lastPolledAt: keeper.getLastPolledAt()?.toISOString() ?? null,
        holderIndex:  keeper.getHolderIndexStatus(),
        ...(keeper.getHealthExtras?.() ?? {}),
      }))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  server.listen(port, () => {
    console.log(`[liq-keeper] HTTP on http://0.0.0.0:${port}`)
  })
  return server
}

// ─── Contract address resolution (env vars win; deployments file is a local-dev
// fallback that does not exist inside containers, e.g. Railway) ───────────────

export function resolveAddresses(
  env: NodeJS.ProcessEnv = process.env,
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

// ─── CORS_ORIGINS parsing ──────────────────────────────────────────────────────
//
// Mirrors order-book-server's parseCorsOrigins exactly: comma-separated
// allow-list of exact origins (e.g. "https://credit-prediction-dex.vercel.app,
// http://localhost:3000"). Unset, empty, or "*" preserves the wildcard
// default — see startServer's CORS handling above.

export function parseCorsOrigins(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === '*') return undefined
  const origins = trimmed.split(',')
    .map(o => o.trim().replace(/\/+$/, ''))
    .filter(o => o.length > 0)
  return origins.length > 0 ? origins : undefined
}

// ─── Production entry point ───────────────────────────────────────────────────

async function main(): Promise<void> {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL
  if (!rpcUrl) throw new Error('BASE_SEPOLIA_RPC_URL env var is required')

  // Legacy mode (no MARKET_REGISTRY_ADDRESS) keeps today's requirement: the single
  // market's addresses must resolve (env, or the local deployments file).
  if (!process.env.MARKET_REGISTRY_ADDRESS?.trim()) resolveAddresses()

  const pollIntervalMs = parseInt(process.env.POLL_INTERVAL_MS ?? '30000')

  const chainId   = parseInt(process.env.CHAIN_ID ?? '84532')
  const transport = viemHttp(rpcUrl)
  const chain     = chainId === baseSepolia.id
    ? baseSepolia
    : defineChain({
        id:             chainId,
        name:           'Local',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        rpcUrls:        { default: { http: [rpcUrl] } },
      })

  const publicClient = createPublicClient({ chain, transport })

  const directory = buildDirectory({ client: publicClient as unknown as IRegistryClient })
  await directory.start()

  const indexes = new HolderIndexManager(market =>
    createMarketHolderIndex(publicClient as unknown as ILogClient, market, chainId, directory.mode),
  )

  const keeper = new LiquidationKeeperService(
    directory,
    market => new LiquidationKeeper(
      publicClient as unknown as IPublicClient,
      indexes.get(market),
      {
        creditMarketAddress: market.creditMarket as Address,
        yesTokenAddress:     market.yesToken as Address,
        pollIntervalMs,
      },
    ),
    pollIntervalMs,
  )

  keeper.start()
  const server = startServer(keeper, parseInt(process.env.PORT ?? '3003'), parseCorsOrigins(process.env.CORS_ORIGINS))

  console.log(`[liq-keeper] started (${directory.mode} mode, ${directory.list().length} market(s))`)

  // Graceful shutdown: every Railway redeploy sends SIGTERM to this process
  // (it's PID 1 under the exec-form CMD `node -r ts-node/register`). Order:
  // stop polling and let an in-flight poll finish (keeper.stop()), THEN
  // close the HTTP server, stop the registry refresh and release the holder
  // indexes' Redis connections.
  installShutdownHandlers('liquidation-keeper', [
    { name: 'liquidation-keeper', run: () => keeper.stop() },
    { name: 'http-server', run: () => closeHttpServer(server) },
    { name: 'registry', run: async () => directory.stop() },
    { name: 'holder-index', run: () => indexes.close() },
  ])
}

if (require.main === module) {
  main().catch(err => {
    console.error('[liq-keeper] fatal:', err)
    process.exit(1)
  })
}
