'use client'

import { useState } from 'react'
import { useAccount, useWriteContract } from 'wagmi'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { waitForTransactionReceipt } from '@wagmi/core'
import { wagmiConfig } from '@/lib/wagmi'
import { ORDER_BOOK_URL } from '@/lib/constants'
import { CLOB_CANCEL_ABI } from '@/lib/clobAbi'
import type { Market } from '@/lib/markets'

// The connected wallet's resting orders in this market, with an on-chain cancel.
// Cancelling is a CLOBSettlement transaction (cancelOrders for one order,
// setMinNonce for all of them), so it holds even if the order book were to keep
// the order; afterwards POST /orders/sync asks the book to drop every order the
// chain now reports as unfillable.

type RawOrder = {
  id: string
  side: 'bid' | 'ask'
  maker: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  minAmountOut: string
  expiry: string
  nonce: string
  filled?: string
}

async function fetchBook(slug: string): Promise<{ bids: RawOrder[]; asks: RawOrder[] }> {
  const res = await fetch(`${ORDER_BOOK_URL}/orderbook?market=${encodeURIComponent(slug)}`, {
    signal: AbortSignal.timeout(3_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function syncBook(slug: string, maker: string) {
  await fetch(`${ORDER_BOOK_URL}/orders/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ market: slug, maker }),
  }).catch(() => undefined) // best effort: the matcher prunes it on its next attempt anyway
}

function toTuple(o: RawOrder) {
  return {
    maker: o.maker as `0x${string}`,
    tokenIn: o.tokenIn as `0x${string}`,
    tokenOut: o.tokenOut as `0x${string}`,
    amountIn: BigInt(o.amountIn),
    minAmountOut: BigInt(o.minAmountOut),
    expiry: BigInt(o.expiry),
    nonce: BigInt(o.nonce),
  }
}

export function OpenOrders({ market }: { market: Market }) {
  const { address } = useAccount()
  const queryClient = useQueryClient()
  const { writeContractAsync } = useWriteContract()
  const [busy, setBusy] = useState<string | null>(null) // order id, 'all', or null
  const [error, setError] = useState('')

  const { data } = useQuery({
    queryKey: ['orderbook', market.slug],
    queryFn: () => fetchBook(market.slug),
    refetchInterval: 2_000,
    retry: false,
    throwOnError: false,
    enabled: !!address,
  })

  if (!address) {
    return <p className="text-xs text-text-muted">Connect a wallet to see your open orders.</p>
  }

  const yes = market.yesToken.toLowerCase()
  const mine = [...(data?.bids ?? []), ...(data?.asks ?? [])].filter(
    (o) => o.maker.toLowerCase() === address.toLowerCase(),
  )

  const run = async (key: string, send: () => Promise<`0x${string}`>) => {
    setBusy(key)
    setError('')
    try {
      const hash = await send()
      await waitForTransactionReceipt(wagmiConfig, { hash })
      await syncBook(market.slug, address)
      await queryClient.invalidateQueries({ queryKey: ['orderbook', market.slug] })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg.includes('User rejected') || msg.includes('4001') ? 'Cancel rejected in wallet' : 'Cancel failed — try again')
    } finally {
      setBusy(null)
    }
  }

  const cancelOne = (o: RawOrder) =>
    run(o.id, () =>
      writeContractAsync({
        address: market.clobSettlement,
        abi: CLOB_CANCEL_ABI,
        functionName: 'cancelOrders',
        args: [[toTuple(o)]],
      }),
    )

  // Every order this wallet signed before now has a nonce below Date.now() (the UI
  // signs millisecond-timestamp nonces), so one setMinNonce retires all of them.
  const cancelAll = () =>
    run('all', () =>
      writeContractAsync({
        address: market.clobSettlement,
        abi: CLOB_CANCEL_ABI,
        functionName: 'setMinNonce',
        args: [BigInt(Date.now())],
      }),
    )

  if (mine.length === 0) {
    return <p className="text-xs text-text-muted">No open orders in this market.</p>
  }

  return (
    <div className="space-y-2 text-xs tabular">
      {mine.map((o) => {
        const isBid = o.side === 'bid'
        const outcome = (isBid ? o.tokenOut : o.tokenIn).toLowerCase() === yes ? 'Upbet' : 'Downbet'
        const size = Number(isBid ? o.minAmountOut : o.amountIn)
        const usdc = Number(isBid ? o.amountIn : o.minAmountOut)
        const left = Math.max(0, size - Number(o.filled ?? '0'))
        const cents = size > 0 ? (usdc / size) * 100 : 0
        return (
          <div key={o.id} className="flex items-center justify-between gap-2 border-b border-subtle pb-2">
            <span className={outcome === 'Upbet' ? 'text-danger' : 'text-teal'}>
              {isBid ? 'Buy' : 'Sell'} {outcome}
            </span>
            <span className="text-text-2">
              {(left / 1e6).toFixed(2)}
              {left < size && <span className="text-text-muted"> of {(size / 1e6).toFixed(2)}</span>} @ {cents.toFixed(1)}¢
            </span>
            <button
              onClick={() => cancelOne(o)}
              disabled={busy !== null}
              className="pari-b-btn pari-b-btn--secondary"
            >
              {busy === o.id ? 'Cancelling…' : 'Cancel'}
            </button>
          </div>
        )
      })}
      <button onClick={cancelAll} disabled={busy !== null} className="pari-b-btn pari-b-btn--secondary w-full">
        {busy === 'all' ? 'Cancelling…' : 'Cancel all in this market'}
      </button>
      {error && <p className="text-danger">{error}</p>}
    </div>
  )
}
