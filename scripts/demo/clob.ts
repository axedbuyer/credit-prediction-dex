// Order construction / signing / REST posting helpers for the demo seed script.
// Mirrors backend/order-book-server/src/validation.ts's EIP-712 type set exactly.
import { privateKeyToAccount } from 'viem/accounts'
import type { Address, Hex } from 'viem'
import type { DemoAccount } from './wallets'

export const ORDER_TYPES = {
  Order: [
    { name: 'maker', type: 'address' },
    { name: 'tokenIn', type: 'address' },
    { name: 'tokenOut', type: 'address' },
    { name: 'amountIn', type: 'uint256' },
    { name: 'minAmountOut', type: 'uint256' },
    { name: 'expiry', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
} as const

export interface OrderInput {
  maker: Address
  tokenIn: Address
  tokenOut: Address
  amountIn: bigint
  minAmountOut: bigint
  expiry: bigint
  nonce: bigint
}

let nonceCounter = BigInt(Date.now()) * 1_000_000n

// Monotonic per-process nonce — unique across every order this script signs,
// which is all that matters (CLOBSettlement dedups per-maker, per-nonce).
export function nextNonce(): bigint {
  nonceCounter += 1n
  return nonceCounter
}

export async function signOrder(
  account: DemoAccount,
  order: OrderInput,
  chainId: number,
  clobSettlementAddress: Address,
): Promise<Hex> {
  const localAccount = privateKeyToAccount(account.privateKey)
  return localAccount.signTypedData({
    domain: {
      name: 'CLOBSettlement',
      version: '1',
      chainId,
      verifyingContract: clobSettlementAddress,
    },
    types: ORDER_TYPES,
    primaryType: 'Order',
    message: order,
  })
}

export interface WireOrder {
  maker: string
  tokenIn: string
  tokenOut: string
  amountIn: string
  minAmountOut: string
  expiry: string
  nonce: string
  signature: string
}

export function toWire(order: OrderInput, signature: Hex): WireOrder {
  return {
    maker: order.maker,
    tokenIn: order.tokenIn,
    tokenOut: order.tokenOut,
    amountIn: order.amountIn.toString(),
    minAmountOut: order.minAmountOut.toString(),
    expiry: order.expiry.toString(),
    nonce: order.nonce.toString(),
    signature,
  }
}

export async function postOrder(orderBookUrl: string, wire: WireOrder): Promise<{ orderId?: string; error?: string; status: number }> {
  const res = await fetch(`${orderBookUrl}/order`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(wire),
  })
  const body = (await res.json().catch(() => ({}))) as { orderId?: string; error?: string }
  return { ...body, status: res.status }
}

export async function getOrderBook(orderBookUrl: string): Promise<{ bids: WireOrder[]; asks: WireOrder[] }> {
  const res = await fetch(`${orderBookUrl}/orderbook`)
  return res.json() as Promise<{ bids: WireOrder[]; asks: WireOrder[] }>
}

export async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Polls a predicate until it returns true or the timeout elapses.
export async function waitUntil(
  predicate: () => Promise<boolean>,
  { timeoutMs = 20_000, intervalMs = 400, label = 'condition' }: { timeoutMs?: number; intervalMs?: number; label?: string } = {},
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return
    await sleep(intervalMs)
  }
  throw new Error(`waitUntil timed out waiting for: ${label}`)
}
