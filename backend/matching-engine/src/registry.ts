// CANONICAL SOURCE: backend/shared/registry.ts — identical copies live in
// order-book-server/src/registry.ts, matching-engine/src/registry.ts and
// keepers/registry.ts (each service's Docker build context is its own directory, so
// there is no shared package). Edit HERE, then run `backend/shared/sync-registry.sh`;
// CI runs `sync-registry.sh --check` and fails on drift.
//
// MarketRegistry reader (docs/multi-market-design.md, root CLAUDE.md D5). The registry
// is append-only and entries are immutable except `active`, so a refresh can only ADD
// markets or flip `active` — a failed refresh keeps the last good list (fail-safe).
//
// Legacy mode: when no registry address is configured, the directory serves exactly
// one market, `mstr`, built from the pre-multi-market single-set env vars — so a
// service deployed before the registry exists behaves exactly as it did.

export type Hex = `0x${string}`

export const MARKET_REGISTRY_ABI = [
  {
    "type": "function",
    "name": "allMarkets",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "tuple[]",
        "internalType": "struct MarketRegistry.Market[]",
        "components": [
          {
            "name": "slug",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "entityName",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "entityType",
            "type": "uint8",
            "internalType": "enum MarketRegistry.EntityType"
          },
          {
            "name": "creditMarket",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "yesToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "noToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "clobSettlement",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "oracleRouter",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "liquidationEngine",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "active",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "registeredAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "startBlock",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "insuranceFund",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isRegisteredAddress",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "marketCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "marketIdOf",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "usdc",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "MarketActiveSet",
    "inputs": [
      {
        "name": "marketId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "active",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MarketRegistered",
    "inputs": [
      {
        "name": "marketId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "slug",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "creditMarket",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "yesToken",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "noToken",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "clobSettlement",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "oracleRouter",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "liquidationEngine",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  }
] as const

export type EntityType = 'corporate' | 'sovereign'

export interface MarketInfo {
  id: number
  slug: string
  entityName: string
  entityType: EntityType
  creditMarket: Hex
  yesToken: Hex
  noToken: Hex
  clobSettlement: Hex
  oracleRouter: Hex
  liquidationEngine: Hex
  active: boolean
  registeredAt: bigint
  /** Safe lower bound for log scans (holder index) — use this, NOT registeredAt. */
  startBlock: bigint
}

/** Minimal viem-compatible surface (PublicClient satisfies it). */
export interface IRegistryClient {
  readContract(args: {
    address: Hex
    abi: typeof MARKET_REGISTRY_ABI
    functionName: 'allMarkets'
  }): Promise<unknown>
}

interface RawMarket {
  slug: string
  entityName: string
  entityType: number
  creditMarket: Hex
  yesToken: Hex
  noToken: Hex
  clobSettlement: Hex
  oracleRouter: Hex
  liquidationEngine: Hex
  active: boolean
  registeredAt: bigint
  startBlock: bigint
}

export async function fetchMarkets(client: IRegistryClient, registry: Hex): Promise<MarketInfo[]> {
  const raw = (await client.readContract({
    address: registry,
    abi: MARKET_REGISTRY_ABI,
    functionName: 'allMarkets',
  })) as readonly RawMarket[]
  return raw.map((m, id) => ({
    id,
    slug: m.slug,
    entityName: m.entityName,
    entityType: m.entityType === 1 ? 'sovereign' : 'corporate',
    creditMarket: m.creditMarket,
    yesToken: m.yesToken,
    noToken: m.noToken,
    clobSettlement: m.clobSettlement,
    oracleRouter: m.oracleRouter,
    liquidationEngine: m.liquidationEngine,
    active: m.active,
    registeredAt: BigInt(m.registeredAt),
    startBlock: BigInt(m.startBlock),
  }))
}

export interface LegacyMarketEnv {
  creditMarket?: string
  yesToken?: string
  noToken?: string
  clobSettlement?: string
  oracleRouter?: string
  liquidationEngine?: string
  startBlock?: string | bigint
}

const ZERO: Hex = '0x0000000000000000000000000000000000000000'

/**
 * The single pre-registry market, as `mstr`. Returns null unless at least the
 * CreditMarket and YES token are known (services needing more — e.g. the CLOB —
 * must check the specific field is non-zero themselves).
 */
export function legacyMarket(env: LegacyMarketEnv): MarketInfo | null {
  if (!env.creditMarket || !env.yesToken) return null
  const a = (v?: string): Hex => (v ? (v as Hex) : ZERO)
  return {
    id: 0,
    slug: 'mstr',
    entityName: 'MicroStrategy',
    entityType: 'corporate',
    creditMarket: a(env.creditMarket),
    yesToken: a(env.yesToken),
    noToken: a(env.noToken),
    clobSettlement: a(env.clobSettlement),
    oracleRouter: a(env.oracleRouter),
    liquidationEngine: a(env.liquidationEngine),
    active: true,
    registeredAt: 0n,
    startBlock: env.startBlock !== undefined ? BigInt(env.startBlock) : 0n,
  }
}

export interface MarketDirectoryOptions {
  client?: IRegistryClient
  /** Registry mode when set; legacy mode otherwise. */
  registryAddress?: Hex
  /** Used only in legacy mode. */
  legacy?: MarketInfo | null
  /** Default 60s. */
  refreshMs?: number
  log?: (msg: string) => void
}

export interface MarketDirectoryStatus {
  mode: 'registry' | 'legacy'
  registryAddress: Hex | null
  marketCount: number
  lastRefreshAt: number | null
  lastError: string | null
}

export class MarketDirectory {
  private markets: MarketInfo[] = []
  private byAddr = new Map<string, MarketInfo>()
  private bySlugMap = new Map<string, MarketInfo>()
  private timer: ReturnType<typeof setInterval> | null = null
  private lastRefreshAt: number | null = null
  private lastError: string | null = null
  private readonly refreshMs: number
  private readonly log: (msg: string) => void

  constructor(private readonly opts: MarketDirectoryOptions) {
    this.refreshMs = opts.refreshMs ?? 60_000
    this.log = opts.log ?? ((m) => console.log(`[registry] ${m}`))
    if (!opts.registryAddress) {
      this.index(opts.legacy ? [opts.legacy] : [])
      this.lastRefreshAt = Date.now()
    }
  }

  get mode(): 'registry' | 'legacy' {
    return this.opts.registryAddress ? 'registry' : 'legacy'
  }

  /** Never throws; on failure keeps the last good list and records lastError. */
  async refresh(): Promise<void> {
    if (!this.opts.registryAddress) return
    if (!this.opts.client) throw new Error('MarketDirectory: registry mode requires a client')
    try {
      const next = await fetchMarkets(this.opts.client, this.opts.registryAddress)
      const added = next.length - this.markets.length
      this.index(next)
      this.lastRefreshAt = Date.now()
      this.lastError = null
      if (added > 0) this.log(`${added} new market(s); now ${next.map((m) => m.slug).join(', ')}`)
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
      this.log(`refresh failed (keeping ${this.markets.length} known market(s)): ${this.lastError}`)
    }
  }

  /** Initial refresh, then every refreshMs. */
  async start(): Promise<void> {
    await this.refresh()
    if (this.opts.registryAddress && !this.timer) {
      this.timer = setInterval(() => void this.refresh(), this.refreshMs)
      this.timer.unref?.()
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  list(opts: { activeOnly?: boolean } = {}): MarketInfo[] {
    return opts.activeOnly ? this.markets.filter((m) => m.active) : [...this.markets]
  }

  bySlug(slug: string): MarketInfo | undefined {
    return this.bySlugMap.get(slug)
  }

  /** Any of a market's six contract addresses → its market (case-insensitive). */
  byAddress(address: string): MarketInfo | undefined {
    return this.byAddr.get(address.toLowerCase())
  }

  status(): MarketDirectoryStatus {
    return {
      mode: this.mode,
      registryAddress: this.opts.registryAddress ?? null,
      marketCount: this.markets.length,
      lastRefreshAt: this.lastRefreshAt,
      lastError: this.lastError,
    }
  }

  private index(markets: MarketInfo[]): void {
    this.markets = markets
    this.byAddr.clear()
    this.bySlugMap.clear()
    for (const m of markets) {
      this.bySlugMap.set(m.slug, m)
      for (const a of [m.creditMarket, m.yesToken, m.noToken, m.clobSettlement, m.oracleRouter, m.liquidationEngine]) {
        if (a.toLowerCase() !== ZERO) this.byAddr.set(a.toLowerCase(), m)
      }
    }
  }
}
