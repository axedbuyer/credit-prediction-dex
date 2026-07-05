// One-off verification script for Gap 1 (Multicall3 etched onto the demo
// anvil). Not part of the demo boot sequence — run manually to prove
// useReadContracts-style batched calls work against the demo chain.
// Usage: (from scripts/demo, with the stack up) ./node_modules/.bin/tsx verify-multicall.ts
import { createPublicClient, http } from 'viem'
import { baseSepolia } from 'viem/chains'
import { CREDIT_MARKET_ABI } from './abi'

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8547'
const CREDIT_MARKET_ADDR = process.env.CREDIT_MARKET_ADDR as `0x${string}`

async function main() {
  if (!CREDIT_MARKET_ADDR) throw new Error('CREDIT_MARKET_ADDR not set — source .run/env.sh first')

  const client = createPublicClient({ chain: baseSepolia, transport: http(RPC_URL) })

  const results = await client.multicall({
    contracts: [
      { address: CREDIT_MARKET_ADDR, abi: CREDIT_MARKET_ABI, functionName: 'currentMark' },
      { address: CREDIT_MARKET_ADDR, abi: CREDIT_MARKET_ABI, functionName: 'cumulativeFundingPerYES' },
    ],
  })

  console.log('multicall results:', results)

  for (const r of results) {
    if (r.status !== 'success') throw new Error(`multicall leg failed: ${JSON.stringify(r)}`)
  }
  console.log('OK — Multicall3 is present and functional on the demo chain')
}

main().catch(e => { console.error(e); process.exit(1) })
