import type { Address, Hex } from 'viem'

// Runtime type with native bigints — used for EIP-712 signing/verification
export interface Order {
  maker: Address
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  minAmountOut: bigint
  expiry: bigint
  nonce: bigint
  signature: Hex
}

// Wire / storage format — bigint fields serialised as decimal strings for JSON
export interface OrderWire {
  maker: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  minAmountOut: string
  expiry: string
  nonce: string
  signature: string
}

export interface StoredOrder extends OrderWire {
  id: string
  side: Side
  price: number   // USDC-per-token float, used only for sorting
  timestamp: number
}

export interface OrderBook {
  bids: StoredOrder[]
  asks: StoredOrder[]
}

export type Side = 'bid' | 'ask'

export interface AppConfig {
  usdcAddress: string
  yesTokenAddress: string
  noTokenAddress: string
  clobSettlementAddress: string
  chainId: number
  port?: number
}
