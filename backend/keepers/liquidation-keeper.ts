import http from 'http'
import path from 'path'
import fs from 'fs'
import { createPublicClient, defineChain, http as viemHttp } from 'viem'
import { baseSepolia } from 'viem/chains'
import type { Address } from 'viem'

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

export interface KeeperConfig {
  creditMarketAddress: Address
  yesTokenAddress: Address
  trackedHolders: Address[]
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

    for (const holder of this.config.trackedHolders) {
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
    console.log(`[liq-keeper] ${ts} — poll done: ${positions.length} claimable`)
  }

  getPositions(): ClaimablePosition[] {
    return this.positions
  }

  getLastPolledAt(): Date | null {
    return this.lastPolledAt
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

// ─── Production entry point ───────────────────────────────────────────────────

function main(): void {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL
  if (!rpcUrl) throw new Error('BASE_SEPOLIA_RPC_URL env var is required')

  let creditMarketAddress: string | undefined = process.env.CREDIT_MARKET_ADDRESS
  let yesTokenAddress: string | undefined     = process.env.YES_TOKEN_ADDRESS

  if (!creditMarketAddress || !yesTokenAddress) {
    const deploymentsPath = path.join(
      __dirname, '..', '..', 'contracts', 'deployments', 'base-sepolia.json',
    )
    const deployments = JSON.parse(fs.readFileSync(deploymentsPath, 'utf8')) as {
      creditMarket: string
      yesToken: string
    }
    creditMarketAddress ??= deployments.creditMarket
    yesTokenAddress     ??= deployments.yesToken
  }

  if (!creditMarketAddress) throw new Error('CREDIT_MARKET_ADDRESS is required')
  if (!yesTokenAddress)     throw new Error('YES_TOKEN_ADDRESS is required')

  const trackedHolders: Address[] = (process.env.TRACKED_HOLDERS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0) as Address[]

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

  const keeper = new LiquidationKeeper(
    publicClient as unknown as IPublicClient,
    {
      creditMarketAddress: creditMarketAddress as Address,
      yesTokenAddress:     yesTokenAddress as Address,
      trackedHolders,
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
