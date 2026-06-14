import { verifyTypedData } from 'viem'
import type { Address, Hex } from 'viem'
import type { Order } from './types'

// EIP-712 type definitions — must mirror CLOBSettlement.sol exactly
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

const CANCEL_TYPES = {
  CancelOrder: [
    { name: 'orderId', type: 'string' },
  ],
} as const

function domain(chainId: number, verifyingContract: Address) {
  return {
    name: 'CLOBSettlement',
    version: '1',
    chainId,
    verifyingContract,
  } as const
}

export async function verifyOrderSignature(
  order: Order,
  chainId: number,
  verifyingContract: Address,
): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: order.maker,
      domain: domain(chainId, verifyingContract),
      types: ORDER_TYPES,
      primaryType: 'Order',
      message: {
        maker: order.maker,
        tokenIn: order.tokenIn,
        tokenOut: order.tokenOut,
        amountIn: order.amountIn,
        minAmountOut: order.minAmountOut,
        expiry: order.expiry,
        nonce: order.nonce,
      },
      signature: order.signature,
    })
  } catch {
    return false
  }
}

export async function verifyCancelSignature(
  maker: Address,
  orderId: string,
  signature: Hex,
  chainId: number,
  verifyingContract: Address,
): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: maker,
      domain: domain(chainId, verifyingContract),
      types: CANCEL_TYPES,
      primaryType: 'CancelOrder',
      message: { orderId },
      signature,
    })
  } catch {
    return false
  }
}
