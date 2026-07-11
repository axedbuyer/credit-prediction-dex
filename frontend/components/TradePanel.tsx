'use client'

import { useState, useCallback } from 'react'
import { useAccount, useBalance, useReadContract, useWriteContract, useSignTypedData, useChainId, usePublicClient } from 'wagmi'
import { useQuery } from '@tanstack/react-query'
import { waitForTransactionReceipt } from '@wagmi/core'
import { parseUnits, formatUnits } from 'viem'
import { wagmiConfig } from '@/lib/wagmi'
import { CONTRACT_ADDRESSES, type SupportedChainId } from '@/lib/contracts'
import { ORDER_BOOK_URL } from '@/lib/constants'
import { CREDIT_MARKET_ABI, ERC20_ABI, netFundingDebit } from '@/lib/creditMarketAbi'
import { FEE_BPS, tradeFee, minGrossForNet } from '@/lib/feeMath'

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

// Raw StoredOrder shape from GET /orderbook — the book is shared across YES
// and NO orders for the market (tokenIn/tokenOut disambiguate which), so
// best-bid/best-ask must be filtered to the side currently being traded
// before use, or a NO order's price (not comparable to a YES price on the
// same axis) makes the book look crossed and skews the displayed mid price.
type RawOrder = { price: number; tokenIn: string; tokenOut: string }
type OrderBookData = {
  bids: RawOrder[]
  asks: RawOrder[]
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function pctDisplay(p: number) {
  return `${(p * 100).toFixed(1)}%`
}

function sideLabel(s: Side): 'Upbet' | 'Downbet' {
  return s === 'YES' ? 'Upbet' : 'Downbet'
}

async function fetchOrderBook(marketId: string): Promise<OrderBookData> {
  const res = await fetch(`${ORDER_BOOK_URL}/orderbook?market=${marketId}`, {
    signal: AbortSignal.timeout(3_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

// tokenAmountWei: how many 6-decimal YES/NO tokens correspond to `usdcAmountWei` (6-dec)
// at `limitPriceRaw` (price scaled to 1e6, i.e. limitPrice*1_000_000). Shared between the
// live preview (min-sell-price guidance) and the actual order/mint submission so both
// always agree on the same number.
function computeTokenAmountWei(
  side: Side,
  usdcAmountWei: bigint,
  limitPriceRaw: bigint,
): bigint {
  return side === 'YES'
    ? usdcAmountWei * 1_000_000n / limitPriceRaw
    : usdcAmountWei * 1_000_000n / (1_000_000n - limitPriceRaw)
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
  const publicClient = usePublicClient()
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

  // Filter the shared book down to whichever side is currently selected
  // (Upbet/YES or Downbet/NO) before deriving best bid/ask.
  const sideToken = (side === 'YES' ? contracts.yesToken : contracts.noToken).toLowerCase()
  const sideBids = obData?.bids.filter(o => o.tokenOut.toLowerCase() === sideToken) ?? []
  const sideAsks = obData?.asks.filter(o => o.tokenIn.toLowerCase()  === sideToken) ?? []

  const bestBid = sideBids[0]?.price
  const bestAsk = sideAsks[0]?.price
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

  // ── Freeze state (v1b1) — a flagged position locks mint/redeem/all CLOB trades ──
  const { data: claimableData } = useReadContract({
    address: contracts.creditMarket,
    abi: CREDIT_MARKET_ABI,
    functionName: 'claimable',
    args: address ? [address] : undefined,
    query: { enabled: !!address },
  })
  const isFrozen = claimableData === true

  // ── Carry-owed preview (SELL + YES only) ────────────────────────────────────
  const wantsCarryPreview = direction === 'SELL' && side === 'YES' && !isFrozen

  const { data: previewDelta } = useReadContract({
    address: contracts.creditMarket,
    abi: CREDIT_MARKET_ABI,
    functionName: 'previewFunding',
    args: address ? [address, yesBalance ?? 0n, true] : undefined,
    query: { enabled: !!address && wantsCarryPreview },
  })

  const { data: fundingDebtData } = useReadContract({
    address: contracts.creditMarket,
    abi: CREDIT_MARKET_ABI,
    functionName: 'fundingDebt',
    args: address ? [address] : undefined,
    query: { enabled: !!address && wantsCarryPreview },
  })

  const carryOwed =
    wantsCarryPreview && previewDelta !== undefined && fundingDebtData !== undefined
      ? netFundingDebit(previewDelta, fundingDebtData)
      : 0n

  // ── Wagmi write / sign ─────────────────────────────────────────────────────
  const { writeContractAsync } = useWriteContract()
  const { signTypedDataAsync } = useSignTypedData()

  // ── Derived display values ─────────────────────────────────────────────────
  const usdcAmt = parseFloat(usdcInput || '0')
  const isValidAmount = usdcAmt > 0 && !isNaN(usdcAmt)

  const tokenPrice = side === 'YES' ? limitPrice : 1 - limitPrice
  const tokenCostDisplay = `${sideLabel(side)} costs ${(tokenPrice * 100).toFixed(1)}¢ per $1`

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

  // Minimum USDC proceeds this order must clear to cover carry owed (Option B safeguard
  // mirrors CLOBSettlement: proceeds for the WHOLE trade, not per-token, must be >= carry
  // owed — the debit is netted over the seller's full balance regardless of trade size).
  let usdcAmountWeiPreview: bigint | null = null
  let tokenAmountWeiPreview: bigint | null = null
  if (isValidAmount) {
    try {
      usdcAmountWeiPreview = parseUnits(usdcAmt.toString(), 6)
      const limitPriceRawPreview = BigInt(Math.round(limitPrice * 1_000_000))
      tokenAmountWeiPreview = computeTokenAmountWei(side, usdcAmountWeiPreview, limitPriceRawPreview)
    } catch {
      usdcAmountWeiPreview = null
      tokenAmountWeiPreview = null
    }
  }

  // ── Trade fee (charged on the carry-earning side only) ─────────────────────
  // Upbet (YES) sell: fee comes out of the seller's proceeds on-chain, exactly
  //   like the carry debit — mirror CLOBSettlement's tradeFee for the preview.
  // Downbet (NO) buy: fee rides inside the buyer's signed amountIn — the order
  //   signs GROSS (position cost + fee) so the fee-free seller still nets the
  //   intended cost; minGrossForNet is the exact inversion of the on-chain check.
  // Upbet buys and Downbet sells carry no trade fee.
  const isYesSell = direction === 'SELL' && side === 'YES'
  const isNoBuy   = direction === 'BUY'  && side === 'NO'
  const feeWeiPreview: bigint =
    usdcAmountWeiPreview !== null && tokenAmountWeiPreview !== null && tokenAmountWeiPreview > 0n
      ? isYesSell
        ? tradeFee(tokenAmountWeiPreview, usdcAmountWeiPreview)
        : isNoBuy
        ? minGrossForNet(usdcAmountWeiPreview, tokenAmountWeiPreview) - usdcAmountWeiPreview
        : 0n
      : 0n

  const feeDisplay = feeWeiPreview > 0n
    ? `$${parseFloat(formatUnits(feeWeiPreview, 6)).toFixed(2)}`
    : null
  const feePctLabel = `${(Number(FEE_BPS) / 100).toFixed(2).replace(/\.?0+$/, '')}%`

  // The on-chain Option B check is tradePrice ≥ carry owed + fee.
  const carryShortfall =
    wantsCarryPreview &&
    carryOwed > 0n &&
    usdcAmountWeiPreview !== null &&
    usdcAmountWeiPreview < carryOwed + feeWeiPreview

  // Minimum sell price (as annual-probability %) needed for THIS order's token
  // quantity to clear carry owed plus the trade fee: exact inversion of
  // net(G) = G − fee(G) ≥ carryOwed, divided by tokens sold.
  const minSellPricePct =
    wantsCarryPreview && carryOwed > 0n && tokenAmountWeiPreview && tokenAmountWeiPreview > 0n
      ? (Number(minGrossForNet(carryOwed, tokenAmountWeiPreview)) / Number(tokenAmountWeiPreview)) * 100
      : null

  const carryOwedDisplay = wantsCarryPreview && carryOwed > 0n
    ? `$${parseFloat(formatUnits(carryOwed, 6)).toFixed(2)}`
    : null

  const sellDeductions = carryOwed + feeWeiPreview
  const sellProceedsAfterCarry =
    isYesSell && sellDeductions > 0n && usdcAmountWeiPreview !== null
      ? formatUnits(
          usdcAmountWeiPreview > sellDeductions ? usdcAmountWeiPreview - sellDeductions : 0n,
          6,
        )
      : null

  const noBuyTotalDisplay =
    isNoBuy && feeWeiPreview > 0n && usdcAmountWeiPreview !== null
      ? `$${parseFloat(formatUnits(usdcAmountWeiPreview + feeWeiPreview, 6)).toFixed(2)}`
      : null

  // ── Submit ─────────────────────────────────────────────────────────────────
  const handleSubmit = useCallback(async () => {
    if (!address || !isValidAmount || isFrozen || carryShortfall) return
    setStatus('idle')
    setErrorMsg('')
    setSuccessOrderId('')

    try {
      const usdcAmountWei = parseUnits(usdcAmt.toString(), 6)
      const limitPriceRaw = BigInt(Math.round(limitPrice * 1_000_000))
      const tokenAmountWei = computeTokenAmountWei(side, usdcAmountWei, limitPriceRaw)

      // Mint-first for SELL: need token balance
      if (direction === 'SELL') {
        const balanceWei = side === 'YES' ? (yesBalance ?? 0n) : (noBalance ?? 0n)
        if (balanceWei < tokenAmountWei) {
          const shortfall = tokenAmountWei - balanceWei
          // Calculate USDC needed to mint enough tokens
          const mintUsdc = side === 'YES'
            ? shortfall * limitPriceRaw / 1_000_000n + 1n
            : shortfall * (1_000_000n - limitPriceRaw) / 1_000_000n + 1n

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
      // Downbet (NO) buys sign a GROSS amountIn — position cost plus the trade
      // fee — because on-chain the fee is carved out of the buyer's USDC leg
      // and the fee-free seller's limit is checked against the NET amount.
      // Every other combination signs its amounts unchanged (no fee, or the
      // fee is deducted from the Upbet seller's proceeds after the fact).
      const grossUsdcIn =
        direction === 'BUY' && side === 'NO'
          ? minGrossForNet(usdcAmountWei, tokenAmountWei)
          : usdcAmountWei
      const amountIn = direction === 'BUY' ? grossUsdcIn : tokenAmountWei
      const minAmountOut = direction === 'BUY' ? tokenAmountWei : usdcAmountWei

      // The demo chain is time-warped well ahead of wall-clock time, so a
      // wall-clock expiry would already be in the past on-chain. Compute
      // expiry from the CHAIN's own latest block timestamp instead, falling
      // back to wall-clock + 1h only if the block fetch fails.
      let expiry: bigint
      try {
        const block = await publicClient?.getBlock()
        if (!block) throw new Error('no public client')
        expiry = block.timestamp + 3600n
      } catch {
        expiry = BigInt(Math.floor(Date.now() / 1000) + 3600)
      }
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
        // The order-book server pre-filters deterministic on-chain reverts and
        // returns a structured error — map both to the same friendly copy the
        // client-side gating above already shows.
        let body: { error?: string; minSellProceeds?: string } | null = null
        try {
          body = await res.clone().json()
        } catch {
          body = null
        }
        if (body?.error === 'FundingShortfall') {
          const min = body.minSellProceeds ? formatUnits(BigInt(body.minSellProceeds), 6) : null
          throw new Error(
            min
              ? `Carry owed exceeds this order's proceeds — minimum proceeds to cover it: $${parseFloat(min).toFixed(2)}`
              : "Carry owed exceeds this order's proceeds — increase the price or amount",
          )
        }
        if (body?.error && /position frozen/i.test(body.error)) {
          throw new Error('Your position is frozen pending liquidation. Cure it from your Portfolio or wait for a claim.')
        }
        const err = body?.error ?? (await res.text().catch(() => ''))
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
    address, isValidAmount, isFrozen, carryShortfall, usdcAmt, limitPrice, side, direction,
    yesBalance, noBalance, contracts, marketId, publicClient,
    writeContractAsync, signTypedDataAsync,
  ])

  // ── Render ─────────────────────────────────────────────────────────────────
  const busy = status === 'minting' || status === 'signing' || status === 'submitting'

  const buttonLabel =
    !isConnected             ? 'Connect wallet to trade'
    : isFrozen               ? 'Position frozen'
    : busy                   ? statusLabel(status)
    : carryShortfall         ? 'Increase price or amount to cover carry'
    : `Place ${direction} ${sideLabel(side)} order`

  return (
    <div className="flex flex-col gap-4">
      <p className="pari-eyebrow">Place Order</p>

      {/* Frozen banner — flagged positions are fully locked (mint, redeem, any CLOB trade) */}
      {isFrozen && (
        <div className="border border-danger-a28 bg-danger-a10 px-3 py-2.5 text-xs text-danger">
          Your position is frozen pending liquidation. Cure it from your Portfolio or wait
          for a claim.
        </div>
      )}

      {/* Side toggle: Upbet (YES, danger) / Downbet (NO, teal) */}
      <div className="grid grid-cols-2 gap-2">
        {(['YES', 'NO'] as Side[]).map((s) => {
          const selected = side === s
          const upbet = s === 'YES'
          return (
            <button
              key={s}
              onClick={() => setSide(s)}
              className={`pari-b-btn ${
                selected
                  ? upbet
                    ? 'pari-b-btn--danger'
                    : 'pari-b-btn--secondary'
                  : 'bg-surface-2 text-text-muted border border-subtle'
              }`}
            >
              {upbet ? 'Upbet' : 'Downbet'}
            </button>
          )
        })}
      </div>

      {/* Direction toggle */}
      <div className="grid grid-cols-2 gap-2">
        {(['BUY', 'SELL'] as Direction[]).map((d) => (
          <button
            key={d}
            onClick={() => setDirection(d)}
            className={`pari-b-btn ${
              direction === d
                ? 'pari-b-btn--secondary'
                : 'bg-surface-2 text-text-muted border border-subtle'
            }`}
          >
            {d}
          </button>
        ))}
      </div>

      {/* USDC amount */}
      <div className="pari-b-field">
        <label className="pari-b-label">USDC Amount</label>
        <div className="flex gap-2 items-end">
          <input
            type="number"
            min="0"
            step="any"
            placeholder="0.00"
            value={usdcInput}
            onChange={(e) => setUsdcInput(e.target.value)}
            className="pari-b-input tabular flex-1"
          />
          <button
            onClick={() => {
              if (usdcBalance) setUsdcInput(formatUnits(usdcBalance.value, 6))
            }}
            className="pari-b-btn pari-b-btn--secondary"
          >
            Max
          </button>
        </div>
        {usdcBalance && (
          <p className="text-xs text-text-muted tabular">
            Balance: {parseFloat(formatUnits(usdcBalance.value, 6)).toFixed(2)} USDC
          </p>
        )}
      </div>

      {/* Limit price */}
      <div className="pari-b-field">
        <label className="pari-b-label">
          Limit Price
          {midPrice != null && (
            <span className="ml-1 normal-case text-text-muted">(mid: {(midPrice * 100).toFixed(1)}%)</span>
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
            className="pari-b-input tabular pr-16"
          />
          <span className="absolute right-0 top-1/2 -translate-y-1/2 text-xs uppercase tracking-wide text-text-muted">
            % chance
          </span>
        </div>
      </div>

      {/* Contextual info */}
      <div className="border border-subtle bg-surface-2 px-3 py-2 text-xs text-text-2 tabular space-y-1">
        <p>{tokenCostDisplay}</p>
        {dailyCarryDisplay && <p>{dailyCarryDisplay}</p>}
        {direction === 'SELL' && tokenBalance != null && (
          <p>
            {sideLabel(side)} balance: {tokenBalance.toFixed(2)}
            {tokenBalance === 0 && ' — will mint first'}
          </p>
        )}
        {carryOwedDisplay && (
          <p className={carryShortfall ? 'text-danger' : undefined}>
            Carry owed: {carryOwedDisplay}
            {minSellPricePct !== null && (
              <> — minimum sell price to cover carry{feeWeiPreview > 0n ? ' + fee' : ''}: {minSellPricePct.toFixed(1)}%</>
            )}
          </p>
        )}
        {isYesSell && feeDisplay && (
          <p>Trade fee ({feePctLabel}): {feeDisplay}</p>
        )}
        {noBuyTotalDisplay && (
          <p>Total {noBuyTotalDisplay} — includes {feeDisplay} trade fee ({feePctLabel})</p>
        )}
        {((direction === 'BUY' && side === 'YES') || (direction === 'SELL' && side === 'NO')) && (
          <p className="text-text-muted">No trade fee on this order</p>
        )}
        {sellProceedsAfterCarry !== null && !carryShortfall && (
          <p>You receive ≈ ${parseFloat(sellProceedsAfterCarry).toFixed(2)}</p>
        )}
      </div>

      {/* Submit button */}
      <button
        onClick={handleSubmit}
        disabled={!isConnected || !isValidAmount || busy || isFrozen || carryShortfall}
        className={`pari-b-btn w-full py-3 ${side === 'YES' ? 'pari-b-btn--danger' : 'pari-b-btn--primary'}`}
      >
        {buttonLabel}
      </button>

      {/* Status feedback */}
      {status === 'success' && (
        <div className="border border-teal-a22 bg-teal-a10 px-3 py-2 text-xs text-teal">
          Order placed — ID: <span className="tabular">{successOrderId}</span>
        </div>
      )}
      {status === 'error' && (
        <div className="border border-danger-a28 bg-danger-a10 px-3 py-2 text-xs text-danger">
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
