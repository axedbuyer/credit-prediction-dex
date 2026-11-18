'use client'

// Upbet position health (batch 4, docs/design/motion-escrow-and-mark.md §4). Alerts
// are on-site only: a holder sees them only when visiting Pari.
//
//   health = m × Q / (1.03 × (owed + one epoch of carry))     — flaggable at health ≤ 1
//   runway = epochsToExpire (on-chain; epochs are one day)
//
//   Critical  runway ≤ 2 days, or health ≤ 1.15   → modal on connect
//   Warning   runway ≤ 7 days, or health ≤ 1.5    → red banner (market + Portfolio)
//   Watch     runway ≤ 30 days                    → amber badge, "Pay carry" prompt
//   OK        otherwise

import { useReadContract, useReadContracts } from 'wagmi'
import { CREDIT_MARKET_ABI, ERC20_ABI } from '@/lib/creditMarketAbi'

export type HealthLevel = 'ok' | 'watch' | 'warning' | 'critical'

const YEAR = 365n * 24n * 3600n
const MAX_U256 = 2n ** 256n - 1n

/** health as a plain number (∞ when nothing is owed), or null without a position. */
export function healthRatio(a: {
  mark: bigint; balance: bigint; owed: bigint; carryRate: bigint; epochLength: bigint
}): number | null {
  if (a.balance === 0n) return null
  const nextEpoch = (a.balance * ((a.carryRate * a.epochLength) / YEAR)) / 10n ** 18n
  const denom = (103n * (a.owed + nextEpoch)) / 100n
  if (denom === 0n) return Number.POSITIVE_INFINITY
  const value = (a.mark * a.balance) / 10n ** 18n
  return Number((value * 10_000n) / denom) / 10_000
}

export function healthLevel(health: number | null, runwayDays: bigint | undefined): HealthLevel {
  const runway = runwayDays === undefined || runwayDays === MAX_U256 ? Infinity : Number(runwayDays)
  const h = health ?? Infinity
  if (runway <= 2 || h <= 1.15) return 'critical'
  if (runway <= 7 || h <= 1.5) return 'warning'
  if (runway <= 30) return 'watch'
  return 'ok'
}

export const HEALTH_COPY: Record<HealthLevel, { label: string; badge: string }> = {
  ok:       { label: 'Healthy',  badge: 'pari-badge--success' },
  watch:    { label: 'Watch',    badge: 'pari-badge--warning' },
  warning:  { label: 'Warning',  badge: 'pari-badge--danger' },
  critical: { label: 'Critical', badge: 'pari-badge--danger' },
}

/**
 * Batch-4 contracts expose `motionId()`; batch 3 doesn't. true / false once known,
 * undefined while loading. Batch-4-only UI (Pay carry for unflagged holders, held
 * carry) waits for `true`.
 */
export function useIsBatch4(creditMarket: `0x${string}` | undefined): boolean | undefined {
  const { data, isError, isSuccess } = useReadContract({
    address: creditMarket,
    abi: CREDIT_MARKET_ABI,
    functionName: 'motionId',
    query: { enabled: !!creditMarket, retry: false, staleTime: 300_000 },
  })
  if (isSuccess && data !== undefined) return true
  if (isError) return false
  return undefined
}

export interface PositionHealth {
  balance: bigint | undefined
  health: number | null
  level: HealthLevel | null
  runway: bigint | undefined
  claimable: boolean | undefined
  confirmed: boolean | undefined
}

/** Health of `user`'s Upbet position in one market (null level when none / after an event). */
export function usePositionHealth(
  market: { creditMarket: `0x${string}`; yesToken: `0x${string}` },
  user: `0x${string}` | undefined,
): PositionHealth {
  const { data } = useReadContracts({
    contracts: [
      { address: market.yesToken, abi: ERC20_ABI, functionName: 'balanceOf', args: [user!] },
      { address: market.creditMarket, abi: CREDIT_MARKET_ABI, functionName: 'owed', args: [user!] },
      { address: market.creditMarket, abi: CREDIT_MARKET_ABI, functionName: 'currentMark' },
      { address: market.creditMarket, abi: CREDIT_MARKET_ABI, functionName: 'currentCarryRate' },
      { address: market.creditMarket, abi: CREDIT_MARKET_ABI, functionName: 'epochLength' },
      { address: market.creditMarket, abi: CREDIT_MARKET_ABI, functionName: 'epochsToExpire', args: [user!] },
      { address: market.creditMarket, abi: CREDIT_MARKET_ABI, functionName: 'claimable', args: [user!] },
      { address: market.creditMarket, abi: CREDIT_MARKET_ABI, functionName: 'creditEventConfirmed' },
    ],
    query: { enabled: !!user, refetchInterval: 60_000 },
  })
  const r = (i: number) => data?.[i]?.result as never
  const balance = r(0) as bigint | undefined
  const owed = r(1) as bigint | undefined
  const mark = r(2) as bigint | undefined
  const carryRate = r(3) as bigint | undefined
  const epochLength = r(4) as bigint | undefined
  const runway = r(5) as bigint | undefined
  const claimable = r(6) as boolean | undefined
  const confirmed = r(7) as boolean | undefined
  const health = balance !== undefined && owed !== undefined && mark !== undefined && carryRate !== undefined && epochLength !== undefined
    ? healthRatio({ mark, balance, owed, carryRate, epochLength })
    : null
  const level = !balance || confirmed || health === null ? null : healthLevel(health, runway)
  return { balance, health, level, runway, claimable, confirmed }
}
