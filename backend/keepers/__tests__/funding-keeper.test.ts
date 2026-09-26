import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  FundingKeeper,
  startHealthServer,
  resolveAddresses,
  type IPublicClient,
  type IWalletClient,
  type IHolderSource,
  type KeeperConfig,
  type CronScheduler,
} from '../funding-keeper'
import type { HolderIndexStatus } from '../holder-index'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const CREDIT_MARKET = '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0' as const
const KEEPER_ADDR   = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266' as const
const HOLDER_ADDR   = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const
const TX_HASH       = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const
const FLAG_TX_HASH  = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const

const CONFIG: KeeperConfig = { creditMarketAddress: CREDIT_MARKET }

function makeStatus(overrides: Partial<HolderIndexStatus> = {}): HolderIndexStatus {
  return {
    holders: 0,
    syncedToBlock: null,
    backfillComplete: true,
    lastSyncAt: null,
    lastError: null,
    ...overrides,
  }
}

// Fake IHolderSource for tests — avoids driving a real on-chain backfill.
// `holders` may be a function so tests can vary the result across calls
// (e.g. empty until refresh() resolves).
function makeFakeHolderSource(
  holdersOrFn: readonly string[] | (() => readonly string[]) = [],
  statusOverrides: Partial<HolderIndexStatus> = {},
): IHolderSource & { refresh: ReturnType<typeof vi.fn> } {
  const getHolders = typeof holdersOrFn === 'function' ? holdersOrFn : () => holdersOrFn
  return {
    refresh: vi.fn().mockResolvedValue(undefined),
    holders: () => getHolders() as unknown as `0x${string}`[],
    status: () => makeStatus({ holders: getHolders().length, ...statusOverrides }),
  }
}

// Default readContract dispatch: handles all function names used by the keeper.
function defaultReadContract(args: { functionName: string }): Promise<unknown> {
  switch (args.functionName) {
    case 'cumulativeFundingPerYES': return Promise.resolve(5_000_000_000_000_000n)
    case 'cumFundingPerNO':         return Promise.resolve(5_000_000_000_000_000n)
    case 'claimable':               return Promise.resolve(false)
    case 'isSeizable':              return Promise.resolve(false)
    case 'frozenFunding':           return Promise.resolve(0n)
    default:                        return Promise.resolve(0n)
  }
}

function makeMocks(overrides: {
  estimateContractGas?: () => Promise<bigint>
  writeContract?: (args: { functionName: string }) => Promise<string>
  waitForTransactionReceipt?: () => Promise<{ status: 'success' | 'reverted' }>
  readContract?: (args: { functionName: string }) => Promise<unknown>
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
      overrides.readContract ?? defaultReadContract,
    ),
  }
  const walletClient: IWalletClient = {
    writeContract: vi.fn().mockImplementation(
      overrides.writeContract ?? (({ functionName }) =>
        Promise.resolve(functionName === 'flagClaimable' ? FLAG_TX_HASH : TX_HASH)
      ),
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
    const holderSource = makeFakeHolderSource()
    const keeper = new FundingKeeper(publicClient, walletClient, holderSource, CONFIG)

    keeper.start(scheduler)

    expect(scheduler.schedule).toHaveBeenCalledOnce()
    expect(scheduler.schedule).toHaveBeenCalledWith('0 */8 * * *', expect.any(Function))
  })

  it('kicks off holderSource.refresh() immediately at startup, before any cron tick', () => {
    const { publicClient, walletClient } = makeMocks()
    const { scheduler } = makeMockScheduler()
    const holderSource = makeFakeHolderSource()
    const keeper = new FundingKeeper(publicClient, walletClient, holderSource, CONFIG)

    keeper.start(scheduler)

    expect(holderSource.refresh).toHaveBeenCalledOnce()
  })

  it('does not throw if the startup holderSource.refresh() rejects', () => {
    const { publicClient, walletClient } = makeMocks()
    const { scheduler } = makeMockScheduler()
    const holderSource = makeFakeHolderSource()
    holderSource.refresh.mockRejectedValueOnce(new Error('rpc down'))
    const keeper = new FundingKeeper(publicClient, walletClient, holderSource, CONFIG)

    expect(() => keeper.start(scheduler)).not.toThrow()
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
    keeper = new FundingKeeper(publicClient, walletClient, makeFakeHolderSource(), CONFIG)
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
    const calls = (publicClient.readContract as ReturnType<typeof vi.fn>).mock.calls
    const yesCall = calls.find((c: unknown[]) => (c[0] as { functionName: string }).functionName === 'cumulativeFundingPerYES')
    expect(yesCall).toBeDefined()
    expect(yesCall[0].address).toBe(CREDIT_MARKET)
  })

  it('reads cumFundingPerNO after the tx succeeds', async () => {
    await fire()
    const calls = (publicClient.readContract as ReturnType<typeof vi.fn>).mock.calls
    const noCall = calls.find((c: unknown[]) => (c[0] as { functionName: string }).functionName === 'cumFundingPerNO')
    expect(noCall).toBeDefined()
    expect(noCall[0].address).toBe(CREDIT_MARKET)
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
    const keeper = new FundingKeeper(publicClient, walletClient, makeFakeHolderSource(), CONFIG)
    keeper.start(scheduler)

    await expect(fire()).resolves.not.toThrow()
    expect(keeper.getLastRunAt()).toBeNull()   // did not succeed
  })

  it('does not throw when gas estimation fails', async () => {
    const { publicClient, walletClient } = makeMocks({
      estimateContractGas: () => Promise.reject(new Error('execution reverted')),
    })
    const { scheduler, fire } = makeMockScheduler()
    const keeper = new FundingKeeper(publicClient, walletClient, makeFakeHolderSource(), CONFIG)
    keeper.start(scheduler)

    await expect(fire()).resolves.not.toThrow()
    expect(walletClient.writeContract).not.toHaveBeenCalled()
  })

  it('does not update lastRunAt when tx is reverted', async () => {
    const { publicClient, walletClient } = makeMocks({
      waitForTransactionReceipt: () => Promise.resolve({ status: 'reverted' }),
    })
    const { scheduler, fire } = makeMockScheduler()
    const keeper = new FundingKeeper(publicClient, walletClient, makeFakeHolderSource(), CONFIG)
    keeper.start(scheduler)

    await fire()
    expect(keeper.getLastRunAt()).toBeNull()
  })

  it('survives a readContract failure after a successful tx (non-fatal)', async () => {
    const { publicClient, walletClient } = makeMocks({
      readContract: () => Promise.reject(new Error('RPC error')),
    })
    const { scheduler, fire } = makeMockScheduler()
    const keeper = new FundingKeeper(publicClient, walletClient, makeFakeHolderSource(), CONFIG)
    keeper.start(scheduler)

    await expect(fire()).resolves.not.toThrow()
    // tx succeeded, so lastRunAt IS updated even when readContract fails
    expect(keeper.getLastRunAt()).toBeInstanceOf(Date)
  })
})

// ─── Seizure checks ───────────────────────────────────────────────────────────

describe('FundingKeeper — seizure checks', () => {
  it('checks isSeizable for each holder returned by the holder source, after accrual', async () => {
    const { publicClient, walletClient } = makeMocks()
    const { scheduler, fire } = makeMockScheduler()
    const holderSource = makeFakeHolderSource([HOLDER_ADDR])
    const keeper = new FundingKeeper(publicClient, walletClient, holderSource, CONFIG)
    keeper.start(scheduler)

    await fire()

    const readCalls = (publicClient.readContract as ReturnType<typeof vi.fn>).mock.calls
    const isSeizableCall = readCalls.find(
      (c: unknown[]) => (c[0] as { functionName: string; args?: unknown[] }).functionName === 'isSeizable' &&
        (c[0] as { args?: unknown[] }).args?.[0] === HOLDER_ADDR,
    )
    expect(isSeizableCall).toBeDefined()
  })

  it('awaits holderSource.refresh() before reading holders() — a source whose list is only populated after refresh resolves is still fully checked', async () => {
    const { publicClient, walletClient } = makeMocks({
      readContract: ({ functionName }) => {
        if (functionName === 'claimable')  return Promise.resolve(false)
        if (functionName === 'isSeizable') return Promise.resolve(false)
        return defaultReadContract({ functionName })
      },
    })
    const { scheduler, fire } = makeMockScheduler()

    let ready = false
    const holderSource: IHolderSource & { refresh: ReturnType<typeof vi.fn> } = {
      refresh: vi.fn().mockImplementation(async () => {
        // Simulate a backfill that only populates holders() once it resolves.
        await Promise.resolve()
        ready = true
      }),
      holders: () => (ready ? [HOLDER_ADDR] : []),
      status: () => makeStatus({ holders: ready ? 1 : 0 }),
    }

    const keeper = new FundingKeeper(publicClient, walletClient, holderSource, CONFIG)
    keeper.start(scheduler)

    await fire()

    expect(holderSource.refresh).toHaveBeenCalled()
    const readCalls = (publicClient.readContract as ReturnType<typeof vi.fn>).mock.calls
    const isSeizableCall = readCalls.find(
      (c: unknown[]) => (c[0] as { functionName: string; args?: unknown[] }).functionName === 'isSeizable' &&
        (c[0] as { args?: unknown[] }).args?.[0] === HOLDER_ADDR,
    )
    // If runOnce read holders() before awaiting refresh(), this would be undefined.
    expect(isSeizableCall).toBeDefined()
  })

  it('calls flagClaimable for a holder that is seizable and not already claimable', async () => {
    const { publicClient, walletClient } = makeMocks({
      readContract: ({ functionName }) => {
        if (functionName === 'claimable')   return Promise.resolve(false)
        if (functionName === 'isSeizable')  return Promise.resolve(true)
        if (functionName === 'frozenFunding') return Promise.resolve(4_500_000_000_000_000n)
        return defaultReadContract({ functionName })
      },
    })
    const { scheduler, fire } = makeMockScheduler()
    const keeper = new FundingKeeper(publicClient, walletClient, makeFakeHolderSource([HOLDER_ADDR]), CONFIG)
    keeper.start(scheduler)

    await fire()

    const writeCalls = (walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls
    const flagCall = writeCalls.find(
      (c: unknown[]) => (c[0] as { functionName: string }).functionName === 'flagClaimable',
    )
    expect(flagCall).toBeDefined()
    expect(flagCall[0].args).toEqual([HOLDER_ADDR])
    expect(flagCall[0].address).toBe(CREDIT_MARKET)
  })

  it('does not call flagClaimable for a holder that is already claimable', async () => {
    const { publicClient, walletClient } = makeMocks({
      readContract: ({ functionName }) => {
        if (functionName === 'claimable') return Promise.resolve(true)  // already flagged
        return defaultReadContract({ functionName })
      },
    })
    const { scheduler, fire } = makeMockScheduler()
    const keeper = new FundingKeeper(publicClient, walletClient, makeFakeHolderSource([HOLDER_ADDR]), CONFIG)
    keeper.start(scheduler)

    await fire()

    const writeCalls = (walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls
    const flagCall = writeCalls.find(
      (c: unknown[]) => (c[0] as { functionName: string }).functionName === 'flagClaimable',
    )
    expect(flagCall).toBeUndefined()

    // isSeizable should not be called either (early exit after claimable check)
    const readCalls = (publicClient.readContract as ReturnType<typeof vi.fn>).mock.calls
    const isSeizableCall = readCalls.find(
      (c: unknown[]) => (c[0] as { functionName: string }).functionName === 'isSeizable',
    )
    expect(isSeizableCall).toBeUndefined()
  })

  it('does not call flagClaimable for a holder that is not seizable', async () => {
    const { publicClient, walletClient } = makeMocks({
      readContract: ({ functionName }) => {
        if (functionName === 'claimable')  return Promise.resolve(false)
        if (functionName === 'isSeizable') return Promise.resolve(false)  // not seizable
        return defaultReadContract({ functionName })
      },
    })
    const { scheduler, fire } = makeMockScheduler()
    const keeper = new FundingKeeper(publicClient, walletClient, makeFakeHolderSource([HOLDER_ADDR]), CONFIG)
    keeper.start(scheduler)

    await fire()

    const writeCalls = (walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls
    const flagCall = writeCalls.find(
      (c: unknown[]) => (c[0] as { functionName: string }).functionName === 'flagClaimable',
    )
    expect(flagCall).toBeUndefined()
  })

  it('uses the 20% gas buffer for flagClaimable', async () => {
    const { publicClient, walletClient } = makeMocks({
      readContract: ({ functionName }) => {
        if (functionName === 'claimable')  return Promise.resolve(false)
        if (functionName === 'isSeizable') return Promise.resolve(true)
        return defaultReadContract({ functionName })
      },
    })
    const { scheduler, fire } = makeMockScheduler()
    const keeper = new FundingKeeper(publicClient, walletClient, makeFakeHolderSource([HOLDER_ADDR]), CONFIG)
    keeper.start(scheduler)

    await fire()

    const writeCalls = (walletClient.writeContract as ReturnType<typeof vi.fn>).mock.calls
    const flagCall = writeCalls.find(
      (c: unknown[]) => (c[0] as { functionName: string }).functionName === 'flagClaimable',
    )
    const estimatedGas = 150_000n
    expect(flagCall[0].gas).toBe((estimatedGas * 120n) / 100n)
  })

  it('still updates lastRunAt even when a holder flagClaimable tx reverts', async () => {
    // accrueFunding succeeds; flagClaimable reverts
    const { publicClient, walletClient } = makeMocks({
      readContract: ({ functionName }) => {
        if (functionName === 'claimable')  return Promise.resolve(false)
        if (functionName === 'isSeizable') return Promise.resolve(true)
        return defaultReadContract({ functionName })
      },
      waitForTransactionReceipt: vi.fn()
        .mockResolvedValueOnce({ status: 'success' })   // accrueFunding receipt
        .mockResolvedValueOnce({ status: 'reverted' })  // flagClaimable receipt
        .getMockImplementation() ?? (() => Promise.resolve({ status: 'success' as const })),
    })
    const { scheduler, fire } = makeMockScheduler()
    const keeper = new FundingKeeper(publicClient, walletClient, makeFakeHolderSource([HOLDER_ADDR]), CONFIG)
    keeper.start(scheduler)

    await fire()

    // Accrual succeeded, so lastRunAt is set regardless of flag outcome
    expect(keeper.getLastRunAt()).toBeInstanceOf(Date)
  })
})

// ─── Health server ────────────────────────────────────────────────────────────

describe('startHealthServer', () => {
  it('returns 200 with lastRunAt=null before any run', async () => {
    const { publicClient, walletClient } = makeMocks()
    const keeper = new FundingKeeper(publicClient, walletClient, makeFakeHolderSource(), CONFIG)

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
    const keeper = new FundingKeeper(publicClient, walletClient, makeFakeHolderSource(), CONFIG)
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

  it('includes the holder index status', async () => {
    const { publicClient, walletClient } = makeMocks()
    const holderSource = makeFakeHolderSource([HOLDER_ADDR], {
      syncedToBlock: '12345',
      backfillComplete: false,
      lastError: 'boom',
    })
    const keeper = new FundingKeeper(publicClient, walletClient, holderSource, CONFIG)

    const server = startHealthServer(keeper, 0)
    const port = (server.address() as { port: number }).port

    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      expect(res.status).toBe(200)
      const body = await res.json() as { holderIndex: HolderIndexStatus }
      expect(body.holderIndex).toEqual({
        holders: 1,
        syncedToBlock: '12345',
        backfillComplete: false,
        lastSyncAt: null,
        lastError: 'boom',
      })
    } finally {
      await new Promise<void>(r => server.close(() => r()))
    }
  })
})

// ─── resolveAddresses ────────────────────────────────────────────────

describe('resolveAddresses', () => {
  function withTmpDeploymentsFile(contents: string | null): { deploymentsPath: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'funding-keeper-test-'))
    const deploymentsPath = path.join(dir, 'base-sepolia.json')
    if (contents !== null) fs.writeFileSync(deploymentsPath, contents)
    return { deploymentsPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) }
  }

  it('prefers env vars over the deployments file', () => {
    const { deploymentsPath, cleanup } = withTmpDeploymentsFile(
      JSON.stringify({ creditMarket: '0xFileCM', yesToken: '0xFileYES' }),
    )
    try {
      const { creditMarketAddress, yesTokenAddress } = resolveAddresses(
        { CREDIT_MARKET_ADDRESS: '0xEnvCM', YES_TOKEN_ADDRESS: '0xEnvYES' } as NodeJS.ProcessEnv,
        deploymentsPath,
      )
      expect(creditMarketAddress).toBe('0xEnvCM')
      expect(yesTokenAddress).toBe('0xEnvYES')
    } finally {
      cleanup()
    }
  })

  it('falls back to the deployments file for whichever address is unset', () => {
    const { deploymentsPath, cleanup } = withTmpDeploymentsFile(
      JSON.stringify({ creditMarket: '0xFileCM', yesToken: '0xFileYES' }),
    )
    try {
      const { creditMarketAddress, yesTokenAddress } = resolveAddresses(
        { CREDIT_MARKET_ADDRESS: '0xEnvCM' } as NodeJS.ProcessEnv,
        deploymentsPath,
      )
      expect(creditMarketAddress).toBe('0xEnvCM')
      expect(yesTokenAddress).toBe('0xFileYES')
    } finally {
      cleanup()
    }
  })

  it('resolves YES_TOKEN_ADDRESS from the env var when set (creditMarket falls back to the file)', () => {
    const { deploymentsPath, cleanup } = withTmpDeploymentsFile(
      JSON.stringify({ creditMarket: '0xFileCM' }),
    )
    try {
      const { creditMarketAddress, yesTokenAddress } = resolveAddresses(
        { YES_TOKEN_ADDRESS: '0xEnvYES' } as NodeJS.ProcessEnv,
        deploymentsPath,
      )
      expect(creditMarketAddress).toBe('0xFileCM')
      expect(yesTokenAddress).toBe('0xEnvYES')
    } finally {
      cleanup()
    }
  })

  it('throws a clear error naming both env vars when the file is missing', () => {
    const missingPath = path.join(os.tmpdir(), 'does-not-exist-' + Date.now(), 'base-sepolia.json')
    expect(() => resolveAddresses({} as NodeJS.ProcessEnv, missingPath))
      .toThrow(/CREDIT_MARKET_ADDRESS, YES_TOKEN_ADDRESS is not set and .* could not be read/)
  })

  it('throws a clear error naming only the still-missing env var when the file is missing', () => {
    const missingPath = path.join(os.tmpdir(), 'does-not-exist-' + Date.now(), 'base-sepolia.json')
    expect(() => resolveAddresses(
      { CREDIT_MARKET_ADDRESS: '0xEnvCM' } as NodeJS.ProcessEnv,
      missingPath,
    )).toThrow(/^YES_TOKEN_ADDRESS is not set and .* could not be read/)
  })

  it('throws a clear error when the file has no creditMarket key', () => {
    const { deploymentsPath, cleanup } = withTmpDeploymentsFile(JSON.stringify({ yesToken: '0xFileYES' }))
    try {
      expect(() => resolveAddresses({} as NodeJS.ProcessEnv, deploymentsPath))
        .toThrow(/CREDIT_MARKET_ADDRESS is not set and .* has no "creditMarket" key/)
    } finally {
      cleanup()
    }
  })

  it('throws a clear error naming YES_TOKEN_ADDRESS when the file has no yesToken key', () => {
    const { deploymentsPath, cleanup } = withTmpDeploymentsFile(JSON.stringify({ creditMarket: '0xFileCM' }))
    try {
      expect(() => resolveAddresses({} as NodeJS.ProcessEnv, deploymentsPath))
        .toThrow(/YES_TOKEN_ADDRESS is not set and .* has no "yesToken" key/)
    } finally {
      cleanup()
    }
  })
})
