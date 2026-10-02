// Long-form, human-facing copy per market, keyed by registry slug. A market that is
// registered on-chain but has no entry here still renders — it falls back to generic
// copy by entityType, so adding a market never requires a frontend rebuild.
//
// This is the ONLY place entity names / credit-event lists live in the frontend.
// The display name always comes from the registry's `entityName` (e.g. "Turkey");
// the market title is derived from it.

import type { EntityType } from '@/lib/marketRegistry'

export interface MarketCopy {
  legalName?: string
  ticker?: string
  creditEvents: readonly string[]
}

const CORPORATE_EVENTS = ['Bankruptcy', 'Failure to Pay'] as const
const SOVEREIGN_EVENTS = ['Failure to Pay', 'Repudiation/Moratorium', 'Restructuring'] as const

const COPY_BY_SLUG: Record<string, MarketCopy> = {
  mstr: { legalName: 'MicroStrategy Incorporated', ticker: 'MSTR', creditEvents: CORPORATE_EVENTS },
  crwv: { legalName: 'CoreWeave, Inc.', ticker: 'CRWV', creditEvents: CORPORATE_EVENTS },
  try:  { legalName: 'Republic of Turkey', ticker: 'TRY', creditEvents: SOVEREIGN_EVENTS },
}

export function getMarketCopy(slug: string, entityType: EntityType): MarketCopy {
  return (
    COPY_BY_SLUG[slug] ?? {
      creditEvents: entityType === 'sovereign' ? SOVEREIGN_EVENTS : CORPORATE_EVENTS,
    }
  )
}

export function marketTitle(entityName: string): string {
  return `Will ${entityName} have a credit event in the next 12 months?`
}

export function entityTypeLabel(entityType: EntityType): string {
  return entityType === 'sovereign' ? 'Sovereign' : 'Corporate'
}
