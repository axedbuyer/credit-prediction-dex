// Per-market live dependencies for registry mode: one ChainReader (pre-filter)
// and one FeeSource (CLOBSettlement.feeBps(), refreshed independently) per
// market. Markets can appear at runtime (registry refresh), so services are
// created lazily on first sight; `sync()` pre-creates + starts them for every
// known market and is called at startup and after each registry refresh.

import type { Address } from 'viem'
import { createChainReader } from './chain'
import type { IChainReader } from './chain'
import { createFeeSource } from './feeSource'
import type { FeeSource } from './feeSource'
import type { MarketInfo } from './registry'
import type { MarketServices } from './server'

export interface MarketServicesInit {
  rpcUrl?: string
  chainId: number
  envFeeBps: number
  envFeeBpsWasSet: boolean
  feeRefreshMs?: number
}

interface Entry { chainReader?: IChainReader; feeSource: FeeSource; started: Promise<void> }

export class MarketServicesRegistry {
  private readonly entries = new Map<string, Entry>()

  constructor(private readonly init: MarketServicesInit) {}

  private create(m: MarketInfo): Entry {
    const feeSource = createFeeSource({
      rpcUrl: this.init.rpcUrl,
      chainId: this.init.chainId,
      clobSettlementAddress: m.clobSettlement as Address,
      envFeeBps: this.init.envFeeBps,
      envFeeBpsWasSet: this.init.envFeeBpsWasSet,
      refreshMs: this.init.feeRefreshMs,
    })
    const chainReader = this.init.rpcUrl
      ? createChainReader({
          rpcUrl: this.init.rpcUrl,
          chainId: this.init.chainId,
          creditMarketAddress: m.creditMarket as Address,
          yesTokenAddress: m.yesToken as Address,
        })
      : undefined
    // start() is bounded by an internal per-read timeout and never throws.
    const started = feeSource.start()
    const entry = { chainReader, feeSource, started }
    this.entries.set(m.slug, entry)
    return entry
  }

  /** Sync, never blocks: a brand-new market serves env-fallback fees until its first read lands. */
  get(m: MarketInfo): MarketServices {
    const e = this.entries.get(m.slug) ?? this.create(m)
    return { chainReader: e.chainReader, feeSource: e.feeSource }
  }

  /** Create + await the initial fee read for every market in the list. */
  async sync(markets: MarketInfo[]): Promise<void> {
    for (const m of markets) if (!this.entries.has(m.slug)) this.create(m)
    await Promise.all(markets.map(m => this.entries.get(m.slug)!.started))
  }

  stop(): void {
    for (const e of this.entries.values()) e.feeSource.stop()
  }
}
