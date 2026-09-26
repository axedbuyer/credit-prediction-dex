import http from 'http'
import path from 'path'
import fs from 'fs'
import { createPublicClient, defineChain, http as viemHttp } from 'viem'
import { baseSepolia } from 'viem/chains'
import type { Address } from 'viem'
import { createHolderIndex } from './holder-index'
import type { ILogClient, HolderIndexStatus } from './holder-index'

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
    name: 'frozenFunding',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'fundingDebt',
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
  notional: string       // YES balance (bigint as string)
  frozenFunding: string  // fFrozenTotal = prevDebt + frozenFundingPerUnit * Q / WAD
  tokenValue: string     // Q * currentMark / WAD
  claimPrice: string     // min(fFrozenTotal, tokenValue)
  tailCase: boolean
  frozen: boolean        // true while motionPending — claim() will revert
  frozenReason?: string  // only set when frozen === true
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

export function computePosition(
  user: string,
  Q: bigint,
  currentMark: bigint,
  frozenFundingPerUnit: bigint,
  prevDebt: bigint,
  motionPending: boolean,
): ClaimablePosition {
  const fFrozenTotal = prevDebt + (frozenFundingPerUnit * Q) / WAD
  const tokenValue   = (Q * currentMark) / WAD
  const tailCase     = fFrozenTotal > tokenValue
  const claimPrice   = tailCase ? tokenValue : fFrozenTotal

  const position: ClaimablePosition = {
    user,
    notional:      Q.toString(),
    frozenFunding: fFrozenTotal.toString(),
    tokenValue:    tokenValue.toString(),
    claimPrice:    claimPrice.toString(),
    tailCase,
    frozen:        motionPending,
  }
  if (motionPending) position.frozenReason = 'credit event under review'
  return position
}

// ─── LiquidationKeeper ────────────────────────────────────────────────────────

export class LiquidationKeeper {
  private positions: ClaimablePosition[] = []
  private lastPolledAt: Date | null = null
  private intervalHandle: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly publicClient: IPublicClient,
    private readonly holderSource: IHolderSource,
    private readonly config: KeeperConfig,
  ) {}

  start(): void {
    const interval = this.config.pollIntervalMs ?? 30_000
    console.log(`[liq-keeper] polling every ${interval / 1000}s`)
    // Fire immediately, then on every interval.
    this.poll().catch(err => console.error('[liq-keeper] initial poll error:', err))
    this.intervalHandle = setInterval(() => {
      this.poll().catch(err => console.error('[liq-keeper] poll error:', err))
    }, interval)
  }

  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
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

        const [frozenFundingPerUnit, prevDebt, Q] = await Promise.all([
          this.publicClient.readContract({
            address:      this.config.creditMarketAddress,
            abi:          CREDIT_MARKET_ABI,
            functionName: 'frozenFunding',
            args:         [holder],
          }) as Promise<bigint>,
          this.publicClient.readContract({
            address:      this.config.creditMarketAddress,
            abi:          CREDIT_MARKET_ABI,
            functionName: 'fundingDebt',
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
          frozenFundingPerUnit,
          prevDebt,
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

// ─── HTTP server ──────────────────────────────────────────────────────────────

export function startServer(keeper: LiquidationKeeper, port: number): http.Server {
  const server = http.createServer((req, res) => {
    // Permissive CORS — same rationale as order-book-server: this is a
    // local dev/demo read-only API with no auth/cookies, consumed directly
    // by the frontend's browser fetch(). Without this header the browser
    // silently blocks the response and the UI falls back to placeholder
    // fixtures even though /claimable itself returns real data.
    res.setHeader('Access-Control-Allow-Origin', '*')
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' })
      res.end()
      return
    }
    if (req.method === 'GET' && req.url === '/claimable') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(keeper.getPositions()))
    } else if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status:       'ok',
        lastPolledAt: keeper.getLastPolledAt()?.toISOString() ?? null,
        holderIndex:  keeper.getHolderIndexStatus(),
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

// ─── Production entry point ───────────────────────────────────────────────────

function main(): void {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL
  if (!rpcUrl) throw new Error('BASE_SEPOLIA_RPC_URL env var is required')

  const { creditMarketAddress, yesTokenAddress } = resolveAddresses()

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

  const holderSource = createHolderIndex(
    publicClient as unknown as ILogClient,
    yesTokenAddress as Address,
    chainId,
  )

  const keeper = new LiquidationKeeper(
    publicClient as unknown as IPublicClient,
    holderSource,
    {
      creditMarketAddress: creditMarketAddress as Address,
      yesTokenAddress:     yesTokenAddress as Address,
      pollIntervalMs,
    },
  )

  keeper.start()
  startServer(keeper, parseInt(process.env.PORT ?? '3003'))

  console.log('[liq-keeper] started')
}

if (require.main === module) {
  main()
}
