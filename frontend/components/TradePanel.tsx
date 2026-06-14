'use client'

import { useState, useCallback } from 'react'
import { useAccount, useBalance, useReadContract, useWriteContract, useSignTypedData, useChainId } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { waitForTransactionReceipt } from '@wagmi/core'
import { parseUnits, formatUnits } from 'viem'
import { wagmiConfig } from '@/lib/wagmi'
import { CONTRACT_ADDRESSES, type SupportedChainId } from '@/lib/contracts'
import { ORDER_BOOK_URL } from '@/lib/constants'

// ── ABIs ────────────────────────────────────────────────────────────────────

const CREDIT_MARKET_ABI = [
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'usdcAmount', type: 'uint256' }],
    outputs: [],
  },
] as const

const ERC20_ABI = [
  {
    name: 'balanceOf',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const

// ── EIP-712 types ────────────────────────────────────────────────────────────

const ORDER_TYPES = {
  Order: [
    { name: 'maker',         type: 'address' },
    { name: 'tokenIn',       type: 'address' },
    { name: 'tokenOut',      type: 'address' },
    { name: 'amountIn',      type: 'uint256' },
    { name: 'minAmountOut',  type: 'uint256' },
    { name: 'expiry',        type: 'uint256' },
    { name: 'nonce',         type: 'uint256' },
  ],
} as const

// ── Types ────────────────────────────────────────────────────────────────────

type Side = 'YES' | 'NO'
type Direction = 'BUY' | 'SELL'
type Status = 'idle' | 'minting' | 'signing' | 'submitting' | 'success' | 'error'

type OrderBookData = {
  bids: { price: number; size: number }[]
  asks: { price: number; size: number }[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pctDisplay(p: number) {
  return `${(p * 100).toFixed(1)}%`
}

async function fetchOrderBook(marketId: string): Promise<OrderBookData> {
  const res = await fetch(`${ORDER_BOOK_URL}/orderbook?market=${marketId}`, {
    signal: AbortSignal.timeout(3_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// ── Component ────────────────────────────────────────────────────────────────

interface TradePanelProps {
  marketId: string
  initialSide?: Side
  initialDirection?: Direction
}

export function TradePanel({ marketId, initialSide, initialDirection }: TradePanelProps) {
  const { address, isConnected } = useAccount()
  const chainId = useChainId()
  const contracts = CONTRACT_ADDRESSES[chainId as SupportedChainId] ?? CONTRACT_ADDRESSES[84532]

  const [side, setSide] = useState<Side>(initialSide ?? 'YES')
  const [direction, setDirection] = useState<Direction>(initialDirection ?? 'BUY')
  const [usdcInput, setUsdcInput] = useState('')
  const [limitInput, setLimitInput] = useState('')
  const [status, setStatus] = useState<Status>('idle')
  const [errorMsg, setErrorMsg] = useState('')
  const [successOrderId, setSuccessOrderId] = useState('')

  // ── Order book (shared query key with OrderBook component) ─────────────────
  const { data: obData } = useQuery<OrderBookData>({
    queryKey: ['orderbook', marketId],
    queryFn: () => fetchOrderBook(marketId),
    refetchInterval: 2_000,
    retry: false,
    throwOnError: false,
  })

  const bestBid = obData?.bids[0]?.price
  const bestAsk = obData?.asks[0]?.price
  const midPrice =
    bestBid != null && bestAsk != null
      ? (bestBid + bestAsk) / 2
      : (bestBid ?? bestAsk)

  const limitPrice =
    limitInput !== ''
      ? Math.max(0.001, Math.min(0.999, parseFloat(limitInput) / 100))
      : (midPrice ?? 0.5)

  // ── Balances ───────────────────────────────────────────────────────────────
  const { data: usdcBalance } = useBalance({
    address,
    token: contracts.usdc,
  })

  const { data: yesBalance } = useReadContract({
    address: contracts.yesToken,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  })

  const { data: noBalance } = useReadContract({
    address: contracts.noToken,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  })

  // ── Wagmi write / sign ─────────────────────────────────────────────────────
  const { writeContractAsync } = useWriteContract()
  const { signTypedDataAsync } = useSignTypedData()

  // ── Derived display values ─────────────────────────────────────────────────
  const usdcAmt = parseFloat(usdcInput || '0')
  const isValidAmount = usdcAmt > 0 && !isNaN(usdcAmt)

  const tokenPrice = side === 'YES' ? limitPrice : 1 - limitPrice
  const tokenCostDisplay = `${side} costs ${(tokenPrice * 100).toFixed(1)}¢ per $1`

  const dailyCarryPct = (limitPrice / 365) * 100
  const dailyCarryDisplay =
    direction === 'BUY' && side === 'YES'
      ? `You pay ~${dailyCarryPct.toFixed(3)}% daily carry`
      : direction === 'BUY' && side === 'NO'
      ? `You earn ~${dailyCarryPct.toFixed(3)}% daily carry`
      : null

  const tokenBalance =
    side === 'YES'
      ? yesBalance != null ? Number(formatUnits(yesBalance, 6)) : null
      : noBalance  != null ? Number(formatUnits(noBalance,  6)) : null

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!address || !isValidAmount) return
    setStatus('idle')
    setErrorMsg('')
    setSuccessOrderId('')

    try {
      const usdcAmountWei = parseUnits(usdcAmt.toString(), 6)
      const limitPriceRaw = BigInt(Math.round(limitPrice * 1_000_000))
      const tokenAmountWei = side === 'YES'
        ? usdcAmountWei * 10n ** 18n / limitPriceRaw
        : usdcAmountWei * 10n ** 18n / (1_000_000n - limitPriceRaw)

      // Mint-first for SELL: need token balance
      if (direction === 'SELL') {
        const balanceWei = side === 'YES' ? (yesBalance ?? 0n) : (noBalance ?? 0n)
        if (balanceWei < tokenAmountWei) {
          const shortfall = tokenAmountWei - balanceWei
          // Calculate USDC needed to mint enough tokens
          const mintUsdc = side === 'YES'
            ? shortfall * limitPriceRaw / 10n ** 18n + 1n
            : shortfall * (1_000_000n - limitPriceRaw) / 10n ** 18n + 1n

          setStatus('minting')
          const hash = await writeContractAsync({
            address: contracts.creditMarket,
            abi: CREDIT_MARKET_ABI,
            functionName: 'mint',
            args: [mintUsdc],
          })
          await waitForTransactionReceipt(wagmiConfig, { hash })
        }
      }

      // Build EIP-712 order
      const tokenIn  = direction === 'BUY'
        ? contracts.usdc
        : (side === 'YES' ? contracts.yesToken : contracts.noToken)
      const tokenOut = direction === 'BUY'
        ? (side === 'YES' ? contracts.yesToken : contracts.noToken)
        : contracts.usdc
      const amountIn = direction === 'BUY' ? usdcAmountWei : tokenAmountWei
      const minAmountOut = direction === 'BUY' ? tokenAmountWei : usdcAmountWei

      const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600)
      const nonce  = BigInt(Date.now())

      const domain = {
        name: 'CLOBSettlement',
        version: '1',
        chainId: 84532,
        verifyingContract: contracts.clobSettlement,
      } as const

      const message = {
        maker:        address,
        tokenIn,
        tokenOut,
        amountIn,
        minAmountOut,
        expiry,
        nonce,
      }

      setStatus('signing')
      const signature = await signTypedDataAsync({
        domain,
        types: ORDER_TYPES,
        primaryType: 'Order',
        message,
      })

      setStatus('submitting')
      const res = await fetch(`${ORDER_BOOK_URL}/order`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maker:        address,
          tokenIn,
          tokenOut,
          amountIn:     amountIn.toString(),
          minAmountOut: minAmountOut.toString(),
          expiry:       expiry.toString(),
          nonce:        nonce.toString(),
          signature,
          market:       marketId,
        }),
      })

      if (!res.ok) {
        const err = await res.text()
        throw new Error(err || `Server ${res.status}`)
      }

      const { orderId } = await res.json()
      setSuccessOrderId(orderId ?? 'submitted')
      setStatus('success')
      setUsdcInput('')
    } catch (e: unknown) {
      setStatus('error')
      const msg = e instanceof Error ? e.message : 'Unknown error'
      // User rejected signature — friendly message
      setErrorMsg(msg.includes('User rejected') || msg.includes('4001') ? 'Signature rejected' : msg)
    }
  }, [
    address, isValidAmount, usdcAmt, limitPrice, side, direction,
    yesBalance, noBalance, contracts, marketId,
    writeContractAsync, signTypedDataAsync,
  ])

  // ── Render ─────────────────────────────────────────────────────────────────
  const busy = status === 'minting' || status === 'signing' || status === 'submitting'

  const buttonLabel =
    !isConnected             ? 'Connect wallet to trade'
    : busy                   ? statusLabel(status)
    : `Place ${direction} ${side} order`

  return (
    <div className="flex flex-col gap-4">
      <h2 className="text-sm font-semibold text-slate-200 uppercase tracking-wide">Place Order</h2>

      {/* Side toggle */}
      <div className="flex rounded-lg overflow-hidden border border-slate-700 text-sm font-medium">
        {(['YES', 'NO'] as Side[]).map((s) => (
          <button
            key={s}
            onClick={() => setSide(s)}
            className={`flex-1 py-2 transition-colors ${
              side === s
                ? s === 'YES'
                  ? 'bg-emerald-600 text-white'
                  : 'bg-red-600 text-white'
                : 'bg-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Direction toggle */}
      <div className="flex rounded-lg overflow-hidden border border-slate-700 text-sm font-medium">
        {(['BUY', 'SELL'] as Direction[]).map((d) => (
          <button
            key={d}
            onClick={() => setDirection(d)}
            className={`flex-1 py-1.5 transition-colors ${
              direction === d
                ? 'bg-slate-600 text-slate-100'
                : 'bg-slate-800 text-slate-400 hover:text-slate-200'
            }`}
          >
            {d}
          </button>
        ))}
      </div>

      {/* USDC amount */}
      <div>
        <label className="block text-xs text-slate-400 mb-1">USDC amount</label>
        <div className="flex gap-2">
          <input
            type="number"
            min="0"
            step="any"
            placeholder="0.00"
            value={usdcInput}
            onChange={(e) => setUsdcInput(e.target.value)}
            className="flex-1 rounded bg-slate-800 border border-slate-700 px-3 py-2 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-slate-500"
          />
          <button
            onClick={() => {
              if (usdcBalance) setUsdcInput(formatUnits(usdcBalance.value, 6))
            }}
            className="rounded bg-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-600 transition-colors"
          >
            MAX
          </button>
        </div>
        {usdcBalance && (
          <p className="mt-1 text-[11px] text-slate-500">
            Balance: {parseFloat(formatUnits(usdcBalance.value, 6)).toFixed(2)} USDC
          </p>
        )}
      </div>

      {/* Limit price */}
      <div>
        <label className="block text-xs text-slate-400 mb-1">
          Limit price
          {midPrice != null && (
            <span className="ml-1 text-slate-500">(mid: {(midPrice * 100).toFixed(1)}%)</span>
          )}
        </label>
        <div className="relative">
          <input
            type="number"
            min="0.1"
            max="99.9"
            step="0.1"
            placeholder={midPrice != null ? (midPrice * 100).toFixed(1) : '50.0'}
            value={limitInput}
            onChange={(e) => setLimitInput(e.target.value)}
            className="w-full rounded bg-slate-800 border border-slate-700 px-3 py-2 pr-16 text-sm text-slate-100 placeholder-slate-600 focus:outline-none focus:border-slate-500"
          />
          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500">
            % prob
          </span>
        </div>
      </div>

      {/* Contextual info */}
      <div className="rounded bg-slate-800/60 px-3 py-2 text-[11px] text-slate-400 space-y-1">
        <p>{tokenCostDisplay}</p>
        {dailyCarryDisplay && <p>{dailyCarryDisplay}</p>}
        {direction === 'SELL' && tokenBalance != null && (
          <p>
            {side} balance: {tokenBalance.toFixed(2)}
            {tokenBalance === 0 && ' — will mint first'}
          </p>
        )}
      </div>

      {/* Submit button */}
      <button
        onClick={handleSubmit}
        disabled={!isConnected || !isValidAmount || busy}
        className={`w-full rounded-lg py-2.5 text-sm font-semibold transition-colors ${
          !isConnected || !isValidAmount || busy
            ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
            : side === 'YES'
            ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
            : 'bg-red-600 hover:bg-red-500 text-white'
        }`}
      >
        {buttonLabel}
      </button>

      {/* Status feedback */}
      {status === 'success' && (
        <div className="rounded bg-emerald-950/60 border border-emerald-800/50 px-3 py-2 text-xs text-emerald-300">
          Order placed — ID: <span className="font-mono">{successOrderId}</span>
        </div>
      )}
      {status === 'error' && (
        <div className="rounded bg-red-950/60 border border-red-800/50 px-3 py-2 text-xs text-red-300">
          {errorMsg}
        </div>
      )}
    </div>
  )
}

function statusLabel(s: Status) {
  if (s === 'minting')    return 'Minting tokens…'
  if (s === 'signing')    return 'Sign order in wallet…'
  if (s === 'submitting') return 'Submitting…'
  return 'Processing…'
}
