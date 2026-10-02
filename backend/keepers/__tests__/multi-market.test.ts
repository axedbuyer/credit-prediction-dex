// Multi-market behaviour of the three keeper services (phase 2b): per-market holder
// indexes, funding-keeper isolation/ordering, GET /claimable market fields, liquidator-bot
// per-market claims + shared-float/InsuranceFund alerts, clob-seller domain, aggregate
// /health, and unchanged legacy mode.

import { describe, it, expect, vi } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import { verifyTypedData } from 'viem'
import type { Address, Hash } from 'viem'
import { MarketDirectory, type Hex, type IRegistryClient, type MarketInfo } from '../registry'
import { buildDirectory, legacyMarketFromEnv } from '../markets'
import {
  HolderIndexManager,
  aggregateHolderStatus,
  createMarketHolderIndex,
  TRANSFER_EVENT,
  type HolderIndexStatus,
  type ILogClient,
} from '../holder-index'
import { FundingKeeper, FundingKeeperService, startHealthServer, type CronScheduler, type IPublicClient as FundingPublic, type IWalletClient as FundingWallet } from '../funding-keeper'
import { LiquidationKeeper, LiquidationKeeperService, startServer, type IPublicClient as LiqPublic } from '../liquidation-keeper'
import {
  LiquidatorBot,
  DirectoryBotMarkets,
  floatShortfall,
  insuranceFundShortfall,
  startHealthServer as startBotHealth,
  type BotMarket,
  type IPublicClient as BotPublic,
  type IWalletClient as BotWallet,
  type LogLike,
  LIQUIDATION_ENGINE_ABI,
} from '../liquidator-bot'
import { ClobYesSeller } from '../clob-seller'
import type { IYesSeller } from '../seller'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const REG = '0x00000000000000000000000000000000000000aa' as Hex
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Hex
const KEEPER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as Address
const HOLDER_A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address
const HOLDER_B = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address
const USDC = addr(0xdd01)
const INSURANCE = addr(0xdd02)
const TX = ('0x' + 'ab'.repeat(32)) as Hash

function raw(slug: string, base: number, opts: { active?: boolean; startBlock?: bigint; registeredAt?: bigint } = {}) {
  return {
    slug, entityName: slug.toUpperCase(), entityType: 0,
    creditMarket: addr(base + 1), yesToken: addr(base + 2), noToken: addr(base + 3),
    clobSettlement: addr(base + 4), oracleRouter: addr(base + 5), liquidationEngine: addr(base + 6),
    active: opts.active ?? true, registeredAt: opts.registeredAt ?? 999n, startBlock: opts.startBlock ?? 5n,
  }
}
const MSTR = 0x100
const TRY = 0x200

/** A registry client whose market list can change between refreshes. */
function mutableRegistry(initial: ReturnType<typeof raw>[]) {
  let list = initial
  const client: IRegistryClient = { readContract: vi.fn(async () => list) }
  return { client, set(next: ReturnType<typeof raw>[]) { list = next } }
}

async function registryDirectory(markets: ReturnType<typeof raw>[]) {
  const reg = mutableRegistry(markets)
  const dir = new MarketDirectory({ client: reg.client, registryAddress: REG, log: () => {} })
  await dir.refresh()
  return { dir, reg }
}

function status(over: Partial<HolderIndexStatus> = {}): HolderIndexStatus {
  return { holders: 0, syncedToBlock: null, backfillComplete: false, lastSyncAt: null, lastError: null, ...over }
}

class FakeLogClient implements ILogClient {
  readonly calls: Array<{ address: string; fromBlock: bigint }> = []
  constructor(private readonly head = 100n) {}
  async getBlockNumber() { return this.head }
  async getLogs(args: { address: Address; event: typeof TRANSFER_EVENT; fromBlock: bigint; toBlock: bigint }) {
    this.calls.push({ address: args.address.toLowerCase(), fromBlock: args.fromBlock })
    return []
  }
}

// ─── Holder index per market ──────────────────────────────────────────────────

describe('per-market holder indexes', () => {
  it('registry mode scans each YES token from its registry startBlock, NOT registeredAt', async () => {
    const { dir } = await registryDirectory([
      raw('mstr', MSTR, { startBlock: 40n, registeredAt: 90n }),
      raw('try', TRY, { startBlock: 70n, registeredAt: 95n }),
    ])
    const client = new FakeLogClient(100n)
    const mgr = new HolderIndexManager(m => createMarketHolderIndex(client, m, 84532, dir.mode, {}))
    for (const m of dir.list()) await mgr.get(m).refresh()
    await new Promise(r => setTimeout(r, 20)) // refresh() backgrounds a not-yet-complete backfill
    const first = (yes: Address) => Math.min(...client.calls.filter(c => c.address === yes.toLowerCase()).map(c => Number(c.fromBlock)))
    expect(first(addr(MSTR + 2))).toBe(40)
    expect(first(addr(TRY + 2))).toBe(70)
    await mgr.close()
  })

  it('a market added on a later registry refresh gets its own index at ITS startBlock; existing index is reused', async () => {
    const { dir, reg } = await registryDirectory([raw('mstr', MSTR, { startBlock: 40n })])
    const client = new FakeLogClient(100n)
    const factory = vi.fn((m: MarketInfo) => createMarketHolderIndex(client, m, 84532, dir.mode, {}))
    const mgr = new HolderIndexManager(factory)
    const mstrIdx = mgr.get(dir.bySlug('mstr')!)
    reg.set([raw('mstr', MSTR, { startBlock: 40n }), raw('try', TRY, { startBlock: 77n })])
    await dir.refresh()
    expect(dir.list()).toHaveLength(2)
    const tryIdx = mgr.get(dir.bySlug('try')!)
    expect(tryIdx).not.toBe(mstrIdx)
    expect(mgr.get(dir.bySlug('mstr')!)).toBe(mstrIdx)
    expect(factory).toHaveBeenCalledTimes(2)
    await tryIdx.refresh()
    await new Promise(r => setTimeout(r, 20))
    expect(Math.min(...client.calls.filter(c => c.address === addr(TRY + 2).toLowerCase()).map(c => Number(c.fromBlock)))).toBe(77)
    await mgr.close()
  })

  it('legacy mode: HOLDER_INDEX_FROM_BLOCK applies (and is still required)', async () => {
    const client = new FakeLogClient(100n)
    const legacy = legacyMarketFromEnv({ CREDIT_MARKET_ADDRESS: addr(1), YES_TOKEN_ADDRESS: addr(2), HOLDER_INDEX_FROM_BLOCK: '33' } as NodeJS.ProcessEnv, '/nonexistent')!
    expect(legacy.slug).toBe('mstr')
    expect(legacy.startBlock).toBe(33n)
    const idx = createMarketHolderIndex(client, legacy, 84532, 'legacy', { HOLDER_INDEX_FROM_BLOCK: '33' })
    await idx.sync()
    expect(client.calls[0].fromBlock).toBe(33n)
    expect(() => createMarketHolderIndex(client, legacy, 84532, 'legacy', {})).toThrow(/HOLDER_INDEX_FROM_BLOCK/)
  })

  it('aggregateHolderStatus: worst case across markets, slug-prefixed first error', () => {
    const agg = aggregateHolderStatus({
      mstr: status({ holders: 3, syncedToBlock: '200', backfillComplete: true, lastSyncAt: '2026-10-02T10:00:00.000Z' }),
      try: status({ holders: 2, syncedToBlock: '150', backfillComplete: false, lastSyncAt: '2026-10-02T09:00:00.000Z', lastError: 'rate limited' }),
    }, { prefixErrors: true })
    expect(agg).toEqual({
      holders: 5, syncedToBlock: '150', backfillComplete: false,
      lastSyncAt: '2026-10-02T09:00:00.000Z', lastError: 'try: rate limited',
    })
    expect(aggregateHolderStatus({ a: status({ lastError: 'x' }) }).lastError).toBe('x') // legacy: unprefixed
    // a market that never synced makes the aggregate null/incomplete
    expect(aggregateHolderStatus({
      a: status({ syncedToBlock: '9', backfillComplete: true, lastSyncAt: '2026-10-02T10:00:00.000Z' }),
      b: status(),
    })).toMatchObject({ syncedToBlock: null, lastSyncAt: null, backfillComplete: false })
    expect(aggregateHolderStatus({ a: status({ backfillComplete: true, syncedToBlock: '1', lastSyncAt: 'z' }), b: status({ backfillComplete: true, syncedToBlock: '2', lastSyncAt: 'y' }) }).backfillComplete).toBe(true)
  })
})

// ─── funding-keeper ───────────────────────────────────────────────────────────

function fakeHolders(list: Address[] = []) {
  return { refresh: vi.fn().mockResolvedValue(undefined), holders: () => list, status: () => status({ holders: list.length, backfillComplete: true }) }
}

function makeScheduler() {
  let cb: (() => void | Promise<void>) | null = null
  const scheduler: CronScheduler = { schedule: (_e, c) => { cb = c; return { stop: vi.fn() } } }
  return { scheduler, fire: async () => { await cb!() } }
}

interface FundingChain {
  /** per creditMarket address: behaviours */
  failAccrue?: Set<string>        // estimate gas fails
  seizable?: Record<string, Address[]> // market -> holders seizable
  flagReverts?: Set<string>       // flagClaimable gas estimate fails (e.g. motionPending)
}

function fundingClients(cfg: FundingChain = {}) {
  const writes: Array<{ address: string; fn: string; args?: readonly unknown[] }> = []
  let inFlight = 0
  let maxInFlight = 0
  const publicClient: FundingPublic = {
    estimateContractGas: vi.fn(async ({ address, functionName, args }) => {
      const a = address.toLowerCase()
      if (functionName === 'accrueFunding' && cfg.failAccrue?.has(a)) throw new Error('rpc blip')
      if (functionName === 'flagClaimable' && cfg.flagReverts?.has(a)) throw new Error('MotionPending')
      void args
      return 100_000n
    }),
    waitForTransactionReceipt: vi.fn(async () => {
      await new Promise(r => setTimeout(r, 2))
      inFlight--
      return { status: 'success' as const }
    }),
    readContract: vi.fn(async ({ address, functionName, args }) => {
      const a = address.toLowerCase()
      if (functionName === 'claimable') return false
      if (functionName === 'isSeizable') return (cfg.seizable?.[a] ?? []).map(h => h.toLowerCase()).includes((args![0] as string).toLowerCase())
      return 0n
    }),
  }
  const walletClient: FundingWallet = {
    writeContract: vi.fn(async ({ address, functionName, args }) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      writes.push({ address: address.toLowerCase(), fn: functionName, args })
      return TX
    }),
    account: { address: KEEPER },
  }
  return { publicClient, walletClient, writes, maxInFlight: () => maxInFlight }
}

function fundingService(dir: MarketDirectory, chain: ReturnType<typeof fundingClients>, holdersBySlug: Record<string, Address[]> = {}) {
  return new FundingKeeperService(dir, m => new FundingKeeper(
    chain.publicClient, chain.walletClient, fakeHolders(holdersBySlug[m.slug] ?? []),
    { creditMarketAddress: m.creditMarket as Address, label: m.slug },
  ))
}

describe('FundingKeeperService', () => {
  it('accrues + seizure-checks every ACTIVE market; skips inactive ones', async () => {
    const { dir } = await registryDirectory([raw('mstr', MSTR), raw('try', TRY), raw('old', 0x300, { active: false })])
    const chain = fundingClients()
    const svc = fundingService(dir, chain)
    const { scheduler, fire } = makeScheduler()
    svc.start(scheduler)
    await fire()
    const accrued = chain.writes.filter(w => w.fn === 'accrueFunding').map(w => w.address)
    expect(accrued).toEqual([addr(MSTR + 1).toLowerCase(), addr(TRY + 1).toLowerCase()])
  })

  it('isolation: market A accrual failure does not stop B — and A is still seizure-checked and flagged', async () => {
    const { dir } = await registryDirectory([raw('mstr', MSTR), raw('try', TRY)])
    const chain = fundingClients({
      failAccrue: new Set([addr(MSTR + 1).toLowerCase()]),
      seizable: { [addr(MSTR + 1).toLowerCase()]: [HOLDER_A], [addr(TRY + 1).toLowerCase()]: [HOLDER_B] },
    })
    const svc = fundingService(dir, chain, { mstr: [HOLDER_A], try: [HOLDER_B] })
    await svc.runAll()
    const fnFor = (m: number) => chain.writes.filter(w => w.address === addr(m + 1).toLowerCase()).map(w => w.fn)
    expect(fnFor(MSTR)).toEqual(['flagClaimable'])               // accrual failed, check still ran
    expect(fnFor(TRY)).toEqual(['accrueFunding', 'flagClaimable']) // B unaffected
    // lastRunAt (worst case): mstr never accrued successfully -> null at the top level
    expect(svc.getLastRunAt()).toBeNull()
    const h = svc.getHealthExtras()
    expect(h.markets.mstr.lastRunAt).toBeNull()
    expect(h.markets.try.lastRunAt).not.toBeNull()
  })

  it('a worker that THROWS is contained: the next market still runs', async () => {
    const { dir } = await registryDirectory([raw('mstr', MSTR), raw('try', TRY)])
    const ran: string[] = []
    const svc = new FundingKeeperService(dir, m => ({
      runOnce: async () => { ran.push(m.slug); if (m.slug === 'mstr') throw new Error('boom') },
      warmHolderIndex: () => {},
      getLastRunAt: () => null,
      getHolderIndexStatus: () => status(),
    }))
    await svc.runAll()
    expect(ran).toEqual(['mstr', 'try'])
  })

  it('motionPending in one market (flag reverts) leaves the other market flaggable', async () => {
    const { dir } = await registryDirectory([raw('mstr', MSTR), raw('try', TRY)])
    const chain = fundingClients({
      seizable: { [addr(MSTR + 1).toLowerCase()]: [HOLDER_A], [addr(TRY + 1).toLowerCase()]: [HOLDER_B] },
      flagReverts: new Set([addr(MSTR + 1).toLowerCase()]), // mstr is frozen by a pending motion
    })
    const svc = fundingService(dir, chain, { mstr: [HOLDER_A], try: [HOLDER_B] })
    await svc.runAll()
    const flags = chain.writes.filter(w => w.fn === 'flagClaimable')
    expect(flags).toHaveLength(1)
    expect(flags[0].address).toBe(addr(TRY + 1).toLowerCase())
    expect(flags[0].args).toEqual([HOLDER_B])
  })

  it('txs for several markets are sent strictly one at a time (shared nonce stream)', async () => {
    const { dir } = await registryDirectory([raw('mstr', MSTR), raw('try', TRY), raw('crwv', 0x300)])
    const chain = fundingClients()
    await fundingService(dir, chain).runAll()
    expect(chain.writes).toHaveLength(3)
    expect(chain.maxInFlight()).toBe(1)
  })

  it('a market added on a registry refresh is picked up on the next pass', async () => {
    const { dir, reg } = await registryDirectory([raw('mstr', MSTR)])
    const chain = fundingClients()
    const svc = fundingService(dir, chain)
    await svc.runAll()
    expect(chain.writes).toHaveLength(1)
    reg.set([raw('mstr', MSTR), raw('try', TRY)])
    await dir.refresh()
    await svc.runAll()
    expect(chain.writes.map(w => w.address)).toEqual([addr(MSTR + 1), addr(MSTR + 1), addr(TRY + 1)].map(a => a.toLowerCase()))
  })

  it('/health keeps the top-level fields; lastRunAt = OLDEST per-market accrual; adds registry + markets', async () => {
    const { dir } = await registryDirectory([raw('mstr', MSTR), raw('try', TRY)])
    const t1 = new Date('2026-10-02T01:00:00Z')
    const t2 = new Date('2026-10-02T05:00:00Z')
    const workers: Record<string, { lastRun: Date | null; st: HolderIndexStatus }> = {
      mstr: { lastRun: t2, st: status({ holders: 1, syncedToBlock: '90', backfillComplete: true, lastSyncAt: 'b' }) },
      try:  { lastRun: t1, st: status({ holders: 2, syncedToBlock: '80', backfillComplete: false, lastSyncAt: 'a', lastError: 'rpc' }) },
    }
    const svc = new FundingKeeperService(dir, m => ({
      runOnce: async () => {}, warmHolderIndex: () => {},
      getLastRunAt: () => workers[m.slug].lastRun, getHolderIndexStatus: () => workers[m.slug].st,
    }))
    await svc.runAll()
    const server = startHealthServer(svc, 0)
    const port = (server.address() as { port: number }).port
    try {
      const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as Record<string, any>
      expect(body.status).toBe('ok')
      expect(body.schedule).toBe('0 */8 * * *')
      expect(body.lastRunAt).toBe(t1.toISOString())
      expect(body.holderIndex).toEqual({ holders: 3, syncedToBlock: '80', backfillComplete: false, lastSyncAt: 'a', lastError: 'try: rpc' })
      expect(body.registry).toMatchObject({ mode: 'registry', marketCount: 2, lastError: null })
      expect(Object.keys(body.markets)).toEqual(['mstr', 'try'])
      expect(body.markets.try).toEqual({ lastRunAt: t1.toISOString(), holderIndex: workers.try.st })
    } finally { server.close() }
  })

  it('legacy mode: one mstr market, unprefixed errors, same behaviour as a bare FundingKeeper', async () => {
    const legacy = legacyMarketFromEnv({ CREDIT_MARKET_ADDRESS: addr(0x501), YES_TOKEN_ADDRESS: addr(0x502), HOLDER_INDEX_FROM_BLOCK: '1' } as NodeJS.ProcessEnv, '/none')!
    const dir = buildDirectory({ client: { readContract: vi.fn() }, env: {} as NodeJS.ProcessEnv, legacy })
    await dir.start()
    expect(dir.mode).toBe('legacy')
    const chain = fundingClients()
    const svc = new FundingKeeperService(dir, m => new FundingKeeper(chain.publicClient, chain.walletClient,
      { refresh: async () => {}, holders: () => [], status: () => status({ lastError: 'blip' }) }, { creditMarketAddress: m.creditMarket as Address, label: m.slug }))
    await svc.runAll()
    expect(chain.writes).toEqual([{ address: addr(0x501).toLowerCase(), fn: 'accrueFunding', args: undefined }])
    expect(svc.getHolderIndexStatus().lastError).toBe('blip')
    expect(svc.getHealthExtras().registry.mode).toBe('legacy')
  })
})

// ─── liquidation-keeper ───────────────────────────────────────────────────────

const WAD = 10n ** 18n

function liqClient(perMarket: Record<string, { claimable: Address[]; mark?: bigint; motion?: boolean; owed?: bigint; fail?: boolean }>): LiqPublic {
  return {
    readContract: vi.fn(async ({ address, functionName, args }) => {
      const m = perMarket[address.toLowerCase()] ?? perMarket[Object.keys(perMarket).find(k => k === address.toLowerCase())!]
      // YES balanceOf is read from the yes token address: map by creditMarket+1
      const byYes = Object.entries(perMarket).find(([cm]) => BigInt(cm) + 1n === BigInt(address))
      const mk = m ?? byYes?.[1]
      if (!mk) throw new Error(`unexpected address ${address}`)
      if (mk.fail) throw new Error('rpc down')
      if (functionName === 'currentMark') return mk.mark ?? 50_000_000_000_000_000n
      if (functionName === 'motionPending') return mk.motion ?? false
      if (functionName === 'claimable') return mk.claimable.map(h => h.toLowerCase()).includes((args![0] as string).toLowerCase())
      if (functionName === 'owed') return mk.owed ?? 1_000n
      if (functionName === 'balanceOf') return 1_000_000n
      throw new Error(`unexpected ${functionName}`)
    }),
  }
}

describe('liquidation-keeper GET /claimable (multi-market)', () => {
  async function setup(over: Parameters<typeof liqClient>[0] = {}) {
    const { dir } = await registryDirectory([raw('mstr', MSTR), raw('try', TRY)])
    const client = liqClient({
      [addr(MSTR + 1).toLowerCase()]: { claimable: [HOLDER_A] },
      [addr(TRY + 1).toLowerCase()]: { claimable: [HOLDER_B], owed: 99_999_999n }, // tail case
      ...over,
    })
    const svc = new LiquidationKeeperService(dir, m => new LiquidationKeeper(client,
      fakeHolders([HOLDER_A, HOLDER_B]), { creditMarketAddress: m.creditMarket as Address, yesTokenAddress: m.yesToken as Address }))
    await svc.poll()
    const server = startServer(svc, 0)
    const port = (server.address() as { port: number }).port
    return { svc, server, url: (p: string) => `http://127.0.0.1:${port}${p}` }
  }

  it('tags every position with market / creditMarket / liquidationEngine', async () => {
    const { server, url } = await setup()
    try {
      const body = await (await fetch(url('/claimable'))).json() as any[]
      expect(body).toHaveLength(2)
      const m = body.find(p => p.market === 'mstr')
      expect(m).toMatchObject({
        user: HOLDER_A, creditMarket: addr(MSTR + 1), liquidationEngine: addr(MSTR + 6),
        notional: '1000000', tailCase: false, frozen: false,
      })
      expect(Object.keys(m).sort()).toEqual(['claimPrice', 'creditMarket', 'frozen', 'liquidationEngine', 'market', 'notional', 'owed', 'tailCase', 'tokenValue', 'user'])
      const t = body.find(p => p.market === 'try')
      expect(t).toMatchObject({ user: HOLDER_B, liquidationEngine: addr(TRY + 6), tailCase: true })
    } finally { server.close() }
  })

  it('?market=<slug> filters; unknown slug is 404 UnknownMarket; known-but-empty is []', async () => {
    const { server, url } = await setup({ [addr(TRY + 1).toLowerCase()]: { claimable: [] } })
    try {
      const one = await (await fetch(url('/claimable?market=mstr'))).json() as any[]
      expect(one.map(p => p.market)).toEqual(['mstr'])
      expect(await (await fetch(url('/claimable?market=try'))).json()).toEqual([])
      const res = await fetch(url('/claimable?market=nope'))
      expect(res.status).toBe(404)
      expect(await res.json()).toEqual({ error: 'UnknownMarket' })
    } finally { server.close() }
  })

  it('one market failing to poll leaves the other market current; /health aggregates', async () => {
    const { svc, server, url } = await setup({ [addr(TRY + 1).toLowerCase()]: { claimable: [], fail: true } })
    try {
      const body = await (await fetch(url('/claimable'))).json() as any[]
      expect(body.map(p => p.market)).toEqual(['mstr'])
      const h = await (await fetch(url('/health'))).json() as any
      expect(h.status).toBe('ok')
      expect(h.lastPolledAt).toBeNull() // try never completed a poll -> worst case
      expect(h.holderIndex).toMatchObject({ holders: 4, backfillComplete: true })
      expect(h.registry).toMatchObject({ mode: 'registry', marketCount: 2 })
      expect(h.markets.mstr).toMatchObject({ claimable: 1 })
      expect(h.markets.mstr.lastPolledAt).not.toBeNull()
      expect(h.markets.try).toMatchObject({ lastPolledAt: null, claimable: 0 })
      void svc
    } finally { server.close() }
  })

  it('legacy mode: one mstr market, plain array shape plus the three new fields', async () => {
    const legacy = legacyMarketFromEnv({ CREDIT_MARKET_ADDRESS: addr(MSTR + 1), YES_TOKEN_ADDRESS: addr(MSTR + 2), LIQUIDATION_ENGINE_ADDRESS: addr(MSTR + 6), HOLDER_INDEX_FROM_BLOCK: '1' } as NodeJS.ProcessEnv, '/none')!
    const dir = buildDirectory({ client: { readContract: vi.fn() }, env: {} as NodeJS.ProcessEnv, legacy })
    const client = liqClient({ [addr(MSTR + 1).toLowerCase()]: { claimable: [HOLDER_A] } })
    const svc = new LiquidationKeeperService(dir, m => new LiquidationKeeper(client, fakeHolders([HOLDER_A]),
      { creditMarketAddress: m.creditMarket as Address, yesTokenAddress: m.yesToken as Address }))
    await svc.poll()
    const server = startServer(svc, 0)
    const port = (server.address() as { port: number }).port
    try {
      const body = await (await fetch(`http://127.0.0.1:${port}/claimable`)).json() as any[]
      expect(body).toHaveLength(1)
      expect(body[0]).toMatchObject({ market: 'mstr', liquidationEngine: addr(MSTR + 6) })
      expect((await fetch(`http://127.0.0.1:${port}/claimable?market=mstr`)).status).toBe(200)
    } finally { server.close() }
  })
})

// ─── liquidator-bot ───────────────────────────────────────────────────────────

const MAX = 2n ** 256n - 1n

function liquidatedLog(engine: Address, holder: Address, yes: bigint, paid: bigint, tail: boolean): LogLike {
  // reuse the bot's own ABI to encode
  const { encodeEventTopics, encodeAbiParameters } = require('viem') as typeof import('viem')
  return {
    address: engine,
    topics: encodeEventTopics({ abi: LIQUIDATION_ENGINE_ABI, eventName: 'Liquidated', args: { originalHolder: holder, liquidator: KEEPER } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }], [yes, paid, tail]),
  }
}

interface BotWorld {
  usdc?: bigint
  insurance?: bigint
  /** per market (creditMarket address): */
  markets: Record<string, { mark?: bigint; claimable: Address[]; q?: bigint; owed?: bigint; motion?: boolean; yes?: bigint }>
}

function botClients(w: BotWorld) {
  const claims: Array<{ engine: string; holder: string }> = []
  const approvals: Array<{ token: string; spender: string }> = []
  const publicClient: BotPublic = {
    readContract: vi.fn(async ({ address, functionName, args }) => {
      const a = address.toLowerCase()
      const cm = w.markets[a]
      if (cm) {
        if (functionName === 'motionPending') return cm.motion ?? false
        if (functionName === 'currentMark') return cm.mark ?? 50_000_000_000_000_000n
        if (functionName === 'claimable') return cm.claimable.map(h => h.toLowerCase()).includes((args![0] as string).toLowerCase())
        if (functionName === 'owed') return cm.owed ?? 0n
      }
      const yesOwner = Object.entries(w.markets).find(([c]) => BigInt(c) + 1n === BigInt(address))
      if (yesOwner) {
        if (functionName === 'balanceOf') return (args![0] as string).toLowerCase() === KEEPER.toLowerCase() ? (yesOwner[1].yes ?? 0n) : (yesOwner[1].q ?? 1_000_000n)
        if (functionName === 'allowance') return MAX
      }
      if (a === USDC.toLowerCase()) {
        if (functionName === 'balanceOf') return (args![0] as string).toLowerCase() === INSURANCE.toLowerCase() ? (w.insurance ?? 10n ** 12n) : (w.usdc ?? 10n ** 12n)
        if (functionName === 'allowance') return approvals.some(x => x.spender.toLowerCase() === (args![1] as string).toLowerCase()) ? MAX : 0n
      }
      throw new Error(`unexpected read ${functionName} @ ${address}`)
    }),
    estimateContractGas: vi.fn(async () => 100_000n),
    waitForTransactionReceipt: vi.fn(async () => ({ status: 'success' as const, logs: [] })),
  }
  const walletClient: BotWallet = {
    writeContract: vi.fn(async ({ address, functionName, args }) => {
      if (functionName === 'claim') claims.push({ engine: address.toLowerCase(), holder: (args![0] as string) })
      if (functionName === 'approve') approvals.push({ token: address.toLowerCase(), spender: args![0] as string })
      return TX
    }),
    account: { address: KEEPER },
  }
  return { publicClient, walletClient, claims, approvals }
}

function botMarket(slug: string, base: number, holders: Address[], seller?: IYesSeller): BotMarket {
  return {
    slug,
    creditMarketAddress: addr(base + 1), yesTokenAddress: addr(base + 2), liquidationEngineAddress: addr(base + 6), clobSettlementAddress: addr(base + 4),
    holderSource: fakeHolders(holders), seller: seller ?? { sell: vi.fn().mockResolvedValue({ action: 'skipped', reason: 'x' }) },
  }
}

function makeBot(markets: BotMarket[], clients: ReturnType<typeof botClients>, autoSell = false) {
  const provider = { markets: () => markets, registryStatus: () => ({ mode: 'registry' as const, registryAddress: REG, marketCount: markets.length, lastRefreshAt: 1, lastError: null }) }
  return new LiquidatorBot(clients.publicClient, clients.walletClient, provider, { usdcAddress: USDC, insuranceFundAddress: INSURANCE, pollIntervalMs: 1e9, autoSell })
}

describe('LiquidatorBot — multi-market', () => {
  it('claims each flagged position through THAT market\'s LiquidationEngine and approves USDC per engine', async () => {
    const clients = botClients({ markets: {
      [addr(MSTR + 1).toLowerCase()]: { claimable: [HOLDER_A] },
      [addr(TRY + 1).toLowerCase()]:  { claimable: [HOLDER_B] },
    } })
    const bot = makeBot([botMarket('mstr', MSTR, [HOLDER_A, HOLDER_B]), botMarket('try', TRY, [HOLDER_A, HOLDER_B])], clients)
    await bot.runCycle()
    expect(clients.claims).toEqual([
      { engine: addr(MSTR + 6).toLowerCase(), holder: HOLDER_A },
      { engine: addr(TRY + 6).toLowerCase(), holder: HOLDER_B },
    ])
    expect(clients.approvals.map(a => a.spender.toLowerCase())).toEqual([addr(MSTR + 6).toLowerCase(), addr(TRY + 6).toLowerCase()])
    const h = bot.getHealth()
    expect(h.claims).toBe(2)
    expect(h.markets!.mstr.claims).toBe(1)
    expect(h.markets!.try.claims).toBe(1)
  })

  it('motionPending in one market skips only that market; failing market state read skips only that market', async () => {
    const clients = botClients({ markets: {
      [addr(MSTR + 1).toLowerCase()]: { claimable: [HOLDER_A], motion: true },
      [addr(TRY + 1).toLowerCase()]:  { claimable: [HOLDER_B] },
    } })
    const bot = makeBot([botMarket('mstr', MSTR, [HOLDER_A]), botMarket('try', TRY, [HOLDER_B])], clients)
    await bot.runCycle()
    expect(clients.claims.map(c => c.holder)).toEqual([HOLDER_B])
    expect(bot.getHealth().markets!.mstr.skippedByReason).toEqual({ motionPending: 1 })
    expect(bot.getHealth().markets!.mstr.motionPending).toBe(true)
  })

  it('float alert compares against the LARGEST single pending claim, not the sum', () => {
    expect(floatShortfall(60n, [50n, 50n, 40n])).toBe(0n)       // sum 140 > 60, but max 50 <= 60
    expect(floatShortfall(40n, [50n, 50n, 40n])).toBe(10n)      // short by max - balance
    expect(floatShortfall(1n, [])).toBe(0n)
  })

  it('end-of-cycle float alert fires on max (not sum) and is exposed on /health', async () => {
    // balance covers one 50_000 claim but the claims are blocked by a failing simulate -> they stay pending
    const clients = botClients({ usdc: 60_000n, markets: {
      [addr(MSTR + 1).toLowerCase()]: { claimable: [HOLDER_A] },
      [addr(TRY + 1).toLowerCase()]:  { claimable: [HOLDER_B] },
    } })
    ;(clients.publicClient.estimateContractGas as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('sim failed'))
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bot = makeBot([botMarket('mstr', MSTR, [HOLDER_A]), botMarket('try', TRY, [HOLDER_B])], clients)
    await bot.runCycle()
    const alerts = bot.getHealth().alerts!
    expect(alerts.largestPendingClaim).toBe('50000')   // Q 1e6 × mark 0.05 = 50_000 each; max, not 100_000
    expect(alerts.floatShortfall).toBe('0')            // 60_000 covers the largest single claim
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('float short'))).toBe(false)
    errSpy.mockRestore()

    const clients2 = botClients({ usdc: 40_000n, markets: {
      [addr(MSTR + 1).toLowerCase()]: { claimable: [HOLDER_A] },
      [addr(TRY + 1).toLowerCase()]:  { claimable: [HOLDER_B] },
    } })
    const errSpy2 = vi.spyOn(console, 'error').mockImplementation(() => {})
    const bot2 = makeBot([botMarket('mstr', MSTR, [HOLDER_A]), botMarket('try', TRY, [HOLDER_B])], clients2)
    await bot2.runCycle()
    expect(bot2.getHealth().alerts!.floatShortfall).toBe('10000')
    expect(errSpy2.mock.calls.some(c => String(c[0]).includes('USDC float short'))).toBe(true)
    errSpy2.mockRestore()
  })

  it('InsuranceFund alert uses the SUM of concurrent tail-case shortfalls across markets', async () => {
    expect(insuranceFundShortfall(1_000n, [600n, 600n])).toBe(200n)  // each fits alone, together they do not
    expect(insuranceFundShortfall(1_200n, [600n, 600n])).toBe(0n)
    // tail: owed 50_000 + 700 each => 700 shortfall per market (m×Q = 50_000)
    const world = (insurance: bigint): BotWorld => ({ insurance, markets: {
      [addr(MSTR + 1).toLowerCase()]: { claimable: [HOLDER_A], owed: 50_700n },
      [addr(TRY + 1).toLowerCase()]:  { claimable: [HOLDER_B], owed: 50_700n },
    } })
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const c1 = botClients(world(1_000n)) // covers one 700, not 1_400
    const bot1 = makeBot([botMarket('mstr', MSTR, [HOLDER_A]), botMarket('try', TRY, [HOLDER_B])], c1)
    await bot1.runCycle()
    expect(bot1.getHealth().alerts).toMatchObject({ pendingTailShortfall: '1400', insuranceFundShortfall: '400' })
    expect(errSpy.mock.calls.some(c => String(c[0]).includes('shared InsuranceFund short'))).toBe(true)
    expect(bot1.getHealth().markets!.try.pendingTailShortfall).toBe('700')
    const c2 = botClients(world(5_000n))
    const bot2 = makeBot([botMarket('mstr', MSTR, [HOLDER_A]), botMarket('try', TRY, [HOLDER_B])], c2)
    await bot2.runCycle()
    expect(bot2.getHealth().alerts!.insuranceFundShortfall).toBe('0')
    errSpy.mockRestore()
  })

  it('sells per market: that market\'s seller, YES token allowance to its CLOB, and ITS currentMark', async () => {
    const sellerA = { sell: vi.fn().mockResolvedValue({ action: 'rested' }) }
    const sellerB = { sell: vi.fn().mockResolvedValue({ action: 'rested' }) }
    const clients = botClients({ markets: {
      [addr(MSTR + 1).toLowerCase()]: { claimable: [], mark: 50_000_000_000_000_000n, yes: 7n },
      [addr(TRY + 1).toLowerCase()]:  { claimable: [], mark: 120_000_000_000_000_000n, yes: 9n },
    } })
    const bot = makeBot([botMarket('mstr', MSTR, [], sellerA), botMarket('try', TRY, [], sellerB)], clients, true)
    await bot.runCycle()
    expect(sellerA.sell).toHaveBeenCalledWith({ yesAmount: 7n, markWad: 50_000_000_000_000_000n })
    expect(sellerB.sell).toHaveBeenCalledWith({ yesAmount: 9n, markWad: 120_000_000_000_000_000n })
    expect(bot.getHealth().yesBalance).toBe('16')
  })

  it('/health keeps every legacy top-level field and adds registry + markets + alerts', async () => {
    const clients = botClients({ markets: { [addr(MSTR + 1).toLowerCase()]: { claimable: [] }, [addr(TRY + 1).toLowerCase()]: { claimable: [] } } })
    const mk = [botMarket('mstr', MSTR, []), botMarket('try', TRY, [])]
    ;(mk[1].holderSource as any).status = () => status({ holders: 1, lastError: 'rpc' })
    const bot = makeBot(mk, clients)
    await bot.runCycle()
    const server = startBotHealth(bot, 0)
    const port = (server.address() as { port: number }).port
    try {
      const body = await (await fetch(`http://127.0.0.1:${port}/health`)).json() as any
      for (const k of ['status', 'lastCycleAt', 'claims', 'tailClaims', 'skippedByReason', 'lastError', 'usdcBalance', 'yesBalance', 'holderIndex']) expect(body).toHaveProperty(k)
      expect(body.holderIndex.lastError).toBe('try: rpc')
      expect(body.registry.mode).toBe('registry')
      expect(Object.keys(body.markets)).toEqual(['mstr', 'try'])
      expect(body.alerts).toBeDefined()
    } finally { server.close() }
  })

  it('DirectoryBotMarkets builds each market once and follows registry additions', async () => {
    const { dir, reg } = await registryDirectory([raw('mstr', MSTR)])
    const make = vi.fn((m: MarketInfo) => botMarket(m.slug, Number(BigInt(m.creditMarket) - 1n), []))
    const p = new DirectoryBotMarkets(dir, make)
    expect(p.markets().map(m => m.slug)).toEqual(['mstr'])
    reg.set([raw('mstr', MSTR), raw('try', TRY)])
    await dir.refresh()
    expect(p.markets().map(m => m.slug)).toEqual(['mstr', 'try'])
    expect(make).toHaveBeenCalledTimes(2)
    expect(p.registryStatus().marketCount).toBe(2)
  })
})

// ─── clob-seller: per-market domain / token / book ────────────────────────────

describe('ClobYesSeller — per market', () => {
  const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80')
  const ORDER_TYPES = { Order: [
    { name: 'maker', type: 'address' }, { name: 'tokenIn', type: 'address' }, { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' }, { name: 'minAmountOut', type: 'uint256' }, { name: 'expiry', type: 'uint256' }, { name: 'nonce', type: 'uint256' },
  ] } as const

  function mkSeller(base: number, slug: string | undefined) {
    const urls: string[] = []
    const posted: any[] = []
    const fetchImpl = vi.fn(async (url: string, init?: any) => {
      urls.push(url)
      if (init?.method === 'POST') { posted.push(JSON.parse(init.body)); return new Response(JSON.stringify({ orderId: 'o1' }), { status: 201 }) }
      return new Response(JSON.stringify({ bids: [], asks: [] }), { status: 200 })
    })
    const seller = new ClobYesSeller({
      orderBookUrl: 'http://ob', chainId: 84532, clobSettlementAddress: addr(base + 4), yesTokenAddress: addr(base + 2),
      usdcAddress: USDC, account, marketSlug: slug, fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    return { seller, urls, posted }
  }

  it('signs for THAT market\'s CLOBSettlement domain with THAT market\'s YES token, and reads ?market=<slug>', async () => {
    const b = mkSeller(TRY, 'try')
    const res = await b.seller.sell({ yesAmount: 1_000_000n, markWad: 100_000_000_000_000_000n })
    expect(res.action).toBe('rested')
    expect(b.urls[0]).toBe('http://ob/orderbook?market=try')
    const o = b.posted[0]
    expect(o.tokenIn.toLowerCase()).toBe(addr(TRY + 2).toLowerCase())
    const msg = { maker: o.maker, tokenIn: o.tokenIn, tokenOut: o.tokenOut, amountIn: BigInt(o.amountIn), minAmountOut: BigInt(o.minAmountOut), expiry: BigInt(o.expiry), nonce: BigInt(o.nonce) }
    const dom = (base: number) => ({ name: 'CLOBSettlement', version: '1', chainId: 84532, verifyingContract: addr(base + 4) })
    expect(await verifyTypedData({ address: account.address, domain: dom(TRY), types: ORDER_TYPES, primaryType: 'Order', message: msg, signature: o.signature })).toBe(true)
    expect(await verifyTypedData({ address: account.address, domain: dom(MSTR), types: ORDER_TYPES, primaryType: 'Order', message: msg, signature: o.signature })).toBe(false)
  })

  it('legacy (no marketSlug): plain /orderbook, unchanged', async () => {
    const b = mkSeller(MSTR, undefined)
    await b.seller.sell({ yesAmount: 1_000_000n, markWad: 50_000_000_000_000_000n })
    expect(b.urls[0]).toBe('http://ob/orderbook')
  })

  it('SELL_MAX_DISCOUNT_BPS floor is relative to that market\'s own mark', async () => {
    // best bid 0.11 on a market whose mark is 0.12 (floor 0.1164 at 3%): below floor => rests at the mark, not the bid
    const urls: string[] = []
    const posted: any[] = []
    const fetchImpl = vi.fn(async (url: string, init?: any) => {
      urls.push(url)
      if (init?.method === 'POST') { posted.push(JSON.parse(init.body)); return new Response(JSON.stringify({ orderId: 'o' }), { status: 201 }) }
      return new Response(JSON.stringify({ bids: [{ id: 'b', maker: HOLDER_A, tokenIn: USDC, tokenOut: addr(TRY + 2), amountIn: '110000', minAmountOut: '1000000', expiry: '99999999999', nonce: '1', signature: '0x', side: 'bid', price: 0.11, timestamp: 1 }], asks: [] }), { status: 200 })
    })
    const seller = new ClobYesSeller({ orderBookUrl: 'http://ob', chainId: 84532, clobSettlementAddress: addr(TRY + 4), yesTokenAddress: addr(TRY + 2), usdcAddress: USDC, account, marketSlug: 'try', fetchImpl: fetchImpl as unknown as typeof fetch })
    const res = await seller.sell({ yesAmount: 1_000_000n, markWad: 120_000_000_000_000_000n })
    expect(res.action).toBe('rested')
    expect(res.priceWad).toBe(120_000_000_000_000_000n)
    void urls; void posted
  })
})
