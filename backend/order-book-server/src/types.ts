import type { Address, Hex } from 'viem'
import type { FeeSourceReader } from './feeSource'

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
  // v1b1: chain pre-filter config (used by main.ts to build an IChainReader;
  // creditMarketAddress/rpcUrl are optional — when absent the reader is
  // omitted and buildApp() skips freeze/funding pre-filter checks entirely).
  creditMarketAddress?: string
  rpcUrl?: string
  // Trading fee in bps of min(p, 1−p) × Q — must mirror CLOBSettlement.feeBps.
  // Drives the net-of-fee price basis for NO bids and the YES-sell pre-filter's
  // fee component. Absent/0 ⇒ legacy gross pricing, no fee in the pre-filter.
  //
  // STATIC fallback — used only when `feeSource` (below) is absent. Tests that
  // want a fixed, non-refreshing rate can keep passing this field directly.
  feeBps?: number
  // Live, on-chain-backed fee rate (see src/feeSource.ts). When present, this
  // takes precedence over the static `feeBps` above for every per-request
  // read (server.ts's `currentFeeBps` helper) and is what GET /health reports.
  // main.ts always sets this (via createFeeSource); tests may omit it to
  // exercise the static-feeBps backward-compat path, or provide a hand-rolled
  // fake implementing { getFeeBps, getSnapshot } with no RPC/timers involved.
  feeSource?: FeeSourceReader
  // Allow-listed CORS origins (exact match, trimmed + trailing-slash-stripped),
  // parsed from the comma-separated CORS_ORIGINS env var. Undefined/empty ⇒
  // wildcard `Access-Control-Allow-Origin: *` (current/default behaviour).
  corsOrigins?: string[]
  // Rate limiting for POST /order + DELETE /order/:id ONLY (see server.ts's
  // buildApp / src/rateLimit.ts). A single shared bucket per client IP across
  // both routes. orderRateLimitMax undefined ⇒ default 60; 0 ⇒ limiter
  // disabled entirely (buildApp skips plugin registration — used by the
  // local demo stack / tests). orderRateLimitWindowMs undefined ⇒ default
  // 60_000 (60s). Parsed from ORDER_RATE_LIMIT_MAX / ORDER_RATE_LIMIT_WINDOW_MS.
  orderRateLimitMax?: number
  orderRateLimitWindowMs?: number
  // Fastify's `trustProxy` option (passed straight through to the Fastify()
  // constructor), parsed from TRUST_PROXY by src/rateLimit.ts#parseTrustProxy.
  // Governs how `request.ip` (what the rate limiter keys on) is derived from
  // X-Forwarded-For — see that function's doc comment for the false / true /
  // hop-count(N) semantics. Default false (no reverse proxy, e.g. local dev).
  trustProxy?: boolean | number
}
