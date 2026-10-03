'use client'

// Single source of market discovery for the whole frontend (root CLAUDE.md D5).
//
//   useMarkets()      -> { markets, isLoading, isError, source }   (all registered markets)
//   useMarket(slug)   -> { market, isLoading, notFound, ... }      (one market by slug)
//
// Normal mode: reads MarketRegistry.allMarkets() on-chain from
// NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS. Legacy mode (env unset): synthesizes exactly one
// market `mstr` from the pre-registry single-market NEXT_PUBLIC_* address vars so a site
// deployed before the registry exists keeps working unchanged. Nothing else in the app
// may read CONTRACT_ADDRESSES directly.

import { useMemo } from 'react'
import { useReadContract } from 'wagmi'
import { CONTRACT_ADDRESSES } from '@/lib/contracts'
import {
  MARKET_REGISTRY_ABI,
  parseRegistryMarkets,
  type Hex,
  type MarketInfo,
} from '@/lib/marketRegistry'
import { getMarketCopy, marketTitle, type MarketCopy } from '@/lib/marketCopy'

export interface Market extends MarketInfo {
  usdc: Hex
  title: string
  copy: MarketCopy
}

const REGISTRY = process.env.NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS as Hex | undefined
export const REGISTRY_CONFIGURED = !!REGISTRY

const SHARED_USDC = CONTRACT_ADDRESSES[84532].usdc

function decorate(m: MarketInfo): Market {
  return {
    ...m,
    usdc: SHARED_USDC,
    title: marketTitle(m.entityName),
    copy: getMarketCopy(m.slug, m.entityType),
  }
}

// ── Legacy fallback (registry env unset) ────────────────────────────────────
function legacyMarkets(): Market[] {
  const a = CONTRACT_ADDRESSES[84532]
  return [
    decorate({
      id: 0,
      slug: 'mstr',
      entityName: 'MicroStrategy',
      entityType: 'corporate',
      creditMarket: a.creditMarket,
      yesToken: a.yesToken,
      noToken: a.noToken,
      clobSettlement: a.clobSettlement,
      oracleRouter: a.oracleRouter,
      liquidationEngine: a.liquidationEngine,
      active: true,
      registeredAt: 0n,
      startBlock: 0n,
    }),
  ]
}

const LEGACY = legacyMarkets()

export interface UseMarketsResult {
  markets: Market[]
  isLoading: boolean
  isError: boolean
  source: 'registry' | 'legacy'
}

export function useMarkets(): UseMarketsResult {
  const { data, isLoading, isError } = useReadContract({
    address: REGISTRY,
    abi: MARKET_REGISTRY_ABI,
    functionName: 'allMarkets',
    query: { enabled: REGISTRY_CONFIGURED, refetchInterval: 60_000 },
  })

  const markets = useMemo(
    () => (data ? parseRegistryMarkets(data).map(decorate) : []),
    [data],
  )

  if (!REGISTRY_CONFIGURED) {
    return { markets: LEGACY, isLoading: false, isError: false, source: 'legacy' }
  }
  return { markets, isLoading, isError, source: 'registry' }
}

export interface UseMarketResult {
  market: Market | undefined
  isLoading: boolean
  isError: boolean
  /** True only once markets are loaded and no market has this slug. */
  notFound: boolean
}

export function useMarket(slug: string | undefined): UseMarketResult {
  const { markets, isLoading, isError } = useMarkets()
  const market = slug ? markets.find((m) => m.slug === slug) : undefined
  return { market, isLoading, isError, notFound: !isLoading && !isError && !market }
}

/** Active markets only (inactive ones are hidden from listings). */
export function useActiveMarkets(): UseMarketsResult {
  const r = useMarkets()
  return { ...r, markets: r.markets.filter((m) => m.active) }
}
