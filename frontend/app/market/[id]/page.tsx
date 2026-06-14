import { MSTR_MARKET } from '@/lib/constants'
import { OrderBook } from '@/components/OrderBook'
import { TradePanel } from '@/components/TradePanel'
import { PriceChart } from '@/components/PriceChart'

export default function MarketPage({ params }: { params: { id: string } }) {
  return (
    <div className="mx-auto max-w-7xl px-4 py-8">
      {/* Market header */}
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-slate-100">
          {MSTR_MARKET.name}
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          MicroStrategy Inc. · Bankruptcy &amp; Failure to Pay · Base
        </p>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {/* Row 1: chart + order book */}
        <div className="col-span-2 rounded-lg border border-slate-800 bg-slate-900 p-6">
          <PriceChart marketId={params.id} />
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
          <OrderBook marketId={params.id} />
        </div>

        {/* Row 2: funding info placeholder + trade panel */}
        <div className="col-span-2 rounded-lg border border-slate-800 bg-slate-900 p-6">
          <p className="text-slate-400 text-sm">Funding ticker — coming soon</p>
        </div>
        <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
          <TradePanel marketId={params.id} />
        </div>
      </div>
    </div>
  )
}
