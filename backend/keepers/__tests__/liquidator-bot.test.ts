import { describe, it, expect, vi } from 'vitest'
import {
  ContractFunctionRevertedError,
  encodeErrorResult,
  encodeEventTopics,
  encodeAbiParameters,
} from 'viem'
import type { Address, Hash } from 'viem'
import {
  LiquidatorBot,
  startHealthServer,
  decodeClaimRevert,
  parseLiquidatedEvent,
  parsePrivateKey,
  LIQUIDATION_ENGINE_ABI,
  type IPublicClient,
  type IWalletClient,
  type IHolderSource,
  type BotConfig,
  type LogLike,
} from '../liquidator-bot'
import type { HolderIndexStatus } from '../holder-index'
import type { IYesSeller, SellRequest, SellResult } from '../seller'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CREDIT_MARKET       = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0' as const
const YES_TOKEN           = '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512' as const
const USDC                = '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const
const LIQUIDATION_ENGINE  = '0x16Be3ac2f3d76f95a86BE961b2fE5B8EFB53c6B5' as const
const INSURANCE_FUND      = '0xEDbBF8ffF57198bc44897A519088FE5AcD828aB1' as const
const CLOB_SETTLEMENT     = '0xC31702C1C2c41FcCb57446E0fda5091412bccB8e' as const
const BOT_ACCOUNT         = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
const HOLDER_A            = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const
const HOLDER_B            = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as const
const TX_HASH             = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' as const

// currentMark = 0.05 in 1e18
const DEFAULT_MARK = 50_000_000_000_000_000n
// Q = 1_000_000 (1 USDC of notional — YES tokens share USDC decimal precision)
const DEFAULT_Q    = 1_000_000n
// costBound = Q * mark / 1e18 = 50_000
const COST_BOUND   = (DEFAULT_Q * DEFAULT_MARK) / 1_000_000_000_000_000_000n

const CONFIG: BotConfig = {
  creditMarketAddress:      CREDIT_MARKET,
  yesTokenAddress:          YES_TOKEN,
  usdcAddress:              USDC,
  liquidationEngineAddress: LIQUIDATION_ENGINE,
  insuranceFundAddress:     INSURANCE_FUND,
  clobSettlementAddress:    CLOB_SETTLEMENT,
  pollIntervalMs:           999_999_999, // prevent auto-firing in tests
  autoSell:                 false,       // most tests isolate the claim loop; sell tests override
}

function emptyStatus(overrides: Partial<HolderIndexStatus> = {}): HolderIndexStatus {
  return {
    holders:          0,
    syncedToBlock:    null,
    backfillComplete: false,
    lastSyncAt:       null,
    lastError:        null,
    ...overrides,
  }
}

// ─── Fakes ────────────────────────────────────────────────────────────────────

function makeHolderSource(opts: {
  initialHolders?: Address[]
  refreshImpl?: () => Promise<void>
} = {}): IHolderSource & { refreshCalls: number } {
  const holders = opts.initialHolders ?? []
  let refreshCalls = 0
  return {
    async refresh(): Promise<void> {
      refreshCalls++
      if (opts.refreshImpl) await opts.refreshImpl()
    },
    holders(): Address[] {
      return holders
    },
    status(): HolderIndexStatus {
      return emptyStatus({ holders: holders.length })
    },
    get refreshCalls(): number {
      return refreshCalls
    },
  }
}

// Value may be a plain bigint (returned every call) or an array (shifted once
// per call, last element repeats once exhausted) — lets tests model a balance
// that changes across two reads of the same address (e.g. InsuranceFund
// before/after a tail-case claim).
type BalanceSpec = bigint | bigint[]

function nextValue(spec: BalanceSpec | undefined, fallback: bigint): bigint {
  if (spec === undefined) return fallback
  if (typeof spec === 'bigint') return spec
  if (spec.length === 0) return fallback
  return spec.length === 1 ? spec[0] : spec.shift()!
}

interface ReadContractState {
  motionPending?: boolean
  currentMark?: bigint
  claimableByHolder?: Record<string, boolean>
  yesBalanceByAddr?: Record<string, BalanceSpec>
  usdcBalanceByAddr?: Record<string, BalanceSpec>
  usdcAllowance?: bigint  // bot -> LiquidationEngine
  yesAllowance?: bigint   // bot -> CLOBSettlement
}

function makeReadContract(state: ReadContractState = {}): IPublicClient['readContract'] {
  return (async ({ address, functionName, args }) => {
    const addr = (address as string).toLowerCase()

    if (addr === CREDIT_MARKET.toLowerCase()) {
      if (functionName === 'motionPending') return state.motionPending ?? false
      if (functionName === 'currentMark') return state.currentMark ?? DEFAULT_MARK
      if (functionName === 'claimable') {
        const holder = (args?.[0] as string).toLowerCase()
        return state.claimableByHolder?.[holder] ?? false
      }
    }

    if (addr === YES_TOKEN.toLowerCase()) {
      if (functionName === 'balanceOf') {
        const who = (args?.[0] as string).toLowerCase()
        return nextValue(state.yesBalanceByAddr?.[who], 0n)
      }
      if (functionName === 'allowance') return state.yesAllowance ?? 0n
    }

    if (addr === USDC.toLowerCase()) {
      if (functionName === 'balanceOf') {
        const who = (args?.[0] as string).toLowerCase()
        return nextValue(state.usdcBalanceByAddr?.[who], 0n)
      }
      if (functionName === 'allowance') return state.usdcAllowance ?? 0n
    }

    return 0n
  }) as IPublicClient['readContract']
}

function makePublicClient(overrides: {
  readContract?: IPublicClient['readContract']
  estimateContractGas?: IPublicClient['estimateContractGas']
  waitForTransactionReceipt?: IPublicClient['waitForTransactionReceipt']
} = {}): IPublicClient & {
  readContract: ReturnType<typeof vi.fn>
  estimateContractGas: ReturnType<typeof vi.fn>
  waitForTransactionReceipt: ReturnType<typeof vi.fn>
} {
  return {
    readContract: vi.fn().mockImplementation(overrides.readContract ?? makeReadContract()),
    estimateContractGas: vi.fn().mockImplementation(overrides.estimateContractGas ?? (() => Promise.resolve(100_000n))),
    waitForTransactionReceipt: vi.fn().mockImplementation(
      overrides.waitForTransactionReceipt ?? (() => Promise.resolve({ status: 'success' as const, logs: [] })),
    ),
  }
}

function makeWalletClient(overrides: {
  writeContract?: IWalletClient['writeContract']
} = {}): IWalletClient & { writeContract: ReturnType<typeof vi.fn> } {
  return {
    writeContract: vi.fn().mockImplementation(overrides.writeContract ?? (() => Promise.resolve(TX_HASH as Hash))),
    account: { address: BOT_ACCOUNT },
  }
}

function makeSeller(overrides: {
  sell?: (req: SellRequest) => Promise<SellResult>
} = {}): IYesSeller & { sell: ReturnType<typeof vi.fn> } {
  return {
    sell: vi.fn().mockImplementation(overrides.sell ?? (() => Promise.resolve({ action: 'skipped' as const, reason: 'no-op fake' }))),
  }
}

// A real ContractFunctionRevertedError, decoded from actual ABI-encoded revert
// data — exercises the same decode path (`err.walk` / `.data.errorName`) real
// viem estimateContractGas failures produce, rather than a hand-rolled stub.
// Mirrors matching-engine/src/__tests__/settler.test.ts's makeRevertError.
function makeRevertError(errorName: string, args: readonly unknown[] = []) {
  const data = encodeErrorResult({
    abi:       LIQUIDATION_ENGINE_ABI,
    errorName: errorName as never,
    args:      args as never,
  })
  return new ContractFunctionRevertedError({
    abi:          LIQUIDATION_ENGINE_ABI,
    data,
    functionName: 'claim',
  })
}

function makeLiquidatedLog(args: {
  originalHolder: Address
  liquidator: Address
  yesAmount: bigint
  pricePaid: bigint
  tailCase: boolean
}): LogLike {
  const topics = encodeEventTopics({
    abi:       LIQUIDATION_ENGINE_ABI,
    eventName: 'Liquidated',
    args:      { originalHolder: args.originalHolder, liquidator: args.liquidator },
  })
  const data = encodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'bool' }],
    [args.yesAmount, args.pricePaid, args.tailCase],
  )
  return { address: LIQUIDATION_ENGINE, topics, data }
}

async function flush(times = 40): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

// ─── decodeClaimRevert / parseLiquidatedEvent (pure helpers) ──────────────────

describe('decodeClaimRevert', () => {
  it('decodes NotClaimable', () => {
    expect(decodeClaimRevert(makeRevertError('NotClaimable'))).toEqual({ kind: 'NotClaimable' })
  })
  it('decodes MotionPending', () => {
    expect(decodeClaimRevert(makeRevertError('MotionPending'))).toEqual({ kind: 'MotionPending' })
  })
  it('decodes PositionFrozen', () => {
    expect(decodeClaimRevert(makeRevertError('PositionFrozen'))).toEqual({ kind: 'PositionFrozen' })
  })
  it('decodes ERC20InsufficientBalance with args', () => {
    const decoded = decodeClaimRevert(makeRevertError('ERC20InsufficientBalance', [INSURANCE_FUND, 10n, 500n]))
    expect(decoded).toEqual({ kind: 'ERC20InsufficientBalance', sender: INSURANCE_FUND, balance: 10n, needed: 500n })
  })
  it('falls back to other for an undecodable error', () => {
    expect(decodeClaimRevert(new Error('RPC timeout'))).toEqual({ kind: 'other' })
  })
})

describe('parseLiquidatedEvent', () => {
  it('parses a Liquidated log', () => {
    const log = makeLiquidatedLog({
      originalHolder: HOLDER_A, liquidator: BOT_ACCOUNT, yesAmount: DEFAULT_Q, pricePaid: 40_000n, tailCase: false,
    })
    const parsed = parseLiquidatedEvent([log], LIQUIDATION_ENGINE)
    expect(parsed).toEqual({
      originalHolder: HOLDER_A, liquidator: BOT_ACCOUNT, yesAmount: DEFAULT_Q, pricePaid: 40_000n, tailCase: false,
    })
  })
  it('returns undefined when no matching log is present', () => {
    expect(parseLiquidatedEvent([], LIQUIDATION_ENGINE)).toBeUndefined()
  })
  it('ignores logs from other addresses', () => {
    const log = makeLiquidatedLog({
      originalHolder: HOLDER_A, liquidator: BOT_ACCOUNT, yesAmount: DEFAULT_Q, pricePaid: 40_000n, tailCase: false,
    })
    expect(parseLiquidatedEvent([{ ...log, address: USDC }], LIQUIDATION_ENGINE)).toBeUndefined()
  })
})

// ─── LiquidatorBot.runCycle() — claiming ───────────────────────────────────────

describe('LiquidatorBot — claims a flagged holder', () => {
  it('simulates, sends, waits for receipt, parses Liquidated, updates counters', async () => {
    const client = makePublicClient({
      readContract: makeReadContract({
        claimableByHolder: { [HOLDER_A.toLowerCase()]: true },
        yesBalanceByAddr:  { [HOLDER_A.toLowerCase()]: DEFAULT_Q },
        usdcBalanceByAddr: { [BOT_ACCOUNT.toLowerCase()]: 1_000_000n },
        usdcAllowance:     2n ** 256n - 1n, // pre-approved — no approve tx expected
      }),
      waitForTransactionReceipt: () => Promise.resolve({
        status: 'success' as const,
        logs: [makeLiquidatedLog({
          originalHolder: HOLDER_A, liquidator: BOT_ACCOUNT, yesAmount: DEFAULT_Q, pricePaid: 40_000n, tailCase: false,
        })],
      }),
    })
    const wallet = makeWalletClient()
    const seller = makeSeller()
    const bot = new LiquidatorBot(client, wallet, makeHolderSource({ initialHolders: [HOLDER_A] }), seller, CONFIG)

    await bot.runCycle()

    expect(wallet.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'claim', args: [HOLDER_A] }),
    )
    const health = bot.getHealth()
    expect(health.claims).toBe(1)
    expect(health.tailClaims).toBe(0)
    expect(health.lastCycleAt).not.toBeNull()
    expect(health.lastError).toBeNull()
  })
})

describe('LiquidatorBot — motionPending', () => {
  it('skips all claims this cycle and logs, without reading claimable() for any holder', async () => {
    const readContract = vi.fn().mockImplementation(makeReadContract({ motionPending: true }))
    const client = makePublicClient({ readContract })
    const wallet = makeWalletClient()
    const bot = new LiquidatorBot(
      client, wallet, makeHolderSource({ initialHolders: [HOLDER_A, HOLDER_B] }), makeSeller(), CONFIG,
    )

    await bot.runCycle()

    const claimableCalls = readContract.mock.calls.filter(([a]: [{ functionName: string }]) => a.functionName === 'claimable')
    expect(claimableCalls).toHaveLength(0)
    expect(wallet.writeContract).not.toHaveBeenCalled()
    expect(bot.getHealth().skippedByReason.motionPending).toBe(1)
    expect(bot.getHealth().claims).toBe(0)
  })
})

describe('LiquidatorBot — NotClaimable at simulate (race lost)', () => {
  it('is info-level: not treated as an error, no tx sent', async () => {
    const client = makePublicClient({
      readContract: makeReadContract({
        claimableByHolder: { [HOLDER_A.toLowerCase()]: true },
        yesBalanceByAddr:  { [HOLDER_A.toLowerCase()]: DEFAULT_Q },
        usdcBalanceByAddr: { [BOT_ACCOUNT.toLowerCase()]: 1_000_000n },
        usdcAllowance:     2n ** 256n - 1n,
      }),
      estimateContractGas: () => Promise.reject(makeRevertError('NotClaimable')),
    })
    const wallet = makeWalletClient()
    const bot = new LiquidatorBot(client, wallet, makeHolderSource({ initialHolders: [HOLDER_A] }), makeSeller(), CONFIG)

    await bot.runCycle()

    expect(wallet.writeContract).not.toHaveBeenCalled()
    const health = bot.getHealth()
    expect(health.skippedByReason.notClaimable).toBe(1)
    expect(health.lastError).toBeNull()
    expect(health.claims).toBe(0)
  })
})

describe('LiquidatorBot — insufficient USDC float', () => {
  it('alerts and skips without ever estimating gas or sending a tx', async () => {
    const client = makePublicClient({
      readContract: makeReadContract({
        claimableByHolder: { [HOLDER_A.toLowerCase()]: true },
        yesBalanceByAddr:  { [HOLDER_A.toLowerCase()]: DEFAULT_Q },
        usdcBalanceByAddr: { [BOT_ACCOUNT.toLowerCase()]: 1_000n }, // << COST_BOUND (50_000)
      }),
    })
    const wallet = makeWalletClient()
    const bot = new LiquidatorBot(client, wallet, makeHolderSource({ initialHolders: [HOLDER_A] }), makeSeller(), CONFIG)

    await bot.runCycle()

    expect(client.estimateContractGas).not.toHaveBeenCalled()
    expect(wallet.writeContract).not.toHaveBeenCalled()
    const health = bot.getHealth()
    expect(health.skippedByReason.insufficientFloat).toBe(1)
    expect(health.claims).toBe(0)
  })
})

describe('LiquidatorBot — InsuranceFund cannot cover the tail shortfall', () => {
  it('alerts and skips (ERC20InsufficientBalance decoded at simulate)', async () => {
    const client = makePublicClient({
      readContract: makeReadContract({
        claimableByHolder: { [HOLDER_A.toLowerCase()]: true },
        yesBalanceByAddr:  { [HOLDER_A.toLowerCase()]: DEFAULT_Q },
        usdcBalanceByAddr: { [BOT_ACCOUNT.toLowerCase()]: 1_000_000n },
        usdcAllowance:     2n ** 256n - 1n,
      }),
      estimateContractGas: () => Promise.reject(
        makeRevertError('ERC20InsufficientBalance', [INSURANCE_FUND, 10n, 500n]),
      ),
    })
    const wallet = makeWalletClient()
    const bot = new LiquidatorBot(client, wallet, makeHolderSource({ initialHolders: [HOLDER_A] }), makeSeller(), CONFIG)

    await bot.runCycle()

    expect(wallet.writeContract).not.toHaveBeenCalled()
    const health = bot.getHealth()
    expect(health.skippedByReason.insuranceFundShortfall).toBe(1)
    expect(health.lastError).toContain('InsuranceFund')
  })
})

describe('LiquidatorBot — bot itself is flagged (PositionFrozen)', () => {
  it('alerts and skips', async () => {
    const client = makePublicClient({
      readContract: makeReadContract({
        claimableByHolder: { [HOLDER_A.toLowerCase()]: true },
        yesBalanceByAddr:  { [HOLDER_A.toLowerCase()]: DEFAULT_Q },
        usdcBalanceByAddr: { [BOT_ACCOUNT.toLowerCase()]: 1_000_000n },
        usdcAllowance:     2n ** 256n - 1n,
      }),
      estimateContractGas: () => Promise.reject(makeRevertError('PositionFrozen')),
    })
    const wallet = makeWalletClient()
    const bot = new LiquidatorBot(client, wallet, makeHolderSource({ initialHolders: [HOLDER_A] }), makeSeller(), CONFIG)

    await bot.runCycle()

    expect(wallet.writeContract).not.toHaveBeenCalled()
    const health = bot.getHealth()
    expect(health.skippedByReason.botFrozen).toBe(1)
    expect(health.lastError).toContain('frozen')
  })
})

describe('LiquidatorBot — tail case', () => {
  it('bumps tailClaims and logs the InsuranceFund top-up computed from the balance delta', async () => {
    const client = makePublicClient({
      readContract: makeReadContract({
        claimableByHolder: { [HOLDER_A.toLowerCase()]: true },
        yesBalanceByAddr:  { [HOLDER_A.toLowerCase()]: DEFAULT_Q },
        usdcBalanceByAddr: {
          [BOT_ACCOUNT.toLowerCase()]:     1_000_000n,
          // pre-claim read, then post-claim read — InsuranceFund covered 300.
          [INSURANCE_FUND.toLowerCase()]:  [1_000n, 700n],
        },
        usdcAllowance: 2n ** 256n - 1n,
      }),
      waitForTransactionReceipt: () => Promise.resolve({
        status: 'success' as const,
        logs: [makeLiquidatedLog({
          originalHolder: HOLDER_A, liquidator: BOT_ACCOUNT, yesAmount: DEFAULT_Q, pricePaid: DEFAULT_MARK * DEFAULT_Q / 1_000_000_000_000_000_000n, tailCase: true,
        })],
      }),
    })
    const wallet = makeWalletClient()
    const bot = new LiquidatorBot(client, wallet, makeHolderSource({ initialHolders: [HOLDER_A] }), makeSeller(), CONFIG)

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await bot.runCycle()

    const health = bot.getHealth()
    expect(health.claims).toBe(1)
    expect(health.tailClaims).toBe(1)
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('ALERT tail case'),
    )
    expect(errorSpy.mock.calls.some(([msg]) => typeof msg === 'string' && msg.includes('covered 300'))).toBe(true)

    errorSpy.mockRestore()
  })
})

// ─── approvals ──────────────────────────────────────────────────────────────

describe('LiquidatorBot — approvals only sent when needed', () => {
  it('sends a USDC approve before claim() when allowance is below the cost bound', async () => {
    const client = makePublicClient({
      readContract: makeReadContract({
        claimableByHolder: { [HOLDER_A.toLowerCase()]: true },
        yesBalanceByAddr:  { [HOLDER_A.toLowerCase()]: DEFAULT_Q },
        usdcBalanceByAddr: { [BOT_ACCOUNT.toLowerCase()]: 1_000_000n },
        usdcAllowance:     0n, // below COST_BOUND
      }),
    })
    const wallet = makeWalletClient()
    const bot = new LiquidatorBot(client, wallet, makeHolderSource({ initialHolders: [HOLDER_A] }), makeSeller(), CONFIG)

    await bot.runCycle()

    const calls = wallet.writeContract.mock.calls.map((c: [{ functionName: string }]) => c[0].functionName)
    expect(calls).toEqual(['approve', 'claim'])
  })

  it('does not send an approve when allowance already covers the cost bound', async () => {
    const client = makePublicClient({
      readContract: makeReadContract({
        claimableByHolder: { [HOLDER_A.toLowerCase()]: true },
        yesBalanceByAddr:  { [HOLDER_A.toLowerCase()]: DEFAULT_Q },
        usdcBalanceByAddr: { [BOT_ACCOUNT.toLowerCase()]: 1_000_000n },
        usdcAllowance:     2n ** 256n - 1n,
      }),
    })
    const wallet = makeWalletClient()
    const bot = new LiquidatorBot(client, wallet, makeHolderSource({ initialHolders: [HOLDER_A] }), makeSeller(), CONFIG)

    await bot.runCycle()

    const calls = wallet.writeContract.mock.calls.map((c: [{ functionName: string }]) => c[0].functionName)
    expect(calls).toEqual(['claim'])
  })
})

// ─── selling ──────────────────────────────────────────────────────────────────

describe('LiquidatorBot — sells any YES it holds after the claim loop', () => {
  it('calls seller.sell with the bot YES balance and currentMark when AUTO_SELL is on', async () => {
    const client = makePublicClient({
      readContract: makeReadContract({
        yesBalanceByAddr: { [BOT_ACCOUNT.toLowerCase()]: 500n },
        yesAllowance:      2n ** 256n - 1n,
        currentMark:       DEFAULT_MARK,
      }),
    })
    const wallet = makeWalletClient()
    const seller = makeSeller()
    const bot = new LiquidatorBot(
      client, wallet, makeHolderSource(), seller, { ...CONFIG, autoSell: true },
    )

    await bot.runCycle()

    expect(seller.sell).toHaveBeenCalledWith({ yesAmount: 500n, markWad: DEFAULT_MARK })
  })

  it('approves YES -> CLOBSettlement only when the current allowance is insufficient', async () => {
    const client = makePublicClient({
      readContract: makeReadContract({
        yesBalanceByAddr: { [BOT_ACCOUNT.toLowerCase()]: 500n },
        yesAllowance:      0n,
        currentMark:       DEFAULT_MARK,
      }),
    })
    const wallet = makeWalletClient()
    const bot = new LiquidatorBot(
      client, wallet, makeHolderSource(), makeSeller(), { ...CONFIG, autoSell: true },
    )

    await bot.runCycle()

    expect(wallet.writeContract).toHaveBeenCalledWith(
      expect.objectContaining({ functionName: 'approve', args: [CLOB_SETTLEMENT, 2n ** 256n - 1n] }),
    )
  })

  it('does not call seller.sell when AUTO_SELL is off', async () => {
    const client = makePublicClient({
      readContract: makeReadContract({ yesBalanceByAddr: { [BOT_ACCOUNT.toLowerCase()]: 500n } }),
    })
    const seller = makeSeller()
    const bot = new LiquidatorBot(
      client, makeWalletClient(), makeHolderSource(), seller, { ...CONFIG, autoSell: false },
    )

    await bot.runCycle()

    expect(seller.sell).not.toHaveBeenCalled()
  })

  it('does not call seller.sell when the bot holds zero YES', async () => {
    const client = makePublicClient({
      readContract: makeReadContract({ yesBalanceByAddr: { [BOT_ACCOUNT.toLowerCase()]: 0n } }),
    })
    const seller = makeSeller()
    const bot = new LiquidatorBot(
      client, makeWalletClient(), makeHolderSource(), seller, { ...CONFIG, autoSell: true },
    )

    await bot.runCycle()

    expect(seller.sell).not.toHaveBeenCalled()
  })
})

// ─── single-flight ──────────────────────────────────────────────────────────────

describe('LiquidatorBot — single-flight cycles', () => {
  it('overlapping cycle() calls join the same run instead of double-claiming', async () => {
    let resolveRefresh!: () => void
    const refreshGate = new Promise<void>(resolve => { resolveRefresh = resolve })

    const holderSource = makeHolderSource({
      initialHolders: [HOLDER_A],
      refreshImpl: () => refreshGate,
    })
    const client = makePublicClient({
      readContract: makeReadContract({
        claimableByHolder: { [HOLDER_A.toLowerCase()]: true },
        yesBalanceByAddr:  { [HOLDER_A.toLowerCase()]: DEFAULT_Q },
        usdcBalanceByAddr: { [BOT_ACCOUNT.toLowerCase()]: 1_000_000n },
        usdcAllowance:     2n ** 256n - 1n,
      }),
    })
    const wallet = makeWalletClient()
    const bot = new LiquidatorBot(client, wallet, holderSource, makeSeller(), CONFIG)

    const p1 = bot.cycle()
    const p2 = bot.cycle() // joins p1 — must NOT start a second refresh/claim pass

    resolveRefresh()
    await Promise.all([p1, p2])

    expect(holderSource.refreshCalls).toBe(1)
    const claimCalls = wallet.writeContract.mock.calls.filter(
      (c: [{ functionName: string }]) => c[0].functionName === 'claim',
    )
    expect(claimCalls).toHaveLength(1)
  })
})

// ─── stop() ───────────────────────────────────────────────────────────────────

describe('LiquidatorBot — stop()', () => {
  it('waits for an in-flight claim (stuck awaiting the receipt) before resolving', async () => {
    let resolveReceipt!: (r: { status: 'success' | 'reverted'; logs: readonly LogLike[] }) => void
    const receiptPromise = new Promise<{ status: 'success' | 'reverted'; logs: readonly LogLike[] }>(resolve => {
      resolveReceipt = resolve
    })
    const client = makePublicClient({
      readContract: makeReadContract({
        claimableByHolder: { [HOLDER_A.toLowerCase()]: true },
        yesBalanceByAddr:  { [HOLDER_A.toLowerCase()]: DEFAULT_Q },
        usdcBalanceByAddr: { [BOT_ACCOUNT.toLowerCase()]: 1_000_000n },
        usdcAllowance:     2n ** 256n - 1n,
      }),
      waitForTransactionReceipt: () => receiptPromise,
    })
    const wallet = makeWalletClient()
    const bot = new LiquidatorBot(client, wallet, makeHolderSource({ initialHolders: [HOLDER_A] }), makeSeller(), CONFIG)

    bot.start() // fires an immediate cycle, which will block on receiptPromise

    let stopResolved = false
    const stopPromise = bot.stop().then(() => { stopResolved = true })

    await flush()
    expect(stopResolved).toBe(false)

    resolveReceipt({
      status: 'success',
      logs: [makeLiquidatedLog({
        originalHolder: HOLDER_A, liquidator: BOT_ACCOUNT, yesAmount: DEFAULT_Q, pricePaid: 40_000n, tailCase: false,
      })],
    })
    await stopPromise

    expect(stopResolved).toBe(true)
    expect(bot.getHealth().claims).toBe(1)
  })

  it('resolves immediately when there is no in-flight cycle', async () => {
    const client = makePublicClient({ readContract: makeReadContract({ motionPending: false }) })
    const bot = new LiquidatorBot(client, makeWalletClient(), makeHolderSource(), makeSeller(), CONFIG)
    await bot.runCycle() // completes fully before stop() is called
    await expect(bot.stop()).resolves.toBeUndefined()
  })
})

// ─── /health ────────────────────────────────────────────────────────────────────

describe('LiquidatorBot — /health', () => {
  it('has the documented shape before any cycle has run', () => {
    const bot = new LiquidatorBot(makePublicClient(), makeWalletClient(), makeHolderSource(), makeSeller(), CONFIG)
    expect(bot.getHealth()).toEqual({
      status:          'ok',
      lastCycleAt:     null,
      claims:          0,
      tailClaims:      0,
      skippedByReason: {},
      lastError:       null,
      usdcBalance:     null,
      yesBalance:      null,
      holderIndex:     emptyStatus(),
    })
  })

  it('serves the health snapshot over HTTP', async () => {
    const bot = new LiquidatorBot(makePublicClient(), makeWalletClient(), makeHolderSource(), makeSeller(), CONFIG)
    const server = startHealthServer(bot, 0)
    const port = (server.address() as { port: number }).port
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      expect(res.status).toBe(200)
      const body = await res.json() as { status: string; claims: number }
      expect(body.status).toBe('ok')
      expect(body.claims).toBe(0)
    } finally {
      server.close()
    }
  })

  it('404s on unknown paths', async () => {
    const bot = new LiquidatorBot(makePublicClient(), makeWalletClient(), makeHolderSource(), makeSeller(), CONFIG)
    const server = startHealthServer(bot, 0)
    const port = (server.address() as { port: number }).port
    try {
      const res = await fetch(`http://127.0.0.1:${port}/nope`)
      expect(res.status).toBe(404)
    } finally {
      server.close()
    }
  })
})

describe('parsePrivateKey', () => {
  const HEX = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
  it('accepts a key with or without 0x, trimming whitespace and quotes', () => {
    expect(parsePrivateKey(HEX, 'K')).toBe(`0x${HEX}`)
    expect(parsePrivateKey(`0x${HEX}`, 'K')).toBe(`0x${HEX}`)
    expect(parsePrivateKey(`  "0x${HEX}"\n`, 'K')).toBe(`0x${HEX}`)
  })
  it('rejects malformed keys without echoing them', () => {
    expect(() => parsePrivateKey('0x1234', 'LIQUIDATOR_PRIVATE_KEY')).toThrow(/LIQUIDATOR_PRIVATE_KEY must be a 32-byte hex/)
    try { parsePrivateKey('not-a-key-zzzz', 'K') } catch (e) { expect(String(e)).not.toContain('zzzz') }
  })
})
