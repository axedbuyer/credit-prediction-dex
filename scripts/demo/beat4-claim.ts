// Task 3, Beat 4 — liquidation claim: wallet A (permissionless) claims wallet
// D's (Doomed Upbet) flagged position via LiquidationEngine.claim(user).
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { A, D } from './wallets'
import { ERC20_ABI, CREDIT_MARKET_ABI } from './abi'

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL!
const USDC_ADDR = process.env.USDC_ADDRESS! as `0x${string}`
const YES_ADDR = process.env.YES_TOKEN_ADDRESS! as `0x${string}`
const NO_ADDR = process.env.NO_TOKEN_ADDRESS! as `0x${string}`
const CREDIT_MARKET_ADDR = process.env.CREDIT_MARKET_ADDRESS! as `0x${string}`
const LIQUIDATION_ADDR = process.env.LIQUIDATION_ENGINE_ADDRESS! as `0x${string}`

const APPROVE_ABI = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }], outputs: [{ name: '', type: 'uint256' }] },
] as const

const CLAIM_ABI = [
  { name: 'claim', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'user', type: 'address' }], outputs: [] },
] as const

async function main() {
  const publicClient = createPublicClient({ transport: http(RPC_URL) })
  const account = privateKeyToAccount(A.privateKey)
  const walletClient = createWalletClient({ account, transport: http(RPC_URL) })

  const dYesBefore = await publicClient.readContract({ address: YES_ADDR, abi: ERC20_ABI, functionName: 'balanceOf', args: [D.address] }) as bigint
  const aYesBefore = await publicClient.readContract({ address: YES_ADDR, abi: ERC20_ABI, functionName: 'balanceOf', args: [A.address] }) as bigint
  const aUsdcBefore = await publicClient.readContract({ address: USDC_ADDR, abi: ERC20_ABI, functionName: 'balanceOf', args: [A.address] }) as bigint
  const dClaimableBefore = await publicClient.readContract({ address: CREDIT_MARKET_ADDR, abi: CREDIT_MARKET_ABI, functionName: 'claimable', args: [D.address] }) as boolean
  const yesSupplyBefore = await publicClient.readContract({ address: YES_ADDR, abi: [{ name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] }], functionName: 'totalSupply' }) as bigint
  const noSupplyBefore = await publicClient.readContract({ address: NO_ADDR, abi: [{ name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] }], functionName: 'totalSupply' }) as bigint

  console.log('[beat4] D claimable before:', dClaimableBefore, 'D YES before:', dYesBefore.toString())
  console.log('[beat4] A YES before:', aYesBefore.toString(), 'A USDC before:', aUsdcBefore.toString())
  console.log('[beat4] YES totalSupply before:', yesSupplyBefore.toString(), 'NO totalSupply before:', noSupplyBefore.toString())

  const allowance = await publicClient.readContract({ address: USDC_ADDR, abi: APPROVE_ABI, functionName: 'allowance', args: [A.address, LIQUIDATION_ADDR] }) as bigint
  if (allowance < 1_000_000_000n) {
    console.log('[beat4] approving USDC to LiquidationEngine...')
    const approveHash = await walletClient.writeContract({
      address: USDC_ADDR, abi: APPROVE_ABI, functionName: 'approve', args: [LIQUIDATION_ADDR, 2n ** 256n - 1n], chain: undefined, account,
    } as any)
    await publicClient.waitForTransactionReceipt({ hash: approveHash })
    console.log('[beat4] approve tx:', approveHash)
  }

  const claimHash = await walletClient.writeContract({
    address: LIQUIDATION_ADDR, abi: CLAIM_ABI, functionName: 'claim', args: [D.address], chain: undefined, account,
  } as any)
  const receipt = await publicClient.waitForTransactionReceipt({ hash: claimHash })
  console.log('[beat4] claim() tx:', claimHash, 'status:', receipt.status)

  const dYesAfter = await publicClient.readContract({ address: YES_ADDR, abi: ERC20_ABI, functionName: 'balanceOf', args: [D.address] }) as bigint
  const aYesAfter = await publicClient.readContract({ address: YES_ADDR, abi: ERC20_ABI, functionName: 'balanceOf', args: [A.address] }) as bigint
  const aUsdcAfter = await publicClient.readContract({ address: USDC_ADDR, abi: ERC20_ABI, functionName: 'balanceOf', args: [A.address] }) as bigint
  const dClaimableAfter = await publicClient.readContract({ address: CREDIT_MARKET_ADDR, abi: CREDIT_MARKET_ABI, functionName: 'claimable', args: [D.address] }) as boolean
  const yesSupplyAfter = await publicClient.readContract({ address: YES_ADDR, abi: [{ name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] }], functionName: 'totalSupply' }) as bigint
  const noSupplyAfter = await publicClient.readContract({ address: NO_ADDR, abi: [{ name: 'totalSupply', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] }], functionName: 'totalSupply' }) as bigint

  console.log('[beat4] D claimable after:', dClaimableAfter, 'D YES after:', dYesAfter.toString())
  console.log('[beat4] A YES after:', aYesAfter.toString(), '(delta:', (aYesAfter - aYesBefore).toString(), ')')
  console.log('[beat4] A USDC after:', aUsdcAfter.toString(), '(paid:', (aUsdcBefore - aUsdcAfter).toString(), ')')
  console.log('[beat4] YES totalSupply after:', yesSupplyAfter.toString(), 'NO totalSupply after:', noSupplyAfter.toString())

  if (receipt.status !== 'success') throw new Error('claim() reverted')
  if (dClaimableAfter) throw new Error('D still claimable after claim()')
  if (dYesAfter !== 0n) throw new Error('D still holds YES after claim()')
  if (yesSupplyAfter !== yesSupplyBefore) throw new Error('YES totalSupply changed — should be transfer-only, never burn')
  if (yesSupplyAfter !== noSupplyAfter) throw new Error('YES/NO totalSupply diverged')
  console.log('[beat4] PASS — D YES transferred to A, D removed from claimable, YES==NO supply invariant holds')
}

main().catch(e => { console.error('[beat4] FAIL', e); process.exit(1) })
