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
// Deliberately does NOT call CreditMarket.owed() or frozenFunding() — only
// LiquidationEngine.claim(user) and the handful of common views below — so
// this bot works unchanged against both the currently-deployed contracts and
// the upcoming fix/unified-owed redeploy (that branch changes pricing
// internals, not claim()'s ABI).

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
import { createHolderIndex } from './holder-index'
import type { ILogClient, HolderIndexStatus } from './holder-index'
import { installShutdownHandlers, closeHttpServer } from './shutdown'
import type { IYesSeller, SellResult } from './seller'

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

export interface BotConfig {
  creditMarketAddress: Address
  yesTokenAddress: Address
  usdcAddress: Address
  liquidationEngineAddress: Address
  insuranceFundAddress: Address
  clobSettlementAddress: Address
  pollIntervalMs?: number // default 30_000
  autoSell?: boolean      // default true
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

export interface BotHealth {
  status: 'ok'
  lastCycleAt: string | null
  claims: number
  tailClaims: number
  skippedByReason: Record<string, number>
  lastError: string | null
  usdcBalance: string | null
  yesBalance: string | null
  holderIndex: HolderIndexStatus
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

  private intervalHandle: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private inFlightCycle: Promise<void> | null = null

  constructor(
    private readonly publicClient: IPublicClient,
    private readonly walletClient: IWalletClient,
    private readonly holderSource: IHolderSource,
    private readonly seller: IYesSeller,
    private readonly config: BotConfig,
  ) {}

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

  private bumpSkip(reason: SkipReason): void {
    this.state.skippedByReason[reason] = (this.state.skippedByReason[reason] ?? 0) + 1
  }

  async runCycle(): Promise<void> {
    const ts = new Date().toISOString()

    try {
      await this.holderSource.refresh()
    } catch (err) {
      console.error(`[liquidator-bot] ${ts} — holder source refresh failed (continuing with known holders):`, err)
    }
    const holders = this.holderSource.holders()

    let motionPending: boolean
    let currentMark: bigint
    try {
      ;[motionPending, currentMark] = await Promise.all([
        this.publicClient.readContract({
          address:      this.config.creditMarketAddress,
          abi:          CREDIT_MARKET_ABI,
          functionName: 'motionPending',
        }) as Promise<boolean>,
        this.publicClient.readContract({
          address:      this.config.creditMarketAddress,
          abi:          CREDIT_MARKET_ABI,
          functionName: 'currentMark',
        }) as Promise<bigint>,
      ])
    } catch (err) {
      console.error(`[liquidator-bot] ${ts} — failed to read market state:`, err)
      this.state.lastError = err instanceof Error ? err.message : String(err)
      this.state.lastCycleAt = ts
      return
    }

    if (motionPending) {
      console.log(`[liquidator-bot] ${ts} — motion pending — skipping all claims this cycle`)
      this.bumpSkip('motionPending')
    } else {
      // Claims are sequential — one wallet, one nonce, in holder-list order.
      for (const holder of holders) {
        await this.tryClaim(holder, currentMark, ts)
      }
    }

    await this.maybeSell(currentMark, ts)

    this.state.lastCycleAt = ts
  }

  // ─── claim one holder ─────────────────────────────────────────────────────

  private async tryClaim(holder: Address, currentMark: bigint, ts: string): Promise<void> {
    let isClaimable: boolean
    try {
      isClaimable = await this.publicClient.readContract({
        address:      this.config.creditMarketAddress,
        abi:          CREDIT_MARKET_ABI,
        functionName: 'claimable',
        args:         [holder],
      }) as boolean
    } catch (err) {
      console.error(`[liquidator-bot] ${ts} — claimable() read failed for ${holder}:`, err)
      this.state.lastError = err instanceof Error ? err.message : String(err)
      this.bumpSkip('other')
      return
    }
    if (!isClaimable) return

    let Q: bigint
    try {
      Q = await this.publicClient.readContract({
        address:      this.config.yesTokenAddress,
        abi:          ERC20_ABI,
        functionName: 'balanceOf',
        args:         [holder],
      }) as bigint
    } catch (err) {
      console.error(`[liquidator-bot] ${ts} — YES balanceOf(${holder}) read failed:`, err)
      this.state.lastError = err instanceof Error ? err.message : String(err)
      this.bumpSkip('other')
      return
    }
    if (Q === 0n) {
      this.bumpSkip('zeroBalance')
      return
    }

    // Upper-bound cost: P ≤ tokenValue = Q × m / 1e18 always (normal case
    // P = fFrozenTotal ≤ tokenValue by the 3% buffer; tail case P = tokenValue
    // exactly) — see root CLAUDE.md "Liquidation math".
    const costBound = (Q * currentMark) / WAD

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
      this.state.lastError = err instanceof Error ? err.message : String(err)
      this.bumpSkip('other')
      return
    }
    this.state.usdcBalance = usdcBalance

    if (usdcBalance < costBound) {
      console.error(
        `[liquidator-bot] ${ts} — ALERT insufficient USDC float: holder=${holder} Q=${Q} ` +
        `costBound=${costBound} usdcBalance=${usdcBalance} — skipping claim`,
      )
      this.bumpSkip('insufficientFloat')
      return
    }

    // Ensure USDC allowance to LiquidationEngine covers this claim; approve
    // max once (subsequent claims then never need to re-approve).
    try {
      const allowance = await this.publicClient.readContract({
        address:      this.config.usdcAddress,
        abi:          ERC20_ABI,
        functionName: 'allowance',
        args:         [account, this.config.liquidationEngineAddress],
      }) as bigint
      if (allowance < costBound) {
        await this.approve(this.config.usdcAddress, this.config.liquidationEngineAddress, maxUint256, ts)
      }
    } catch (err) {
      console.error(`[liquidator-bot] ${ts} — USDC allowance check/approve failed for ${holder}:`, err)
      this.state.lastError = err instanceof Error ? err.message : String(err)
      this.bumpSkip('other')
      return
    }

    // ── simulate first ────────────────────────────────────────────────────
    let gasEstimate: bigint
    try {
      gasEstimate = await this.publicClient.estimateContractGas({
        address:      this.config.liquidationEngineAddress,
        abi:          LIQUIDATION_ENGINE_ABI,
        functionName: 'claim',
        args:         [holder],
        account,
      })
    } catch (err) {
      this.handleClaimSimRevert(err, holder, ts)
      return
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
        address:      this.config.liquidationEngineAddress,
        abi:          LIQUIDATION_ENGINE_ABI,
        functionName: 'claim',
        args:         [holder],
        gas,
      })
    } catch (err) {
      console.error(`[liquidator-bot] ${ts} — claim tx submission failed for ${holder}:`, err)
      this.state.lastError = err instanceof Error ? err.message : String(err)
      this.bumpSkip('other')
      return
    }

    console.log(`[liquidator-bot] ${ts} — submitted claim(${holder}) ${txHash}`)

    let receipt: { status: 'success' | 'reverted'; logs: readonly LogLike[] }
    try {
      receipt = await this.publicClient.waitForTransactionReceipt({ hash: txHash })
    } catch (err) {
      // Broadcast succeeded but the outcome is genuinely unknown — do NOT bump
      // counters (mirrors the other keepers' receipt-wait-failed handling).
      console.error(`[liquidator-bot] ${ts} — receipt wait failed for ${txHash}:`, err)
      this.state.lastError = err instanceof Error ? err.message : String(err)
      return
    }

    if (receipt.status !== 'success') {
      console.error(`[liquidator-bot] ${ts} — claim(${holder}) REVERTED on-chain: ${txHash}`)
      this.bumpSkip('other')
      return
    }

    const parsed = parseLiquidatedEvent(receipt.logs, this.config.liquidationEngineAddress)
    if (!parsed) {
      console.error(
        `[liquidator-bot] ${ts} — claim(${holder}) succeeded (tx=${txHash}) but no Liquidated ` +
        `event could be parsed from the receipt`,
      )
      this.state.claims++
      return
    }

    this.state.claims++
    if (parsed.tailCase) this.state.tailClaims++

    console.log(
      `[liquidator-bot] ${ts} — claimed ${holder} Q=${parsed.yesAmount} P=${parsed.pricePaid} ` +
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
        `USDC to make NO whole (holder=${holder})`,
      )
    }
  }

  private handleClaimSimRevert(err: unknown, holder: Address, ts: string): void {
    const decoded = decodeClaimRevert(err)
    switch (decoded.kind) {
      case 'MotionPending':
        console.log(`[liquidator-bot] ${ts} — motion pending (surfaced at simulate) for ${holder} — skipping`)
        this.bumpSkip('motionPending')
        break
      case 'NotClaimable':
        // Normal — someone else claimed first between our claimable() read
        // and simulate. Permissionless, first-come claiming (invariant 6):
        // this is expected competition, not an error.
        console.log(`[liquidator-bot] ${ts} — ${holder} no longer claimable (claimed by someone else) — skipping`)
        this.bumpSkip('notClaimable')
        break
      case 'PositionFrozen':
        console.error(
          `[liquidator-bot] ${ts} — ALERT PositionFrozen simulating claim(${holder}) — the bot's own ` +
          `wallet appears to be a flagged/claimable position; cure it before further claims can proceed`,
        )
        this.state.lastError = `bot position frozen (claim(${holder}) simulate)`
        this.bumpSkip('botFrozen')
        break
      case 'ERC20InsufficientBalance':
        console.error(
          `[liquidator-bot] ${ts} — ALERT InsuranceFund cannot cover the tail-case shortfall for ` +
          `${holder}: sender=${decoded.sender} balance=${decoded.balance} needed=${decoded.needed} — ` +
          `position stays stuck until the fund is topped up`,
        )
        this.state.lastError = `InsuranceFund insufficient balance (claim(${holder}))`
        this.bumpSkip('insuranceFundShortfall')
        break
      case 'ERC20InsufficientAllowance':
        console.error(
          `[liquidator-bot] ${ts} — ALERT ERC20InsufficientAllowance simulating claim(${holder}): ` +
          `spender=${decoded.spender} allowance=${decoded.allowance} needed=${decoded.needed} — ` +
          `likely the InsuranceFund → CreditMarket leg is misconfigured`,
        )
        this.state.lastError = `InsuranceFund insufficient allowance (claim(${holder}))`
        this.bumpSkip('insuranceFundShortfall')
        break
      default:
        console.error(`[liquidator-bot] ${ts} — claim(${holder}) simulate failed (undecoded):`, err)
        this.state.lastError = err instanceof Error ? err.message : String(err)
        this.bumpSkip('other')
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

  // ─── sell whatever YES the bot ends the claim loop holding ────────────────

  private async maybeSell(currentMark: bigint, ts: string): Promise<void> {
    if (this.config.autoSell === false) return

    const account = this.walletClient.account?.address
    if (!account) return

    let yesBalance: bigint
    try {
      yesBalance = await this.publicClient.readContract({
        address:      this.config.yesTokenAddress,
        abi:          ERC20_ABI,
        functionName: 'balanceOf',
        args:         [account],
      }) as bigint
    } catch (err) {
      console.error(`[liquidator-bot] ${ts} — YES balanceOf(bot) read failed before sell step:`, err)
      this.state.lastError = err instanceof Error ? err.message : String(err)
      return
    }
    this.state.yesBalance = yesBalance

    if (yesBalance === 0n) return

    try {
      const allowance = await this.publicClient.readContract({
        address:      this.config.yesTokenAddress,
        abi:          ERC20_ABI,
        functionName: 'allowance',
        args:         [account, this.config.clobSettlementAddress],
      }) as bigint
      if (allowance < yesBalance) {
        await this.approve(this.config.yesTokenAddress, this.config.clobSettlementAddress, maxUint256, ts)
      }
    } catch (err) {
      console.error(`[liquidator-bot] ${ts} — YES allowance check/approve to CLOBSettlement failed:`, err)
      this.state.lastError = err instanceof Error ? err.message : String(err)
      return
    }

    let result: SellResult
    try {
      result = await this.seller.sell({ yesAmount: yesBalance, markWad: currentMark })
    } catch (err) {
      // IYesSeller.sell() is documented "Never throws" — defensive only.
      console.error(`[liquidator-bot] ${ts} — seller.sell() threw unexpectedly:`, err)
      this.state.lastError = err instanceof Error ? err.message : String(err)
      return
    }
    console.log(
      `[liquidator-bot] ${ts} — sell result: action=${result.action}` +
      (result.orderId  !== undefined ? ` orderId=${result.orderId}` : '') +
      (result.priceWad !== undefined ? ` priceWad=${result.priceWad}` : '') +
      (result.amount   !== undefined ? ` amount=${result.amount}` : '') +
      (result.reason   !== undefined ? ` reason=${result.reason}` : ''),
    )
  }

  // ─── health ────────────────────────────────────────────────────────────────

  getHealth(): BotHealth {
    return {
      status:          'ok',
      lastCycleAt:     this.state.lastCycleAt,
      claims:          this.state.claims,
      tailClaims:      this.state.tailClaims,
      skippedByReason: { ...this.state.skippedByReason },
      lastError:       this.state.lastError,
      usdcBalance:     this.state.usdcBalance?.toString() ?? null,
      yesBalance:      this.state.yesBalance?.toString() ?? null,
      holderIndex:     this.holderSource.status(),
    }
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

// ─── Production entry point ───────────────────────────────────────────────────

function main(): void {
  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL
  if (!rpcUrl) throw new Error('BASE_SEPOLIA_RPC_URL env var is required')

  const privateKey = process.env.LIQUIDATOR_PRIVATE_KEY
  if (!privateKey) throw new Error('LIQUIDATOR_PRIVATE_KEY env var is required')

  const addrs = resolveAddresses()

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

  const account = privateKeyToAccount(privateKey as `0x${string}`)

  const publicClient = createPublicClient({ chain, transport })
  const walletClient = createWalletClient({ account, chain, transport })

  const holderSource = createHolderIndex(
    publicClient as unknown as ILogClient,
    addrs.yesTokenAddress as Address,
    chainId,
  )

  const autoSell = (process.env.AUTO_SELL ?? 'true').trim().toLowerCase() !== 'false'

  const seller = new ClobYesSeller({
    orderBookUrl:           process.env.ORDER_BOOK_URL ?? 'http://localhost:3001',
    chainId,
    clobSettlementAddress:  addrs.clobSettlementAddress as Address,
    yesTokenAddress:        addrs.yesTokenAddress as Address,
    usdcAddress:            addrs.usdcAddress as Address,
    account,
    maxDiscountBps: process.env.SELL_MAX_DISCOUNT_BPS ? parseInt(process.env.SELL_MAX_DISCOUNT_BPS) : undefined,
    orderTtlSec:    process.env.SELL_ORDER_TTL_SEC ? parseInt(process.env.SELL_ORDER_TTL_SEC) : undefined,
  })

  const bot = new LiquidatorBot(
    publicClient as unknown as IPublicClient,
    walletClient as unknown as IWalletClient,
    holderSource,
    seller,
    {
      creditMarketAddress:      addrs.creditMarketAddress as Address,
      yesTokenAddress:          addrs.yesTokenAddress as Address,
      usdcAddress:              addrs.usdcAddress as Address,
      liquidationEngineAddress: addrs.liquidationEngineAddress as Address,
      insuranceFundAddress:     addrs.insuranceFundAddress as Address,
      clobSettlementAddress:    addrs.clobSettlementAddress as Address,
      pollIntervalMs:           parseInt(process.env.POLL_INTERVAL_MS ?? '30000'),
      autoSell,
    },
  )

  bot.start()
  const server = startHealthServer(bot, parseInt(process.env.HEALTH_PORT ?? '3004'))

  console.log('[liquidator-bot] started')

  // Graceful shutdown: every Railway redeploy sends SIGTERM to this process
  // (it's PID 1 under the exec-form CMD `node -r ts-node/register`). Order:
  // stop scheduling and let an in-flight cycle finish (bot.stop() — this may
  // include waiting for a submitted claim()/approve() tx receipt), THEN close
  // the health server and release the holder index's Redis connection.
  installShutdownHandlers('liquidator-bot', [
    { name: 'liquidator-bot', run: () => bot.stop() },
    { name: 'http-server', run: () => closeHttpServer(server) },
    { name: 'holder-index', run: () => holderSource.close() },
  ])
}

if (require.main === module) {
  main()
}
