// Canonical CreditMarket + ERC20 ABIs shared across TradePanel, PositionCard, and the
// portfolio page. Keeping one copy avoids drift between call sites — signatures below are
// taken directly from contracts/src/CreditMarket.sol (v1b1).

export const CREDIT_MARKET_ABI = [
  // ── mutating ────────────────────────────────────────────────────────────────
  {
    name: 'mint',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'usdcAmount', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'redeem',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'tokenAmount', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'settleYES',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'amount', type: 'uint256' }],
    outputs: [],
  },
  {
    name: 'cure',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [],
    outputs: [],
  },
  // ── freeze / funding-debt state ─────────────────────────────────────────────
  {
    name: 'claimable',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'frozenFunding',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'fundingDebt',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'previewFunding',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'user',   type: 'address' },
      { name: 'amount', type: 'uint256' },
      { name: 'isYes',  type: 'bool' },
    ],
    outputs: [{ name: 'delta', type: 'int256' }],
  },
  // ── v1b display-layer views ─────────────────────────────────────────────────
  {
    name: 'costBasis',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'equity',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'pnl',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'int256' }],
  },
  {
    name: 'breakevenMark',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'epochsToExpire',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'isSeizable',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'user', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  // ── market state (needed for client-side cure-cost projection) ─────────────
  {
    name: 'currentMark',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'creditEventConfirmed',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'cumFundingPerNO',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'lastFundingTime',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'snapNO',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

export const ERC20_ABI = [
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
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount',  type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner',   type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

// ── Shared funding-debit math ──────────────────────────────────────────────────

// `previewFunding` returns a signed net delta (positive = net credit, negative = net
// debit) projected to "now" — NOT freeze-aware and NOT folded with the persistent
// `fundingDebt` ledger. Both CLOBSettlement's on-chain check and the order-book
// server's pre-filter fold the ledger in before comparing against trade proceeds, so
// the frontend must mirror that: net debit D = fundingDebt − previewDelta, clamped at 0
// (a net credit reduces or can fully offset outstanding fundingDebt; it never goes
// negative — a surplus credit is paid out in cash, not carried as a display debit).
export function netFundingDebit(previewDelta: bigint, fundingDebt: bigint): bigint {
  const debit = fundingDebt - previewDelta
  return debit > 0n ? debit : 0n
}
