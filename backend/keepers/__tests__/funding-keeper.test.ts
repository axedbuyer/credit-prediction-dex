import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  FundingKeeper,
  startHealthServer,
  type IPublicClient,
  type IWalletClient,
  type KeeperConfig,
  type CronScheduler,
} from '../funding-keeper'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CREDIT_MARKET = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0' as const
const KEEPER_ADDR   = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
const TX_HASH       = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const

const CONFIG: KeeperConfig = { creditMarketAddress: CREDIT_MARKET }

function makeMocks(overrides: {
  estimateContractGas?: () => Promise<bigint>
  writeContract?: () => Promise<string>
  waitForTransactionReceipt?: () => Promise<{ status: 'success' | 'reverted' }>
  readContract?: () => Promise<unknown>
} = {}) {
  const publicClient: IPublicClient = {
    estimateContractGas: vi.fn().mockImplementation(
      overrides.estimateContractGas ?? (() => Promise.resolve(150_000n)),
    ),
    waitForTransactionReceipt: vi.fn().mockImplementation(
      overrides.waitForTransactionReceipt ??
        (() => Promise.resolve({ status: 'success' as const })),
    ),
    readContract: vi.fn().mockImplementation(
      overrides.readContract ?? (() => Promise.resolve(5_000_000_000_000_000n)),
    ),
  }
  const walletClient: IWalletClient = {
    writeContract: vi.fn().mockImplementation(
      overrides.writeContract ?? (() => Promise.resolve(TX_HASH)),
    ),
    account: { address: KEEPER_ADDR },
  }
  return { publicClient, walletClient }
}

// Capture the cron callback so tests can drive it manually.
function makeMockScheduler() {
  let captured: (() => void | Promise<void>) | null = null
  const scheduler: CronScheduler = {
    schedule: vi.fn((_expr: string, cb: () => void | Promise<void>) => {
      captured = cb
    }),
  }
  const fire = async () => {
    if (!captured) throw new Error('scheduler.schedule was never called')
    await (captured as () => Promise<void>)()
  }
  return { scheduler, fire }
}

// ─── Scheduling ───────────────────────────────────────────────────────────────

describe('FundingKeeper — scheduling', () => {
  it('registers exactly the 8-hour cron expression', () => {
    const { publicClient, walletClient } = makeMocks()
    const { scheduler } = makeMockScheduler()
    const keeper = new FundingKeeper(publicClient, walletClient, CONFIG)

    keeper.start(scheduler)

    expect(scheduler.schedule).toHaveBeenCalledOnce()
    expect(scheduler.schedule).toHaveBeenCalledWith('0 */8 * * *', expect.any(Function))
  })
})

// ─── Successful accrual ───────────────────────────────────────────────────────

describe('FundingKeeper — successful accrual', () => {
  let keeper: FundingKeeper
  let publicClient: IPublicClient
  let walletClient: IWalletClient
  let fire: () => Promise<void>

  beforeEach(() => {
    ;({ publicClient, walletClient } = makeMocks())
    const ms = makeMockScheduler()
    keeper = new FundingKeeper(publicClient, walletClient, CONFIG)
    keeper.start(ms.scheduler)
    fire = ms.fire
  })

  it('calls accrueFunding when the cron fires', async () => {
    await fire()
    expect(walletClient.writeContract).toHaveBeenCalledOnce()
    const args = (walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(args.functionName).toBe('accrueFunding')
    expect(args.address).toBe(CREDIT_MARKET)
  })

  it('estimates gas and adds the 20% buffer', async () => {
    await fire()
    const estimatedGas = 150_000n
    const expected = (estimatedGas * 120n) / 100n   // 180 000
    const writeArgs = (walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(writeArgs.gas).toBe(expected)
  })

  it('reads cumulativeFundingPerYES after the tx succeeds', async () => {
    await fire()
    const readArgs = (publicClient.readContract as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(readArgs.functionName).toBe('cumulativeFundingPerYES')
    expect(readArgs.address).toBe(CREDIT_MARKET)
  })

  it('updates lastRunAt on success', async () => {
    expect(keeper.getLastRunAt()).toBeNull()
    await fire()
    expect(keeper.getLastRunAt()).toBeInstanceOf(Date)
  })
})

// ─── Error handling ───────────────────────────────────────────────────────────

describe('FundingKeeper — error handling', () => {
  it('does not throw when tx submission fails — logs and continues', async () => {
    const { publicClient, walletClient } = makeMocks({
      writeContract: () => Promise.reject(new Error('nonce too low')),
    })
    const { scheduler, fire } = makeMockScheduler()
    const keeper = new FundingKeeper(publicClient, walletClient, CONFIG)
    keeper.start(scheduler)

    await expect(fire()).resolves.not.toThrow()
    expect(keeper.getLastRunAt()).toBeNull()   // did not succeed
  })

  it('does not throw when gas estimation fails', async () => {
    const { publicClient, walletClient } = makeMocks({
      estimateContractGas: () => Promise.reject(new Error('execution reverted')),
    })
    const { scheduler, fire } = makeMockScheduler()
    const keeper = new FundingKeeper(publicClient, walletClient, CONFIG)
    keeper.start(scheduler)

    await expect(fire()).resolves.not.toThrow()
    expect(walletClient.writeContract).not.toHaveBeenCalled()
  })

  it('does not update lastRunAt when tx is reverted', async () => {
    const { publicClient, walletClient } = makeMocks({
      waitForTransactionReceipt: () => Promise.resolve({ status: 'reverted' }),
    })
    const { scheduler, fire } = makeMockScheduler()
    const keeper = new FundingKeeper(publicClient, walletClient, CONFIG)
    keeper.start(scheduler)

    await fire()
    expect(keeper.getLastRunAt()).toBeNull()
  })

  it('survives a readContract failure after a successful tx (non-fatal)', async () => {
    const { publicClient, walletClient } = makeMocks({
      readContract: () => Promise.reject(new Error('RPC error')),
    })
    const { scheduler, fire } = makeMockScheduler()
    const keeper = new FundingKeeper(publicClient, walletClient, CONFIG)
    keeper.start(scheduler)

    await expect(fire()).resolves.not.toThrow()
    // tx succeeded, so lastRunAt IS updated even when readContract fails
    expect(keeper.getLastRunAt()).toBeInstanceOf(Date)
  })
})

// ─── Health server ────────────────────────────────────────────────────────────

describe('startHealthServer', () => {
  it('returns 200 with lastRunAt=null before any run', async () => {
    const { publicClient, walletClient } = makeMocks()
    const keeper = new FundingKeeper(publicClient, walletClient, CONFIG)

    const server = startHealthServer(keeper, 0)  // port 0 = OS picks a free port
    const port = (server.address() as { port: number }).port

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      expect(res.status).toBe(200)
      const body = await res.json() as { status: string; lastRunAt: string | null }
      expect(body.status).toBe('ok')
      expect(body.lastRunAt).toBeNull()
    } finally {
      await new Promise<void>(r => server.close(() => r()))
    }
  })

  it('returns the lastRunAt timestamp after a successful run', async () => {
    const { publicClient, walletClient } = makeMocks()
    const { scheduler, fire } = makeMockScheduler()
    const keeper = new FundingKeeper(publicClient, walletClient, CONFIG)
    keeper.start(scheduler)
    await fire()

    const server = startHealthServer(keeper, 0)
    const port = (server.address() as { port: number }).port

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      const body = await res.json() as { lastRunAt: string }
      expect(body.lastRunAt).toBeTruthy()
      expect(() => new Date(body.lastRunAt)).not.toThrow()
    } finally {
      await new Promise<void>(r => server.close(() => r()))
    }
  })
})
