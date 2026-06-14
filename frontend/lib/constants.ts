import { baseSepolia } from 'wagmi/chains'

export const MSTR_MARKET = {
  id: 'mstr',
  name: 'Will MicroStrategy have a credit event in the next 12 months?',
  entity: 'MicroStrategy Incorporated',
  ticker: 'MSTR',
  creditEvents: ['Bankruptcy', 'Failure to Pay'] as const,
  chainId: baseSepolia.id,
} as const

export const ORDER_BOOK_URL = process.env.NEXT_PUBLIC_ORDER_BOOK_URL ?? 'http://localhost:3001'
