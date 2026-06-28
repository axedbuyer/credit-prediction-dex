import http from 'http'
import path from 'path'
import fs from 'fs'
import cron from 'node-cron'
import { createPublicClient, createWalletClient, defineChain, http as viemHttp } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import type { Address, Hash } from 'viem'

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
    name: 'frozenFunding',
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

// ─── Config ───────────────────────────────────────────────────────────────────

export interface KeeperConfig {
  creditMarketAddress: Address
  trackedHolders: Address[]
}

// ─── Scheduler interface (injected for testability) ───────────────────────────

export interface CronScheduler {
  schedule(expression: string, callback: () => void | Promise<void>): unknown
}

// ─── FundingKeeper ────────────────────────────────────────────────────────────

export class FundingKeeper {
  private lastRunAt: Date | null = null

  constructor(
    private readonly publicClient: IPublicClient,
    private readonly walletClient: IWalletClient,
    private readonly config: KeeperConfig,
  ) {}

  /**
   * Register the 8-hour cron schedule.
   * Pass a mock scheduler in tests to capture the callback and drive it manually.
   */
  start(scheduler: CronScheduler = cron): void {
    console.log('[keeper] scheduling accrueFunding @ "0 */8 * * *"')
    scheduler.schedule('0 */8 * * *', async () => {
      try {
        await this.runOnce()
      } catch (err) {
        console.error('[keeper] unhandled error in runOnce:', err)
      }
    })
  }

  /**
   * Run one accrual cycle:
   *  1. Estimate gas (+20% buffer)
   *  2. Call accrueFunding()
   *  3. Wait for receipt
   *  4. Read cumulativeFundingPerYES and cumFundingPerNO and log
   *  5. Update lastRunAt
   *  6. Check each tracked YES holder for seizure; flag newly-seizable ones
   *
   * Any failure is logged and swallowed — the keeper stays alive and will retry
   * at the next scheduled tick.
   */
  async runOnce(): Promise<void> {
    const account = this.walletClient.account?.address
    if (!account) throw new Error('wallet client has no account')

    const ts = new Date().toISOString()
    console.log(`[keeper] ${ts} — accruing funding…`)

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
      console.error(`[keeper] ${ts} — gas estimation failed:`, err)
      return
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
      console.error(`[keeper] ${ts} — accrueFunding tx failed:`, err)
      return
    }

    console.log(`[keeper] ${ts} — submitted ${txHash}`)

    // 3. Wait for receipt
    let receipt: { status: 'success' | 'reverted' }
    try {
      receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash })
    } catch (err) {
      console.error(`[keeper] ${ts} — receipt wait failed for ${txHash}:`, err)
      return
    }

    if (receipt.status !== 'success') {
      console.error(`[keeper] ${ts} — accrueFunding REVERTED: ${txHash}`)
      return
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
        `[keeper] ${ts} — accrueFunding OK  tx=${txHash}` +
        `  cumulativeFundingPerYES=${cumFundingYES.toString()}` +
        `  cumFundingPerNO=${cumFundingNO.toString()}`,
      )
    } catch (err) {
      // Non-fatal: tx succeeded, just couldn't read the updated value
      console.error(`[keeper] ${ts} — could not read funding indices:`, err)
    }

    // 5. Record last successful run
    this.lastRunAt = new Date()

    // 6. Seizure check for tracked YES holders
    for (const holder of this.config.trackedHolders) {
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
        console.log(`[keeper] ${ts} — ${holder}: already claimable, skipping`)
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
      console.log(`[keeper] ${ts} — ${holder}: seizable — flagging claimable…`)

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
        console.error(`[keeper] ${ts} — gas estimation for flagClaimable(${holder}) failed:`, err)
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
        console.error(`[keeper] ${ts} — flagClaimable(${holder}) tx failed:`, err)
        return
      }

      const flagReceipt = await this.publicClient.waitForTransactionReceipt({ hash: flagHash })
      if (flagReceipt.status !== 'success') {
        console.error(`[keeper] ${ts} — flagClaimable(${holder}) REVERTED: ${flagHash}`)
        return
      }

      // Log frozen funding after successful flag
      try {
        const frozen = await this.publicClient.readContract({
          address:      this.config.creditMarketAddress,
          abi:          CREDIT_MARKET_ABI,
          functionName: 'frozenFunding',
          args:         [holder],
        }) as bigint

        console.log(
          `[keeper] ${ts} — flagged ${holder}  tx=${flagHash}` +
          `  frozenFunding=${frozen.toString()}`,
        )
      } catch (err) {
        console.error(`[keeper] ${ts} — could not read frozenFunding(${holder}):`, err)
      }
    } catch (err) {
      console.error(`[keeper] ${ts} — unexpected error for holder ${holder}:`, err)
    }
  }

  getLastRunAt(): Date | null {
    return this.lastRunAt
  }
}

// ─── Health-check HTTP server ─────────────────────────────────────────────────

export function startHealthServer(keeper: FundingKeeper, port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        lastRunAt: keeper.getLastRunAt()?.toISOString() ?? null,
        schedule: '0 */8 * * *',
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

// ─── Production entry point ───────────────────────────────────────────────────

function main(): void {
  const privateKey = process.env.KEEPER_PRIVATE_KEY
  if (!privateKey) throw new Error('KEEPER_PRIVATE_KEY env var is required')

  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL
  if (!rpcUrl) throw new Error('BASE_SEPOLIA_RPC_URL env var is required')

  // CREDIT_MARKET_ADDRESS env var takes precedence over the deployments file
  let creditMarketAddress: string
  if (process.env.CREDIT_MARKET_ADDRESS) {
    creditMarketAddress = process.env.CREDIT_MARKET_ADDRESS
  } else {
    // Path: keepers/ → ../../ → project root → contracts/deployments/
    const deploymentsPath = path.join(
      __dirname, '..', '..', 'contracts', 'deployments', 'base-sepolia.json',
    )
    const deployments = JSON.parse(fs.readFileSync(deploymentsPath, 'utf8')) as {
      creditMarket: string
    }
    creditMarketAddress = deployments.creditMarket
  }

  // TRACKED_HOLDERS env var: comma-separated list of YES holder addresses to monitor
  const trackedHolders: Address[] = (process.env.TRACKED_HOLDERS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(s => s.length > 0) as Address[]

  const account   = privateKeyToAccount(privateKey as `0x${string}`)
  const transport = viemHttp(rpcUrl)

  // CHAIN_ID env var lets local Anvil (31337) work without code changes
  const chainId = parseInt(process.env.CHAIN_ID ?? '84532')
  const chain = chainId === baseSepolia.id
    ? baseSepolia
    : defineChain({ id: chainId, name: 'Local', nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } })

  const publicClient  = createPublicClient({ chain, transport })
  const walletClient  = createWalletClient({ account, chain, transport })

  const keeper = new FundingKeeper(
    publicClient  as unknown as IPublicClient,
    walletClient  as unknown as IWalletClient,
    { creditMarketAddress: creditMarketAddress as Address, trackedHolders },
  )

  keeper.start()
  startHealthServer(keeper, parseInt(process.env.HEALTH_PORT ?? '3002'))

  console.log('[keeper] started')
}

if (require.main === module) {
  main()
}
