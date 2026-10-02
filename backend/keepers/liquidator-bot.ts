// liquidator-bot.ts — the team's liquidator of last resort. Claims EVERY
// seizure-flagged Upbet (YES) position as soon as it's seen (policy: claim
// promptly, profitable or not — tail-case claims are break-even for the bot
// and let the InsuranceFund top up; stalls are what cost the fund, per root
// CLAUDE.md's Funding Model / liquidation math). Hands whatever YES the bot
// accumulates back to the CLOB via an injected IYesSeller.
//
// Structure mirrors liquidation-keeper.ts (holder discovery, health server,
// main()) and funding-keeper.ts (wallet client, gas +20%, writeContract,
// receipt handling, stop()). The bot drives an IYesSeller (seller.ts); in
// production that's ClobYesSeller (clob-seller.ts).
//
// Claiming uses only LiquidationEngine.claim(user) and the handful of common
// views below, so it works unchanged against old and fixed contracts. The one
// exception is a BEST-EFFORT CreditMarket.owed(user) read, used only to estimate
// tail-case shortfalls for the shared-InsuranceFund alert — if it fails, the
// estimate is simply 0 and claiming is unaffected.
//
// Multi-market: markets come from a BotMarketsProvider (the registry directory in
// production, or a single static market via the 5-arg constructor); one wallet and
// one USDC float serve them all — see the LiquidatorBot class comment.

import http from 'http'
import path from 'path'
import fs from 'fs'
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http as viemHttp,
  BaseError,
  ContractFunctionRevertedError,
  maxUint256,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { baseSepolia } from 'viem/chains'
import { ClobYesSeller } from './clob-seller'
import type { Address, Hash, LocalAccount } from 'viem'
import { createMarketHolderIndex, HolderIndexManager, aggregateHolderStatus } from './holder-index'
import type { ILogClient, HolderIndexStatus } from './holder-index'
import { installShutdownHandlers, closeHttpServer } from './shutdown'
import type { IYesSeller, SellResult } from './seller'
import { buildDirectory, readRegistryShared } from './markets'
import type { IRegistryClient, MarketInfo, MarketDirectory, MarketDirectoryStatus } from './registry'

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
    name: 'motionPending',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'currentMark',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'owed',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
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
  {
    name: 'allowance',
    type: 'function' as const,
    stateMutability: 'view' as const,
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'approve',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

// LiquidationEngine.claim + the errors/event it (or its callees) can surface.
// PositionFrozen and the OZ v5 ERC20 errors are NOT thrown by today's claim()
// (verified by reading LiquidationEngine.sol / CreditMarket.sol / InsuranceFund.sol) —
// they're included defensively:
//   - PositionFrozen: CreditMarket's own freeze error. claim() doesn't check the
//     CALLER's claimable flag today, only the target's (via NotClaimable), but
//     decoding it costs nothing and catches the case if a future redeploy adds a
//     caller-side freeze check (the bot itself having become a flagged holder).
//   - ERC20InsufficientBalance/Allowance: OZ v5's IERC20Errors, surfaced when
//     InsuranceFund.coverShortfall's safeTransfer (tail-case top-up into
//     CreditMarket) exceeds the fund's USDC balance/allowance. Since the bot's
//     own USDC balance is pre-checked against the cost upper-bound (Q × m / 1e18
//     ≥ P always) before every claim, an insufficient-balance revert at this
//     point is attributed to the InsuranceFund leg, not the bot's own payment.
export const LIQUIDATION_ENGINE_ABI = [
  {
    name: 'claim',
    type: 'function' as const,
    stateMutability: 'nonpayable' as const,
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [],
  },
  {
    name: 'NotClaimable',
    type: 'error' as const,
    inputs: [],
  },
  {
    name: 'MotionPending',
    type: 'error' as const,
    inputs: [],
  },
  {
    name: 'PositionFrozen',
    type: 'error' as const,
    inputs: [],
  },
  {
    name: 'ERC20InsufficientBalance',
    type: 'error' as const,
    inputs: [
      { name: 'sender', type: 'address' },
      { name: 'balance', type: 'uint256' },
      { name: 'needed', type: 'uint256' },
    ],
  },
  {
    name: 'ERC20InsufficientAllowance',
    type: 'error' as const,
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'allowance', type: 'uint256' },
      { name: 'needed', type: 'uint256' },
    ],
  },
  {
    name: 'Liquidated',
    type: 'event' as const,
    inputs: [
      { name: 'originalHolder', type: 'address', indexed: true },
      { name: 'liquidator', type: 'address', indexed: true },
      { name: 'yesAmount', type: 'uint256', indexed: false },
      { name: 'pricePaid', type: 'uint256', indexed: false },
      { name: 'tailCase', type: 'bool', indexed: false },
    ],
  },
] as const

// ─── Narrow client interfaces (real viem clients satisfy these) ───────────────

export interface LogLike {
  address: Address
  topics: readonly `0x${string}`[]
  data: `0x${string}`
}

export interface IPublicClient {
  readContract(args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args?: readonly unknown[]
  }): Promise<unknown>
  estimateContractGas(args: {
    address: Address
    abi: readonly unknown[]
    functionName: string
    args: readonly unknown[]
    account: Address
  }): Promise<bigint>
  waitForTransactionReceipt(args: {
    hash: Hash
  }): Promise<{ status: 'success' | 'reverted'; logs: readonly LogLike[] }>
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

// Narrow view of HolderIndex — lets tests inject a fake instead of a real
// Redis/RPC-backed instance. Same shape used by the other two keepers.
export interface IHolderSource {
  refresh(): Promise<void>
  holders(): Address[]
  status(): HolderIndexStatus
}

// ─── Config ───────────────────────────────────────────────────────────────────

/** Settings shared by every market: one wallet's USDC and the shared InsuranceFund. */
export interface BotSharedConfig {
  usdcAddress: Address
  insuranceFundAddress: Address
  pollIntervalMs?: number // default 30_000
  autoSell?: boolean      // default true
}

/** Single-market config (legacy / the 5-arg LiquidatorBot constructor). */
export interface BotConfig extends BotSharedConfig {
  creditMarketAddress: Address
  yesTokenAddress: Address
  liquidationEngineAddress: Address
  clobSettlementAddress: Address
}

/** Everything the bot needs for ONE market. */
export interface BotMarket {
  slug: string
  creditMarketAddress: Address
  yesTokenAddress: Address
  liquidationEngineAddress: Address
  clobSettlementAddress: Address
  holderSource: IHolderSource
  /** Sells the YES acquired in THIS market on THIS market's book. */
  seller: IYesSeller
}

export interface BotMarketsProvider {
  /** Current markets (called every cycle — may grow as the registry refreshes). */
  markets(): BotMarket[]
  /** Present => multi-market /health additions (`registry`, `markets`, `alerts`). */
  registryStatus?(): MarketDirectoryStatus
}

// ─── Health / counters ─────────────────────────────────────────────────────────

export type SkipReason =
  | 'motionPending'
  | 'zeroBalance'
  | 'insufficientFloat'
  | 'notClaimable'
  | 'botFrozen'
  | 'insuranceFundShortfall'
  | 'other'

export interface BotAlerts {
  /** Largest single still-pending claim cost bound at the end of the last cycle (USDC raw). */
  largestPendingClaim: string
  /** max(0, largestPendingClaim − usdcBalance). */
  floatShortfall: string
  /** Sum of estimated tail-case shortfalls over all pending claims, all markets. */
  pendingTailShortfall: string
  /** max(0, pendingTailShortfall − InsuranceFund USDC balance). */
  insuranceFundShortfall: string
}

export interface BotMarketHealth {
  lastCycleAt: string | null
  claims: number
  tailClaims: number
  skippedByReason: Record<string, number>
  lastError: string | null
  yesBalance: string | null
  motionPending: boolean | null
  pendingClaims: number
  pendingTailShortfall: string
  holderIndex: HolderIndexStatus
}

export interface BotHealth {
  status: 'ok'
  lastCycleAt: string | null
  claims: number
  tailClaims: number
  skippedByReason: Record<string, number>
  lastError: string | null
  usdcBalance: string | null
  /** Sum of the bot's YES balances across markets (null until first read). */
  yesBalance: string | null
  /** Aggregate across markets — worst case (see aggregateHolderStatus). */
  holderIndex: HolderIndexStatus
  // Multi-market additions:
  registry?: MarketDirectoryStatus
  alerts?: BotAlerts
  markets?: Record<string, BotMarketHealth>
}

interface BotState {
  lastCycleAt: string | null
  claims: number
  tailClaims: number
  skippedByReason: Partial<Record<SkipReason, number>>
  lastError: string | null
  usdcBalance: bigint | null
  yesBalance: bigint | null
}

interface MarketBotState {
  lastCycleAt: string | null
  claims: number
  tailClaims: number
  skippedByReason: Partial<Record<SkipReason, number>>
  lastError: string | null
  yesBalance: bigint | null
  motionPending: boolean | null
  pendingClaims: number
  pendingTailShortfall: bigint
}

// ─── Revert decoding ────────────────────────────────────────────────────────────

export type DecodedClaimRevert =
  | { kind: 'MotionPending' }
  | { kind: 'NotClaimable' }
  | { kind: 'PositionFrozen' }
  | { kind: 'ERC20InsufficientBalance'; sender?: Address; balance?: bigint; needed?: bigint }
  | { kind: 'ERC20InsufficientAllowance'; spender?: Address; allowance?: bigint; needed?: bigint }
  | { kind: 'other' }

// Decodes a deterministic custom-error revert out of a thrown
// estimateContractGas error, the same way matching-engine/src/settler.ts's
// decodeSettlementError does: viem wraps an on-chain revert in a BaseError
// chain, and once the ABI passed to the call includes the error definition,
// ContractFunctionRevertedError.data.{errorName,args} carries the decode.
// Anything else (RPC hiccup, an as-yet-unhandled revert reason) yields 'other'.
export function decodeClaimRevert(err: unknown): DecodedClaimRevert {
  if (err instanceof BaseError) {
    const revertError = err.walk(
      e => e instanceof ContractFunctionRevertedError,
    ) as ContractFunctionRevertedError | null
    const errorName = revertError?.data?.errorName
    const args = revertError?.data?.args as readonly unknown[] | undefined

    if (errorName === 'MotionPending') return { kind: 'MotionPending' }
    if (errorName === 'NotClaimable') return { kind: 'NotClaimable' }
    if (errorName === 'PositionFrozen') return { kind: 'PositionFrozen' }
    if (errorName === 'ERC20InsufficientBalance') {
      return {
        kind: 'ERC20InsufficientBalance',
        sender:  args?.[0] as Address | undefined,
        balance: args?.[1] as bigint | undefined,
        needed:  args?.[2] as bigint | undefined,
      }
    }
    if (errorName === 'ERC20InsufficientAllowance') {
      return {
        kind: 'ERC20InsufficientAllowance',
        spender:   args?.[0] as Address | undefined,
        allowance: args?.[1] as bigint | undefined,
        needed:    args?.[2] as bigint | undefined,
      }
    }
  }
  return { kind: 'other' }
}

// Parses the Liquidated event out of a claim() tx's receipt logs. Filters by
// the LiquidationEngine address first (cheap, avoids decoding unrelated logs
// from the same tx, e.g. Transfer/ERC20 events) then tries to decode each as
// Liquidated; returns undefined if not found (defensive — should always be
// present on a successful claim()).
export function parseLiquidatedEvent(
  logs: readonly LogLike[],
  liquidationEngineAddress: Address,
): { originalHolder: Address; liquidator: Address; yesAmount: bigint; pricePaid: bigint; tailCase: boolean } | undefined {
  const target = liquidationEngineAddress.toLowerCase()
  for (const log of logs) {
    if (log.address.toLowerCase() !== target) continue
    try {
      // Lazy import avoids pulling decodeEventLog into every call site; cheap
      // enough here since this only runs once per successful claim.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { decodeEventLog } = require('viem') as typeof import('viem')
      const decoded = decodeEventLog({
        abi:    LIQUIDATION_ENGINE_ABI,
        data:   log.data,
        topics: [...log.topics] as [`0x${string}`, ...`0x${string}`[]],
      })
      if (decoded.eventName === 'Liquidated') {
        const a = decoded.args as {
          originalHolder: Address
          liquidator: Address
          yesAmount: bigint
          pricePaid: bigint
          tailCase: boolean
        }
        return a
      }
    } catch {
      // Not a Liquidated log (or undecodable) — keep scanning.
      continue
    }
  }
  return undefined
}

// ─── LiquidatorBot ────────────────────────────────────────────────────────────
//
// Multi-market: one wallet, one USDC float, N markets. Each cycle:
//   1. per market: refresh the holder index, read motionPending + currentMark
//      (a market whose reads fail is skipped for the cycle — the others go on);
//   2. discovery: every flagged (claimable) holder with a YES balance, across all
//      non-frozen markets, plus an estimate of each one's tail-case shortfall;
//   3. alerts: the InsuranceFund is SHARED, so its "short" alert compares its USDC
//      balance with the SUM of the concurrent tail-case shortfalls (owed − m×Q);
//   4. claims, one at a time (one wallet = one nonce stream), each through THAT
//      market's LiquidationEngine, approving USDC to that engine as needed. The float
//      check is per claim (a claim costs ≤ m×Q) and the end-of-cycle float alert
//      compares the balance with the LARGEST single still-pending claim — claims
//      are sequential and each Upbet is resold, so the float never has to cover
//      the sum;
//   5. per market: sell whatever YES the bot holds via that market's IYesSeller.

/** Largest single claim a float must cover vs. the current balance (0 if it covers it). Pure. */
export function floatShortfall(usdcBalance: bigint, pendingCosts: readonly bigint[]): bigint {
  let max = 0n
  for (const c of pendingCosts) if (c > max) max = c
  return max > usdcBalance ? max - usdcBalance : 0n
}

/** How far the shared InsuranceFund's balance falls short of the SUM of concurrent tail shortfalls (0 if it covers them). Pure. */
export function insuranceFundShortfall(fundBalance: bigint, shortfalls: readonly bigint[]): bigint {
  let sum = 0n
  for (const s of shortfalls) sum += s
  return sum > fundBalance ? sum - fundBalance : 0n
}

interface PendingClaim {
  market: BotMarket
  holder: Address
  Q: bigint
  currentMark: bigint
  costBound: bigint
  tailShortfall: bigint
  claimed: boolean
}

export class LiquidatorBot {
  private readonly state: BotState = {
    lastCycleAt:      null,
    claims:           0,
    tailClaims:       0,
    skippedByReason:  {},
    lastError:        null,
    usdcBalance:      null,
    yesBalance:       null,
  }
  private readonly marketStates = new Map<string, MarketBotState>()
  private alerts: BotAlerts = {
    largestPendingClaim: '0', floatShortfall: '0', pendingTailShortfall: '0', insuranceFundShortfall: '0',
  }

  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private inFlightCycle: Promise<void> | null = null

  private readonly provider: BotMarketsProvider
  private readonly config: BotSharedConfig

  // Single-market form (legacy / tests): one static market, flat /health.
  constructor(
    publicClient: IPublicClient,
    walletClient: IWalletClient,
    holderSource: IHolderSource,
    seller: IYesSeller,
    config: BotConfig,
  )
  // Multi-market form: markets come from a provider; /health adds registry + markets.
  constructor(
    publicClient: IPublicClient,
    walletClient: IWalletClient,
    provider: BotMarketsProvider,
    config: BotSharedConfig,
  )
  constructor(
    private readonly publicClient: IPublicClient,
    private readonly walletClient: IWalletClient,
    arg3: IHolderSource | BotMarketsProvider,
    arg4: IYesSeller | BotSharedConfig,
    arg5?: BotConfig,
  ) {
    if (arg5 !== undefined) {
      const cfg = arg5
      const market: BotMarket = {
        slug:                     'mstr',
        creditMarketAddress:      cfg.creditMarketAddress,
        yesTokenAddress:          cfg.yesTokenAddress,
        liquidationEngineAddress: cfg.liquidationEngineAddress,
        clobSettlementAddress:    cfg.clobSettlementAddress,
        holderSource:             arg3 as IHolderSource,
        seller:                   arg4 as IYesSeller,
      }
      this.provider = { markets: () => [market] }
      this.config = cfg
    } else {
      this.provider = arg3 as BotMarketsProvider
      this.config = arg4 as BotSharedConfig
    }
  }

  start(): void {
    const interval = this.config.pollIntervalMs ?? 30_000
    console.log(`[liquidator-bot] polling every ${interval / 1000}s`)
    void this.cycle()
    this.intervalHandle = setInterval(() => {
      if (this.stopped) return
      void this.cycle()
    }, interval)
  }

  /**
   * Graceful-shutdown hook: stops scheduling new cycles, then — if a cycle is
   * currently in flight (it may be waiting on a submitted claim()/approve()
   * tx receipt) — waits for it to finish rather than abandoning it mid-flight.
   */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle)
      this.intervalHandle = null
    }
    if (this.inFlightCycle) await this.inFlightCycle
  }

  /**
   * Single-flight: a call made while a cycle is already running joins it
   * instead of starting a second one (prevents overlapping cycles from
   * double-claiming the same holder).
   */
  cycle(): Promise<void> {
    if (!this.inFlightCycle) {
      this.inFlightCycle = this.runCycle()
        .catch(err => {
          console.error('[liquidator-bot] unhandled error in cycle:', err)
          this.state.lastError = err instanceof Error ? err.message : String(err)
        })
        .finally(() => { this.inFlightCycle = null })
    }
    return this.inFlightCycle
  }

  private requireAccount(): Address {
    const account = this.walletClient.account?.address
    if (!account) throw new Error('wallet client has no account')
    return account
  }

  private mstate(slug: string): MarketBotState {
    let s = this.marketStates.get(slug)
    if (!s) {
      s = { lastCycleAt: null, claims: 0, tailClaims: 0, skippedByReason: {}, lastError: null, yesBalance: null, motionPending: null, pendingClaims: 0, pendingTailShortfall: 0n }
      this.marketStates.set(slug, s)
    }
    return s
  }

  private bumpSkip(reason: SkipReason, slug: string): void {
    this.state.skippedByReason[reason] = (this.state.skippedByReason[reason] ?? 0) + 1
    const ms = this.mstate(slug)
    ms.skippedByReason[reason] = (ms.skippedByReason[reason] ?? 0) + 1
  }

  private setError(slug: string, msg: string): void {
    this.state.lastError = msg
    this.mstate(slug).lastError = msg
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err)
  }

  async runCycle(): Promise<void> {
    const ts = new Date().toISOString()
    const markets = this.provider.markets()

    // ── 1. per-market state ────────────────────────────────────────────────
    const live: Array<{ market: BotMarket; motionPending: boolean; currentMark: bigint }> = []
    for (const market of markets) {
      try {
        await market.holderSource.refresh()
      } catch (err) {
        console.error(`[liquidator-bot] ${ts} — holder source refresh failed for ${market.slug} (continuing with known holders):`, err)
      }

      try {
        const [motionPending, currentMark] = await Promise.all([
          this.publicClient.readContract({
            address:      market.creditMarketAddress,
            abi:          CREDIT_MARKET_ABI,
            functionName: 'motionPending',
          }) as Promise<boolean>,
          this.publicClient.readContract({
            address:      market.creditMarketAddress,
            abi:          CREDIT_MARKET_ABI,
            functionName: 'currentMark',
          }) as Promise<bigint>,
        ])
        this.mstate(market.slug).motionPending = motionPending
        live.push({ market, motionPending, currentMark })
      } catch (err) {
        console.error(`[liquidator-bot] ${ts} — failed to read market state for ${market.slug}:`, err)
        this.setError(market.slug, this.errMsg(err))
      }
    }

    // ── 2. discovery across every non-frozen market ────────────────────────
    const pending: PendingClaim[] = []
    for (const { market, motionPending, currentMark } of live) {
      if (motionPending) {
        console.log(`[liquidator-bot] ${ts} — ${market.slug}: motion pending — skipping all claims this cycle`)
        this.bumpSkip('motionPending', market.slug)
        continue
      }
      for (const holder of market.holderSource.holders()) {
        const p = await this.discover(market, holder, currentMark, ts)
        if (p) pending.push(p)
      }
    }
    for (const market of markets) {
      const mine = pending.filter(p => p.market.slug === market.slug)
      const ms = this.mstate(market.slug)
      ms.pendingClaims = mine.length
      ms.pendingTailShortfall = mine.reduce((a, p) => a + p.tailShortfall, 0n)
    }

    // ── 3. shared-InsuranceFund alert: SUM of concurrent tail shortfalls ───
    await this.checkInsuranceFund(pending, ts)

    // ── 4. claims — sequential (one wallet, one nonce stream) ──────────────
    for (const p of pending) {
      p.claimed = await this.tryClaim(p, ts)
    }

    // End-of-cycle float check against the LARGEST single still-pending claim.
    const stillPending = pending.filter(p => !p.claimed)
    const largest = stillPending.reduce((m, p) => (p.costBound > m ? p.costBound : m), 0n)
    const floatShort = this.state.usdcBalance !== null
      ? floatShortfall(this.state.usdcBalance, stillPending.map(p => p.costBound))
      : 0n
    if (floatShort > 0n) {
      console.error(
        `[liquidator-bot] ${ts} — ALERT USDC float short: largest single pending claim needs ${largest} ` +
        `(max across ${new Set(stillPending.map(p => p.market.slug)).size} market(s), not the sum), ` +
        `bot has ${this.state.usdcBalance}`,
      )
    }
    this.alerts.largestPendingClaim = largest.toString()
    this.alerts.floatShortfall = floatShort.toString()

    // ── 5. sell whatever YES the bot ends up holding, per market ───────────
    let totalYes: bigint | null = null
    for (const { market, currentMark } of live) {
      const y = await this.maybeSell(market, currentMark, ts)
      if (y !== null) totalYes = (totalYes ?? 0n) + y
    }
    if (totalYes !== null) this.state.yesBalance = totalYes

    this.state.lastCycleAt = ts
    for (const { market } of live) this.mstate(market.slug).lastCycleAt = ts
  }

  // ─── discovery of one holder ──────────────────────────────────────────────

  private async discover(market: BotMarket, holder: Address, currentMark: bigint, ts: string): Promise<PendingClaim | null> {
    let isClaimable: boolean
    try {
      isClaimable = await this.publicClient.readContract({
        address:      market.creditMarketAddress,
        abi:          CREDIT_MARKET_ABI,
        functionName: 'claimable',
        args:         [holder],
      }) as boolean
    } catch (err) {
      console.error(`[liquidator-bot] ${ts} — ${market.slug}: claimable() read failed for ${holder}:`, err)
      this.setError(market.slug, this.errMsg(err))
      this.bumpSkip('other', market.slug)
      return null
    }
    if (!isClaimable) return null

    let Q: bigint
    try {
      Q = await this.publicClient.readContract({
        address:      market.yesTokenAddress,
        abi:          ERC20_ABI,
        functionName: 'balanceOf',
        args:         [holder],
      }) as bigint
    } catch (err) {
      console.error(`[liquidator-bot] ${ts} — ${market.slug}: YES balanceOf(${holder}) read failed:`, err)
      this.setError(market.slug, this.errMsg(err))
      this.bumpSkip('other', market.slug)
      return null
    }
    if (Q === 0n) {
      this.bumpSkip('zeroBalance', market.slug)
      return null
    }

    // Upper-bound cost: P ≤ tokenValue = Q × m / 1e18 always (normal case
    // P = owed ≤ tokenValue by the 3% buffer; tail case P = tokenValue
    // exactly) — see root CLAUDE.md "Liquidation math".
    const costBound = (Q * currentMark) / WAD

    // Best-effort tail-shortfall estimate (owed − m×Q) for the shared-InsuranceFund
    // alert. A failed read (e.g. a contract without owed()) just means "unknown" —
    // it never blocks or counts against the claim.
    let tailShortfall = 0n
    try {
      const owed = await this.publicClient.readContract({
        address:      market.creditMarketAddress,
        abi:          CREDIT_MARKET_ABI,
        functionName: 'owed',
        args:         [holder],
      }) as bigint
      if (typeof owed === 'bigint' && owed > costBound) tailShortfall = owed - costBound
    } catch {
      tailShortfall = 0n
    }

    return { market, holder, Q, currentMark, costBound, tailShortfall, claimed: false }
  }

  private async checkInsuranceFund(pending: PendingClaim[], ts: string): Promise<void> {
    const shortfalls = pending.map(p => p.tailShortfall).filter(s => s > 0n)
    const total = shortfalls.reduce((a, b) => a + b, 0n)
    this.alerts.pendingTailShortfall = total.toString()
    this.alerts.insuranceFundShortfall = '0'
    if (total === 0n) return

    let fundBalance: bigint
    try {
      fundBalance = await this.publicClient.readContract({
        address:      this.config.usdcAddress,
        abi:          ERC20_ABI,
        functionName: 'balanceOf',
        args:         [this.config.insuranceFundAddress],
      }) as bigint
    } catch (err) {
      console.error(`[liquidator-bot] ${ts} — InsuranceFund balance read failed (tail-shortfall check skipped):`, err)
      return
    }
    const short = insuranceFundShortfall(fundBalance, shortfalls)
    this.alerts.insuranceFundShortfall = short.toString()
    const slugs = [...new Set(pending.filter(p => p.tailShortfall > 0n).map(p => p.market.slug))]
    if (short > 0n) {
      console.error(
        `[liquidator-bot] ${ts} — ALERT shared InsuranceFund short: concurrent tail-case shortfalls total ${total} ` +
        `across ${slugs.join(', ')} but the fund holds ${fundBalance} (short by ${short})`,
      )
    } else {
      console.error(
        `[liquidator-bot] ${ts} — ALERT tail-case claims pending in ${slugs.join(', ')}: InsuranceFund will top up ` +
        `${total} total (fund holds ${fundBalance})`,
      )
    }
  }

  // ─── claim one holder ─────────────────────────────────────────────────────

  /** Returns true iff a claim() tx for this holder succeeded. */
  private async tryClaim(p: PendingClaim, ts: string): Promise<boolean> {
    const { market, holder, Q, costBound } = p
    const slug = market.slug
    const account = this.requireAccount()

    let usdcBalance: bigint
    try {
      usdcBalance = await this.publicClient.readContract({
        address:      this.config.usdcAddress,
        abi:          ERC20_ABI,
        functionName: 'balanceOf',
        args:         [account],
      }) as bigint
    } catch (err) {
      console.error(`[liquidator-bot] ${ts} — USDC balanceOf(bot) read failed:`, err)
      this.setError(slug, this.errMsg(err))
      this.bumpSkip('other', slug)
      return false
    }
    this.state.usdcBalance = usdcBalance

    if (usdcBalance < costBound) {
      console.error(
        `[liquidator-bot] ${ts} — ALERT insufficient USDC float: market=${slug} holder=${holder} Q=${Q} ` +
        `costBound=${costBound} usdcBalance=${usdcBalance} — skipping claim`,
      )
      this.bumpSkip('insufficientFloat', slug)
      return false
    }

    // Ensure USDC allowance to THIS market's LiquidationEngine covers the claim;
    // approve max once per engine (subsequent claims then never need to re-approve).
    try {
      const allowance = await this.publicClient.readContract({
        address:      this.config.usdcAddress,
        abi:          ERC20_ABI,
        functionName: 'allowance',
        args:         [account, market.liquidationEngineAddress],
      }) as bigint
      if (allowance < costBound) {
        await this.approve(this.config.usdcAddress, market.liquidationEngineAddress, maxUint256, ts)
      }
    } catch (err) {
      console.error(`[liquidator-bot] ${ts} — USDC allowance check/approve failed for ${holder} (${slug}):`, err)
      this.setError(slug, this.errMsg(err))
      this.bumpSkip('other', slug)
      return false
    }

    // ── simulate first ────────────────────────────────────────────────────
    let gasEstimate: bigint
    try {
      gasEstimate = await this.publicClient.estimateContractGas({
        address:      market.liquidationEngineAddress,
        abi:          LIQUIDATION_ENGINE_ABI,
        functionName: 'claim',
        args:         [holder],
        account,
      })
    } catch (err) {
      this.handleClaimSimRevert(err, holder, slug, ts)
      return false
    }

    // Snapshot the InsuranceFund's USDC balance right before sending — used
    // only to report the tail-case top-up amount after the fact (never to
    // decide whether this claim IS a tail case; that's read off the
    // Liquidated event itself).
    let preInsuranceBal: bigint | undefined
    try {
      preInsuranceBal = await this.publicClient.readContract({
        address:      this.config.usdcAddress,
        abi:          ERC20_ABI,
        functionName: 'balanceOf',
        args:         [this.config.insuranceFundAddress],
      }) as bigint
    } catch {
      preInsuranceBal = undefined
    }

    const gas = (gasEstimate * 120n) / 100n // +20% buffer

    let txHash: Hash
    try {
      txHash = await this.walletClient.writeContract({
        address:      market.liquidationEngineAddress,
        abi:          LIQUIDATION_ENGINE_ABI,
        functionName: 'claim',
        args:         [holder],
        gas,
      })
    } catch (err) {
      console.error(`[liquidator-bot] ${ts} — claim tx submission failed for ${holder} (${slug}):`, err)
      this.setError(slug, this.errMsg(err))
      this.bumpSkip('other', slug)
      return false
    }

    console.log(`[liquidator-bot] ${ts} — submitted claim(${holder}) on ${slug}: ${txHash}`)

    let receipt: { status: 'success' | 'reverted'; logs: readonly LogLike[] }
    try {
      receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash })
    } catch (err) {
      // Broadcast succeeded but the outcome is genuinely unknown — do NOT bump
      // counters (mirrors the other keepers' receipt-wait-failed handling).
      console.error(`[liquidator-bot] ${ts} — receipt wait failed for ${txHash}:`, err)
      this.setError(slug, this.errMsg(err))
      return false
    }

    if (receipt.status !== 'success') {
      console.error(`[liquidator-bot] ${ts} — claim(${holder}) on ${slug} REVERTED on-chain: ${txHash}`)
      this.bumpSkip('other', slug)
      return false
    }

    const ms = this.mstate(slug)
    const parsed = parseLiquidatedEvent(receipt.logs, market.liquidationEngineAddress)
    if (!parsed) {
      console.error(
        `[liquidator-bot] ${ts} — claim(${holder}) on ${slug} succeeded (tx=${txHash}) but no Liquidated ` +
        `event could be parsed from the receipt`,
      )
      this.state.claims++
      ms.claims++
      return true
    }

    this.state.claims++
    ms.claims++
    if (parsed.tailCase) { this.state.tailClaims++; ms.tailClaims++ }

    console.log(
      `[liquidator-bot] ${ts} — claimed ${holder} on ${slug} Q=${parsed.yesAmount} P=${parsed.pricePaid} ` +
      `tail=${parsed.tailCase}`,
    )

    if (parsed.tailCase) {
      let shortfallDesc = 'unknown (InsuranceFund balance unreadable before/after the claim)'
      if (preInsuranceBal !== undefined) {
        try {
          const postInsuranceBal = await this.publicClient.readContract({
            address:      this.config.usdcAddress,
            abi:          ERC20_ABI,
            functionName: 'balanceOf',
            args:         [this.config.insuranceFundAddress],
          }) as bigint
          shortfallDesc = (preInsuranceBal - postInsuranceBal).toString()
        } catch {
          // leave shortfallDesc as 'unknown' — don't guess.
        }
      }
      console.error(
        `[liquidator-bot] ${ts} — ALERT tail case — InsuranceFund covered ${shortfallDesc} ` +
        `USDC to make NO whole (market=${slug} holder=${holder})`,
      )
    }
    return true
  }

  private handleClaimSimRevert(err: unknown, holder: Address, slug: string, ts: string): void {
    const decoded = decodeClaimRevert(err)
    switch (decoded.kind) {
      case 'MotionPending':
        console.log(`[liquidator-bot] ${ts} — motion pending (surfaced at simulate) for ${holder} (${slug}) — skipping`)
        this.bumpSkip('motionPending', slug)
        break
      case 'NotClaimable':
        // Normal — someone else claimed first between our claimable() read
        // and simulate. Permissionless, first-come claiming (invariant 6):
        // this is expected competition, not an error.
        console.log(`[liquidator-bot] ${ts} — ${holder} no longer claimable on ${slug} (claimed by someone else) — skipping`)
        this.bumpSkip('notClaimable', slug)
        break
      case 'PositionFrozen':
        console.error(
          `[liquidator-bot] ${ts} — ALERT PositionFrozen simulating claim(${holder}) on ${slug} — the bot's own ` +
          `wallet appears to be a flagged/claimable position; cure it before further claims can proceed`,
        )
        this.setError(slug, `bot position frozen (claim(${holder}) simulate)`)
        this.bumpSkip('botFrozen', slug)
        break
      case 'ERC20InsufficientBalance':
        console.error(
          `[liquidator-bot] ${ts} — ALERT InsuranceFund cannot cover the tail-case shortfall for ` +
          `${holder} (${slug}): sender=${decoded.sender} balance=${decoded.balance} needed=${decoded.needed} — ` +
          `position stays stuck until the fund is topped up`,
        )
        this.setError(slug, `InsuranceFund insufficient balance (claim(${holder}))`)
        this.bumpSkip('insuranceFundShortfall', slug)
        break
      case 'ERC20InsufficientAllowance':
        console.error(
          `[liquidator-bot] ${ts} — ALERT ERC20InsufficientAllowance simulating claim(${holder}) on ${slug}: ` +
          `spender=${decoded.spender} allowance=${decoded.allowance} needed=${decoded.needed} — ` +
          `likely the InsuranceFund → CreditMarket leg is misconfigured`,
        )
        this.setError(slug, `InsuranceFund insufficient allowance (claim(${holder}))`)
        this.bumpSkip('insuranceFundShortfall', slug)
        break
      default:
        console.error(`[liquidator-bot] ${ts} — claim(${holder}) on ${slug} simulate failed (undecoded):`, err)
        this.setError(slug, this.errMsg(err))
        this.bumpSkip('other', slug)
    }
  }

  // ─── approvals ────────────────────────────────────────────────────────────

  private async approve(tokenAddress: Address, spender: Address, amount: bigint, ts: string): Promise<void> {
    const account = this.requireAccount()
    const gasEstimate = await this.publicClient.estimateContractGas({
      address:      tokenAddress,
      abi:          ERC20_ABI,
      functionName: 'approve',
      args:         [spender, amount],
      account,
    })
    const gas = (gasEstimate * 120n) / 100n
    const txHash = await this.walletClient.writeContract({
      address:      tokenAddress,
      abi:          ERC20_ABI,
      functionName: 'approve',
      args:         [spender, amount],
      gas,
    })
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash })
    if (receipt.status !== 'success') {
      throw new Error(`approve(${tokenAddress} → ${spender}) tx reverted: ${txHash}`)
    }
    console.log(`[liquidator-bot] ${ts} — approved ${tokenAddress} → ${spender} (tx=${txHash})`)
  }

  // ─── sell whatever YES the bot ends the claim loop holding (per market) ────

  /** Returns the bot's YES balance in this market (null if unknown / selling off). */
  private async maybeSell(market: BotMarket, currentMark: bigint, ts: string): Promise<bigint | null> {
    if (this.config.autoSell === false) return null

    const account = this.walletClient.account?.address
    if (!account) return null
    const slug = market.slug

    let yesBalance: bigint
    try {
      yesBalance = await this.publicClient.readContract({
        address:      market.yesTokenAddress,
        abi:          ERC20_ABI,
        functionName: 'balanceOf',
        args:         [account],
      }) as bigint
    } catch (err) {
      console.error(`[liquidator-bot] ${ts} — YES balanceOf(bot) read failed before sell step (${slug}):`, err)
      this.setError(slug, this.errMsg(err))
      return null
    }
    this.mstate(slug).yesBalance = yesBalance

    if (yesBalance === 0n) return yesBalance

    try {
      const allowance = await this.publicClient.readContract({
        address:      market.yesTokenAddress,
        abi:          ERC20_ABI,
        functionName: 'allowance',
        args:         [account, market.clobSettlementAddress],
      }) as bigint
      if (allowance < yesBalance) {
        await this.approve(market.yesTokenAddress, market.clobSettlementAddress, maxUint256, ts)
      }
    } catch (err) {
      console.error(`[liquidator-bot] ${ts} — YES allowance check/approve to CLOBSettlement failed (${slug}):`, err)
      this.setError(slug, this.errMsg(err))
      return yesBalance
    }

    let result: SellResult
    try {
      // `mark` here is THIS market's currentMark, so SELL_MAX_DISCOUNT_BPS is per market.
      result = await market.seller.sell({ yesAmount: yesBalance, markWad: currentMark })
    } catch (err) {
      // IYesSeller.sell() is documented "Never throws" — defensive only.
      console.error(`[liquidator-bot] ${ts} — seller.sell() threw unexpectedly (${slug}):`, err)
      this.setError(slug, this.errMsg(err))
      return yesBalance
    }
    console.log(
      `[liquidator-bot] ${ts} — ${slug} sell result: action=${result.action}` +
      (result.orderId  !== undefined ? ` orderId=${result.orderId}` : '') +
      (result.priceWad !== undefined ? ` priceWad=${result.priceWad}` : '') +
      (result.amount   !== undefined ? ` amount=${result.amount}` : '') +
      (result.reason   !== undefined ? ` reason=${result.reason}` : ''),
    )
    return yesBalance
  }

  // ─── health ────────────────────────────────────────────────────────────────

  private aggregateHolderIndex(): HolderIndexStatus {
    const by: Record<string, HolderIndexStatus> = {}
    for (const m of this.provider.markets()) by[m.slug] = m.holderSource.status()
    const prefix = this.provider.registryStatus?.().mode === 'registry'
    // Legacy single-market form: exactly the one market's status, as before.
    return aggregateHolderStatus(by, { prefixErrors: prefix })
  }

  getHealth(): BotHealth {
    const base: BotHealth = {
      status:          'ok',
      lastCycleAt:     this.state.lastCycleAt,
      claims:          this.state.claims,
      tailClaims:      this.state.tailClaims,
      skippedByReason: { ...this.state.skippedByReason },
      lastError:       this.state.lastError,
      usdcBalance:     this.state.usdcBalance?.toString() ?? null,
      yesBalance:      this.state.yesBalance?.toString() ?? null,
      holderIndex:     this.aggregateHolderIndex(),
    }
    // Multi-market additions — only when a registry-aware provider is wired.
    if (this.provider.registryStatus) {
      base.registry = this.provider.registryStatus()
      base.alerts = { ...this.alerts }
      const markets: Record<string, BotMarketHealth> = {}
      for (const m of this.provider.markets()) {
        const ms = this.mstate(m.slug)
        markets[m.slug] = {
          lastCycleAt:          ms.lastCycleAt,
          claims:               ms.claims,
          tailClaims:           ms.tailClaims,
          skippedByReason:      { ...ms.skippedByReason },
          lastError:            ms.lastError,
          yesBalance:           ms.yesBalance?.toString() ?? null,
          motionPending:        ms.motionPending,
          pendingClaims:        ms.pendingClaims,
          pendingTailShortfall: ms.pendingTailShortfall.toString(),
          holderIndex:          m.holderSource.status(),
        }
      }
      base.markets = markets
    }
    return base
  }
}

// ─── HTTP server (internal-only service — no CORS handling needed) ────────────

export function startHealthServer(bot: LiquidatorBot, port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(bot.getHealth()))
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  server.listen(port, () => {
    console.log(`[liquidator-bot] HTTP on http://0.0.0.0:${port}`)
  })
  return server
}

// ─── Contract address resolution (env vars win; deployments file is a local-dev
// fallback that does not exist inside containers, e.g. Railway) ───────────────

export interface ResolvedAddresses {
  creditMarketAddress: string
  yesTokenAddress: string
  usdcAddress: string
  liquidationEngineAddress: string
  insuranceFundAddress: string
  clobSettlementAddress: string
}

export function resolveAddresses(
  env: NodeJS.ProcessEnv = process.env,
  deploymentsPath: string = path.join(
    __dirname, '..', '..', 'contracts', 'deployments', 'base-sepolia.json',
  ),
): ResolvedAddresses {
  const envKeys: Record<keyof ResolvedAddresses, string> = {
    creditMarketAddress:      'CREDIT_MARKET_ADDRESS',
    yesTokenAddress:          'YES_TOKEN_ADDRESS',
    usdcAddress:              'USDC_ADDRESS',
    liquidationEngineAddress: 'LIQUIDATION_ENGINE_ADDRESS',
    insuranceFundAddress:     'INSURANCE_FUND_ADDRESS',
    clobSettlementAddress:    'CLOB_SETTLEMENT_ADDRESS',
  }
  // Deployments file field names (contracts/deployments/base-sepolia.json).
  const fileKeys: Record<keyof ResolvedAddresses, string> = {
    creditMarketAddress:      'creditMarket',
    yesTokenAddress:          'yesToken',
    usdcAddress:              'usdc',
    liquidationEngineAddress: 'liquidationEngine',
    insuranceFundAddress:     'insuranceFund',
    clobSettlementAddress:    'clobSettlement',
  }

  const resolved: Partial<Record<keyof ResolvedAddresses, string>> = {}
  for (const key of Object.keys(envKeys) as (keyof ResolvedAddresses)[]) {
    const v = env[envKeys[key]]
    if (v) resolved[key] = v
  }

  const missingAfterEnv = (Object.keys(envKeys) as (keyof ResolvedAddresses)[]).filter(k => !resolved[k])
  if (missingAfterEnv.length > 0) {
    let deployments: Record<string, string>
    try {
      deployments = JSON.parse(fs.readFileSync(deploymentsPath, 'utf8'))
    } catch (err) {
      const missingEnvNames = missingAfterEnv.map(k => envKeys[k]).join(', ')
      throw new Error(
        `${missingEnvNames} not set and ${deploymentsPath} could not be read: ${err}. ` +
        `Set ${missingEnvNames} (hosted images do not include the deployments file).`,
      )
    }
    for (const key of missingAfterEnv) {
      const fileVal = deployments[fileKeys[key]]
      if (fileVal) resolved[key] = fileVal
    }
  }

  const stillMissing = (Object.keys(envKeys) as (keyof ResolvedAddresses)[]).filter(k => !resolved[k])
  if (stillMissing.length > 0) {
    const names = stillMissing.map(k => `${envKeys[k]} (or "${fileKeys[k]}" in ${deploymentsPath})`).join(', ')
    throw new Error(`Missing required address(es): ${names}`)
  }

  return resolved as ResolvedAddresses
}

// Accepts a hex private key with or without the 0x prefix (wallet exports often
// omit it) and tolerates surrounding whitespace/quotes; throws a clear error
// naming the env var — never echoing the value — if it isn't 32 bytes of hex.
export function parsePrivateKey(raw: string, envName: string): `0x${string}` {
  const body = raw.trim().replace(/^['"]|['"]$/g, '').replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]{64}$/.test(body)) {
    throw new Error(`${envName} must be a 32-byte hex private key (64 hex chars, 0x optional)`)
  }
  return `0x${body}`
}

// ─── Production entry point ───────────────────────────────────────────────────

/** Production provider: every market in the directory, with lazily-built holder index + seller. */
export class DirectoryBotMarkets implements BotMarketsProvider {
  private readonly cache = new Map<string, BotMarket>()

  constructor(
    private readonly directory: Pick<MarketDirectory, 'list' | 'status'>,
    private readonly makeMarket: (m: MarketInfo) => BotMarket,
  ) {}

  markets(): BotMarket[] {
    return this.directory.list().map(m => {
      let bm = this.cache.get(m.slug)
      if (!bm) {
        bm = this.makeMarket(m)
        this.cache.set(m.slug, bm)
      }
      return bm
    })
  }

  registryStatus(): MarketDirectoryStatus {
    return this.directory.status()
  }
}

async function main(): Promise<void> {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL
  if (!rpcUrl) throw new Error('BASE_SEPOLIA_RPC_URL env var is required')

  const privateKey = process.env.LIQUIDATOR_PRIVATE_KEY
  if (!privateKey) throw new Error('LIQUIDATOR_PRIVATE_KEY env var is required')

  const registryMode = !!process.env.MARKET_REGISTRY_ADDRESS?.trim()
  // Legacy mode keeps today's requirement: every address resolves (env, or the
  // local deployments file). Registry mode only needs USDC + InsuranceFund, which
  // fall back to the registry's own usdc()/insuranceFund().
  const legacyAddrs = registryMode ? null : resolveAddresses()

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

  const account = privateKeyToAccount(parsePrivateKey(privateKey, 'LIQUIDATOR_PRIVATE_KEY'))

  const publicClient = createPublicClient({ chain, transport })
  const walletClient = createWalletClient({ account, chain, transport })

  const directory = buildDirectory({
    client: publicClient as unknown as IRegistryClient,
    legacy: legacyAddrs ? {
      id: 0, slug: 'mstr', entityName: 'MicroStrategy', entityType: 'corporate',
      creditMarket:      legacyAddrs.creditMarketAddress as Address,
      yesToken:          legacyAddrs.yesTokenAddress as Address,
      noToken:           '0x0000000000000000000000000000000000000000',
      clobSettlement:    legacyAddrs.clobSettlementAddress as Address,
      oracleRouter:      '0x0000000000000000000000000000000000000000',
      liquidationEngine: legacyAddrs.liquidationEngineAddress as Address,
      active: true, registeredAt: 0n,
      startBlock: /^\d+$/.test(process.env.HOLDER_INDEX_FROM_BLOCK?.trim() ?? '') ? BigInt(process.env.HOLDER_INDEX_FROM_BLOCK!.trim()) : 0n,
    } : undefined,
  })
  await directory.start()

  // Shared addresses: env wins (legacy: resolveAddresses), registry mode falls back to the registry.
  let usdcAddress: Address
  let insuranceFundAddress: Address
  if (legacyAddrs) {
    usdcAddress = legacyAddrs.usdcAddress as Address
    insuranceFundAddress = legacyAddrs.insuranceFundAddress as Address
  } else {
    const shared = await readRegistryShared(
      publicClient as unknown as Parameters<typeof readRegistryShared>[0],
      process.env.MARKET_REGISTRY_ADDRESS!.trim() as Address,
    )
    usdcAddress = (process.env.USDC_ADDRESS || shared.usdc) as Address
    insuranceFundAddress = (process.env.INSURANCE_FUND_ADDRESS || shared.insuranceFund) as Address
  }

  const indexes = new HolderIndexManager(market =>
    createMarketHolderIndex(publicClient as unknown as ILogClient, market, chainId, directory.mode),
  )

  const autoSell = (process.env.AUTO_SELL ?? 'true').trim().toLowerCase() !== 'false'
  const orderBookUrl = process.env.ORDER_BOOK_URL ?? 'http://localhost:3001'

  const provider = new DirectoryBotMarkets(directory, (m): BotMarket => ({
    slug:                     m.slug,
    creditMarketAddress:      m.creditMarket as Address,
    yesTokenAddress:          m.yesToken as Address,
    liquidationEngineAddress: m.liquidationEngine as Address,
    clobSettlementAddress:    m.clobSettlement as Address,
    holderSource:             indexes.get(m),
    seller: new ClobYesSeller({
      orderBookUrl,
      chainId,
      clobSettlementAddress:  m.clobSettlement as Address,
      yesTokenAddress:        m.yesToken as Address,
      usdcAddress,
      account,
      // Registry mode: ask for THIS market's book. Legacy mode sends no ?market=
      // (an old order-book-server wouldn't know it; "no param" means mstr anyway).
      marketSlug:     directory.mode === 'registry' ? m.slug : undefined,
      maxDiscountBps: process.env.SELL_MAX_DISCOUNT_BPS ? parseInt(process.env.SELL_MAX_DISCOUNT_BPS) : undefined,
      orderTtlSec:    process.env.SELL_ORDER_TTL_SEC ? parseInt(process.env.SELL_ORDER_TTL_SEC) : undefined,
    }),
  }))

  const bot = new LiquidatorBot(
    publicClient as unknown as IPublicClient,
    walletClient as unknown as IWalletClient,
    provider,
    {
      usdcAddress,
      insuranceFundAddress,
      pollIntervalMs: parseInt(process.env.POLL_INTERVAL_MS ?? '30000'),
      autoSell,
    },
  )

  bot.start()
  const server = startHealthServer(bot, parseInt(process.env.HEALTH_PORT ?? '3004'))

  console.log(`[liquidator-bot] started (${directory.mode} mode, ${directory.list().length} market(s))`)

  // Graceful shutdown: every Railway redeploy sends SIGTERM to this process
  // (it's PID 1 under the exec-form CMD `node -r ts-node/register`). Order:
  // stop scheduling and let an in-flight cycle finish (bot.stop() — this may
  // include waiting for a submitted claim()/approve() tx receipt), THEN close
  // the health server, stop the registry refresh and release the holder
  // indexes' Redis connections.
  installShutdownHandlers('liquidator-bot', [
    { name: 'liquidator-bot', run: () => bot.stop() },
    { name: 'http-server', run: () => closeHttpServer(server) },
    { name: 'registry', run: async () => directory.stop() },
    { name: 'holder-index', run: () => indexes.close() },
  ])
}

if (require.main === module) {
  main().catch(err => {
    console.error('[liquidator-bot] fatal:', err)
    process.exit(1)
  })
}
