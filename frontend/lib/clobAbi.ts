// CLOBSettlement cancel surface (batch 3). Copy of contracts/src/CLOBSettlement.sol:
// cancelOrders(Order[]) — maker only, marks each order fully filled;
// setMinNonce(n) — retires every order of msg.sender with nonce < n (n must increase).

const ORDER_COMPONENTS = [
  { name: 'maker', type: 'address' },
  { name: 'tokenIn', type: 'address' },
  { name: 'tokenOut', type: 'address' },
  { name: 'amountIn', type: 'uint256' },
  { name: 'minAmountOut', type: 'uint256' },
  { name: 'expiry', type: 'uint256' },
  { name: 'nonce', type: 'uint256' },
] as const

export const CLOB_CANCEL_ABI = [
  {
    name: 'cancelOrders',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'orders', type: 'tuple[]', components: ORDER_COMPONENTS }],
    outputs: [],
  },
  {
    name: 'setMinNonce',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'newMinNonce', type: 'uint256' }],
    outputs: [],
  },
] as const
