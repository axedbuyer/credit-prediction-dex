import { describe, it, expect, vi } from 'vitest'
import {
  LiquidationKeeper,
  startServer,
  computePosition,
  type IPublicClient,
  type KeeperConfig,
} from '../liquidation-keeper'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CREDIT_MARKET = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0' as const
const YES_TOKEN     = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' as const
const HOLDER_A      = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const
const HOLDER_B      = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as const

// currentMark = 0.05 in 1e18
const DEFAULT_MARK = 50_000_000_000_000_000n
// Q = 1_000_000 (1 USDC of notional — YES tokens share USDC decimal precision)
const DEFAULT_Q    = 1_000_000n

const BASE_CONFIG: KeeperConfig = {
  creditMarketAddress: CREDIT_MARKET,
  yesTokenAddress:     YES_TOKEN,
  trackedHolders:      [HOLDER_A],
  pollIntervalMs:      999_999_999,  // prevent auto-firing in tests
}

// Build a readContract mock that dispatches on functionName.
// `overrides` let individual tests override specific return values.
function makeReadContract(overrides: {
  claimable?: boolean
  frozenFundingPerUnit?: bigint  // per-unit, 1e18-scaled (maps to frozenFunding)
  fundingDebt?: bigint           // total accumulated debt (maps to fundingDebt)
  yesBalance?: bigint            // maps to balanceOf on YES token
  currentMark?: bigint
  motionPending?: boolean
} = {}): IPublicClient['readContract'] {
  return ({ functionName }) => {
    switch (functionName) {
      case 'currentMark':  return Promise.resolve(overrides.currentMark  ?? DEFAULT_MARK)
      case 'motionPending':return Promise.resolve(overrides.motionPending ?? false)
      case 'claimable':    return Promise.resolve(overrides.claimable     ?? false)
      case 'frozenFunding':return Promise.resolve(overrides.frozenFundingPerUnit ?? 0n)
      case 'fundingDebt':  return Promise.resolve(overrides.fundingDebt   ?? 0n)
      case 'balanceOf':    return Promise.resolve(overrides.yesBalance    ?? DEFAULT_Q)
      default:             return Promise.resolve(0n)
    }
  }
}

function makePublicClient(
  readFn: IPublicClient['readContract'],
): IPublicClient {
  return { readContract: vi.fn().mockImplementation(readFn) }
}

// ─── computePosition — pure formula ───────────────────────────────────────────

describe('computePosition — normal case (fFrozenTotal ≤ tokenValue)', () => {
  it('sets claimPrice = fFrozenTotal and tailCase = false', () => {
    // frozenFundingPerUnit = 0.04 (1e18), Q = 1_000_000, prevDebt = 0
    // fFrozenTotal = 0 + 40_000_000_000_000_000 * 1_000_000 / 1e18 = 40_000
    // tokenValue   = 1_000_000 * 50_000_000_000_000_000 / 1e18 = 50_000
    const pos = computePosition(
      HOLDER_A,
      DEFAULT_Q,                       // Q
      DEFAULT_MARK,                    // currentMark = 0.05e18
      40_000_000_000_000_000n,         // frozenFundingPerUnit = 0.04e18
      0n,                              // prevDebt
      false,
    )
    expect(pos.claimPrice).toBe('40000')
    expect(pos.frozenFunding).toBe('40000')
    expect(pos.tokenValue).toBe('50000')
    expect(pos.tailCase).toBe(false)
    expect(pos.frozen).toBe(false)
    expect(pos.frozenReason).toBeUndefined()
  })

  it('includes prevDebt in fFrozenTotal', () => {
    // frozenFundingPerUnit = 0.03e18, Q = 1_000_000, prevDebt = 15_000
    // perUnitPart = 30_000_000_000_000_000 * 1_000_000 / 1e18 = 30_000
    // fFrozenTotal = 15_000 + 30_000 = 45_000 < 50_000
    const pos = computePosition(
      HOLDER_A,
      DEFAULT_Q,
      DEFAULT_MARK,
      30_000_000_000_000_000n,
      15_000n,
      false,
    )
    expect(pos.frozenFunding).toBe('45000')
    expect(pos.claimPrice).toBe('45000')
    expect(pos.tailCase).toBe(false)
  })
})

describe('computePosition — tail case (fFrozenTotal > tokenValue)', () => {
  it('sets claimPrice = tokenValue and tailCase = true', () => {
    // frozenFundingPerUnit = 0.06e18 > mark 0.05e18 (keeper downtime / mark gap)
    // fFrozenTotal = 60_000_000_000_000_000 * 1_000_000 / 1e18 = 60_000
    // tokenValue   = 50_000
    const pos = computePosition(
      HOLDER_A,
      DEFAULT_Q,
      DEFAULT_MARK,
      60_000_000_000_000_000n,
      0n,
      false,
    )
    expect(pos.claimPrice).toBe('50000')
    expect(pos.frozenFunding).toBe('60000')
    expect(pos.tokenValue).toBe('50000')
    expect(pos.tailCase).toBe(true)
  })

  it('tail case triggered by prevDebt pushing fFrozenTotal above tokenValue', () => {
    // frozenFundingPerUnit = 0.04e18, but prevDebt = 20_000 pushes total to 60_000
    // fFrozenTotal = 20_000 + 40_000 = 60_000 > 50_000
    const pos = computePosition(
      HOLDER_A,
      DEFAULT_Q,
      DEFAULT_MARK,
      40_000_000_000_000_000n,
      20_000n,
      false,
    )
    expect(pos.tailCase).toBe(true)
    expect(pos.claimPrice).toBe('50000')   // capped at tokenValue
    expect(pos.frozenFunding).toBe('60000')
  })
})

describe('computePosition — motionPending freeze', () => {
  it('sets frozen=true and frozenReason when motionPending', () => {
    const pos = computePosition(
      HOLDER_A,
      DEFAULT_Q,
      DEFAULT_MARK,
      40_000_000_000_000_000n,
      0n,
      true,
    )
    expect(pos.frozen).toBe(true)
    expect(pos.frozenReason).toBe('credit event under review')
    // Math still computed — position is informational
    expect(pos.claimPrice).toBe('40000')
    expect(pos.tailCase).toBe(false)
  })

  it('frozen=false and no frozenReason when motionPending=false', () => {
    const pos = computePosition(HOLDER_A, DEFAULT_Q, DEFAULT_MARK, 0n, 0n, false)
    expect(pos.frozen).toBe(false)
    expect(pos.frozenReason).toBeUndefined()
  })
})

// ─── LiquidationKeeper.poll() ─────────────────────────────────────────────────

describe('LiquidationKeeper — poll normal case', () => {
  it('includes claimable position with correct claimPrice', async () => {
    const client = makePublicClient(makeReadContract({
      claimable:            true,
      frozenFundingPerUnit: 40_000_000_000_000_000n,
      fundingDebt:          0n,
      yesBalance:           DEFAULT_Q,
    }))
    const keeper = new LiquidationKeeper(client, BASE_CONFIG)

    await keeper.poll()

    const positions = keeper.getPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0].user).toBe(HOLDER_A)
    expect(positions[0].claimPrice).toBe('40000')
    expect(positions[0].tailCase).toBe(false)
    expect(positions[0].frozen).toBe(false)
  })

  it('updates lastPolledAt after a successful poll', async () => {
    const client = makePublicClient(makeReadContract({ claimable: false }))
    const keeper = new LiquidationKeeper(client, BASE_CONFIG)

    expect(keeper.getLastPolledAt()).toBeNull()
    await keeper.poll()
    expect(keeper.getLastPolledAt()).toBeInstanceOf(Date)
  })

  it('skips holders where claimable=false', async () => {
    const client = makePublicClient(makeReadContract({ claimable: false }))
    const keeper = new LiquidationKeeper(client, BASE_CONFIG)

    await keeper.poll()

    expect(keeper.getPositions()).toHaveLength(0)
  })
})

describe('LiquidationKeeper — poll tail case', () => {
  it('sets tailCase=true when fFrozenTotal > tokenValue', async () => {
    const client = makePublicClient(makeReadContract({
      claimable:            true,
      frozenFundingPerUnit: 60_000_000_000_000_000n,  // above mark
      fundingDebt:          0n,
      yesBalance:           DEFAULT_Q,
    }))
    const keeper = new LiquidationKeeper(client, BASE_CONFIG)

    await keeper.poll()

    const pos = keeper.getPositions()[0]
    expect(pos.tailCase).toBe(true)
    expect(pos.claimPrice).toBe(pos.tokenValue)  // P = tokenValue in tail case
    expect(pos.claimPrice).toBe('50000')
  })
})

describe('LiquidationKeeper — motionPending', () => {
  it('lists claimable positions with frozen=true when motionPending', async () => {
    const client = makePublicClient(makeReadContract({
      claimable:            true,
      frozenFundingPerUnit: 40_000_000_000_000_000n,
      fundingDebt:          0n,
      yesBalance:           DEFAULT_Q,
      motionPending:        true,
    }))
    const keeper = new LiquidationKeeper(client, BASE_CONFIG)

    await keeper.poll()

    const positions = keeper.getPositions()
    // Positions are STILL listed — not hidden — but frozen
    expect(positions).toHaveLength(1)
    expect(positions[0].frozen).toBe(true)
    expect(positions[0].frozenReason).toBe('credit event under review')
    // Math is still correct for display
    expect(positions[0].claimPrice).toBe('40000')
  })

  it('marks frozen=false when motionPending resolves', async () => {
    const client = makePublicClient(makeReadContract({
      claimable:     true,
      yesBalance:    DEFAULT_Q,
      motionPending: false,
    }))
    const keeper = new LiquidationKeeper(client, BASE_CONFIG)

    await keeper.poll()

    expect(keeper.getPositions()[0].frozen).toBe(false)
  })
})

describe('LiquidationKeeper — multiple holders', () => {
  it('only lists claimable holders among tracked set', async () => {
    const config: KeeperConfig = { ...BASE_CONFIG, trackedHolders: [HOLDER_A, HOLDER_B] }
    const readFn: IPublicClient['readContract'] = ({ functionName, args }) => {
      if (functionName === 'currentMark')   return Promise.resolve(DEFAULT_MARK)
      if (functionName === 'motionPending') return Promise.resolve(false)
      // Only HOLDER_A is claimable
      if (functionName === 'claimable') {
        return Promise.resolve(args?.[0] === HOLDER_A)
      }
      if (functionName === 'frozenFunding') return Promise.resolve(40_000_000_000_000_000n)
      if (functionName === 'fundingDebt')   return Promise.resolve(0n)
      if (functionName === 'balanceOf')     return Promise.resolve(DEFAULT_Q)
      return Promise.resolve(0n)
    }
    const client = makePublicClient(readFn)

    const keeper = new LiquidationKeeper(client, config)
    await keeper.poll()

    const positions = keeper.getPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0].user).toBe(HOLDER_A)
  })
})

describe('LiquidationKeeper — error resilience', () => {
  it('swallows a market-state read failure without crashing', async () => {
    const client: IPublicClient = {
      readContract: vi.fn().mockRejectedValue(new Error('RPC error')),
    }
    const keeper = new LiquidationKeeper(client, BASE_CONFIG)

    await expect(keeper.poll()).resolves.not.toThrow()
    // lastPolledAt not set because poll bailed early
    expect(keeper.getLastPolledAt()).toBeNull()
  })

  it('skips a single failing holder and still processes the rest', async () => {
    const config: KeeperConfig = { ...BASE_CONFIG, trackedHolders: [HOLDER_A, HOLDER_B] }
    let callCount = 0
    const readFn: IPublicClient['readContract'] = ({ functionName, args }) => {
      if (functionName === 'currentMark')   return Promise.resolve(DEFAULT_MARK)
      if (functionName === 'motionPending') return Promise.resolve(false)
      if (functionName === 'claimable') {
        callCount++
        // HOLDER_A throws; HOLDER_B is claimable
        if (args?.[0] === HOLDER_A) return Promise.reject(new Error('node error'))
        return Promise.resolve(true)
      }
      if (functionName === 'frozenFunding') return Promise.resolve(40_000_000_000_000_000n)
      if (functionName === 'fundingDebt')   return Promise.resolve(0n)
      if (functionName === 'balanceOf')     return Promise.resolve(DEFAULT_Q)
      return Promise.resolve(0n)
    }
    const client: IPublicClient = {
      readContract: vi.fn().mockImplementation(readFn),
    }

    const keeper = new LiquidationKeeper(client, config)
    await keeper.poll()

    const positions = keeper.getPositions()
    expect(positions).toHaveLength(1)
    expect(positions[0].user).toBe(HOLDER_B)
  })
})

// ─── GET /claimable ───────────────────────────────────────────────────────────

describe('GET /claimable', () => {
  it('returns an empty array when no positions are claimable', async () => {
    const client = makePublicClient(makeReadContract({ claimable: false }))
    const keeper = new LiquidationKeeper(client, BASE_CONFIG)
    await keeper.poll()

    const server = startServer(keeper, 0)
    const port = (server.address() as { port: number }).port
    try {
      const res = await fetch(`http://127.0.0.1:${port}/claimable`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual([])
    } finally {
      await new Promise<void>(r => server.close(() => r()))
    }
  })

  it('returns the correct position for a normal-case claimable holder', async () => {
    const client = makePublicClient(makeReadContract({
      claimable:            true,
      frozenFundingPerUnit: 40_000_000_000_000_000n,
      fundingDebt:          0n,
      yesBalance:           DEFAULT_Q,
    }))
    const keeper = new LiquidationKeeper(client, BASE_CONFIG)
    await keeper.poll()

    const server = startServer(keeper, 0)
    const port = (server.address() as { port: number }).port
    try {
      const res  = await fetch(`http://127.0.0.1:${port}/claimable`)
      const body = await res.json() as Array<Record<string, unknown>>
      expect(body).toHaveLength(1)
      expect(body[0].user).toBe(HOLDER_A)
      expect(body[0].claimPrice).toBe('40000')
      expect(body[0].tailCase).toBe(false)
      expect(body[0].frozen).toBe(false)
    } finally {
      await new Promise<void>(r => server.close(() => r()))
    }
  })

  it('reflects motionPending freeze state in /claimable response', async () => {
    const client = makePublicClient(makeReadContract({
      claimable:            true,
      frozenFundingPerUnit: 40_000_000_000_000_000n,
      fundingDebt:          0n,
      yesBalance:           DEFAULT_Q,
      motionPending:        true,
    }))
    const keeper = new LiquidationKeeper(client, BASE_CONFIG)
    await keeper.poll()

    const server = startServer(keeper, 0)
    const port = (server.address() as { port: number }).port
    try {
      const res  = await fetch(`http://127.0.0.1:${port}/claimable`)
      const body = await res.json() as Array<Record<string, unknown>>
      expect(body).toHaveLength(1)           // still listed — not hidden
      expect(body[0].frozen).toBe(true)
      expect(body[0].frozenReason).toBe('credit event under review')
    } finally {
      await new Promise<void>(r => server.close(() => r()))
    }
  })

  it('returns a tail-case position with tailCase=true', async () => {
    const client = makePublicClient(makeReadContract({
      claimable:            true,
      frozenFundingPerUnit: 60_000_000_000_000_000n,
      fundingDebt:          0n,
      yesBalance:           DEFAULT_Q,
    }))
    const keeper = new LiquidationKeeper(client, BASE_CONFIG)
    await keeper.poll()

    const server = startServer(keeper, 0)
    const port = (server.address() as { port: number }).port
    try {
      const res  = await fetch(`http://127.0.0.1:${port}/claimable`)
      const body = await res.json() as Array<Record<string, unknown>>
      expect(body[0].tailCase).toBe(true)
      expect(body[0].claimPrice).toBe('50000')  // capped at tokenValue
    } finally {
      await new Promise<void>(r => server.close(() => r()))
    }
  })
})

// ─── GET /health ──────────────────────────────────────────────────────────────

describe('GET /health', () => {
  it('returns lastPolledAt=null before first poll', async () => {
    const client = makePublicClient(makeReadContract())
    const keeper = new LiquidationKeeper(client, BASE_CONFIG)

    const server = startServer(keeper, 0)
    const port = (server.address() as { port: number }).port
    try {
      const res  = await fetch(`http://127.0.0.1:${port}/health`)
      const body = await res.json() as { status: string; lastPolledAt: string | null }
      expect(res.status).toBe(200)
      expect(body.status).toBe('ok')
      expect(body.lastPolledAt).toBeNull()
    } finally {
      await new Promise<void>(r => server.close(() => r()))
    }
  })

  it('returns an ISO timestamp after a successful poll', async () => {
    const client = makePublicClient(makeReadContract({ claimable: false }))
    const keeper = new LiquidationKeeper(client, BASE_CONFIG)
    await keeper.poll()

    const server = startServer(keeper, 0)
    const port = (server.address() as { port: number }).port
    try {
      const res  = await fetch(`http://127.0.0.1:${port}/health`)
      const body = await res.json() as { lastPolledAt: string }
      expect(body.lastPolledAt).toBeTruthy()
      expect(() => new Date(body.lastPolledAt)).not.toThrow()
    } finally {
      await new Promise<void>(r => server.close(() => r()))
    }
  })
})
