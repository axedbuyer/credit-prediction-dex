import { MSTR_MARKET } from '@/lib/constants'
import { OrderBook } from '@/components/OrderBook'
import { TradePanel } from '@/components/TradePanel'
import { PriceChart } from '@/components/PriceChart'
import { FundingTicker } from '@/components/FundingTicker'

export default function MarketPage({ params }: { params: { id: string } }) {
  return (
    <div className="mx-auto max-w-[1280px] px-4 py-8">
      {/* Market header */}
      <div className="mb-6">
        <p className="pari-eyebrow mb-2">MSTR · Perpetual · Credit Event Market</p>
        <h1 className="font-serif text-3xl text-text-1">
          {MSTR_MARKET.name}
        </h1>
        <p className="mt-1 text-sm text-text-2">
          {MSTR_MARKET.entity} · {MSTR_MARKET.creditEvents.join(' & ')} · Base
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {/* Row 1: chart + order book */}
        <div className="col-span-2 pari-b-card">
          <p className="pari-b-card__header">Mark History</p>
          <PriceChart marketId={params.id} />
        </div>
        <div className="pari-b-card">
          <p className="pari-b-card__header">Order Book</p>
          <OrderBook marketId={params.id} />
        </div>

        {/* Row 2: funding ticker + trade panel */}
        <div className="col-span-2">
          <FundingTicker />
        </div>
        <div className="pari-b-card">
          <TradePanel marketId={params.id} />
        </div>
      </div>
    </div>
  )
}
