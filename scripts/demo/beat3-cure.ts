// Task 3, Beat 3 — cure: wallet C (Distressed Upbet) pays its frozen funding
// obligation in cash via CreditMarket.cure(), unfreezing the position.
import { createPublicClient, createWalletClient, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { C } from './wallets'
import { ERC20_ABI, CREDIT_MARKET_ABI } from './abi'

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL!
const USDC_ADDR = process.env.USDC_ADDRESS! as `0x${string}`
const CREDIT_MARKET_ADDR = process.env.CREDIT_MARKET_ADDRESS! as `0x${string}`

const CURE_ABI = [
  {
    name: 'cure', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [],
  },
  {
    name: 'fundingDebt', type: 'function', stateMutability: 'view',
    inputs: [{ name: '', type: 'address' }], outputs: [{ name: '', type: 'uint256' }],
  },
  {
    name: 'allowance', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'owner', type: 'address' }, { name: 'spender', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

async function main() {
  const publicClient = createPublicClient({ transport: http(RPC_URL) })
  const account = privateKeyToAccount(C.privateKey)
  const walletClient = createWalletClient({ account, transport: http(RPC_URL) })

  const claimableBefore = await publicClient.readContract({ address: CREDIT_MARKET_ADDR, abi: CREDIT_MARKET_ABI, functionName: 'claimable', args: [C.address] }) as boolean
  const seizableBefore = await publicClient.readContract({ address: CREDIT_MARKET_ADDR, abi: CREDIT_MARKET_ABI, functionName: 'isSeizable', args: [C.address] }) as boolean
  const usdcBefore = await publicClient.readContract({ address: USDC_ADDR, abi: ERC20_ABI, functionName: 'balanceOf', args: [C.address] }) as bigint
  const allowance = await publicClient.readContract({ address: USDC_ADDR, abi: CURE_ABI, functionName: 'allowance', args: [C.address, CREDIT_MARKET_ADDR] }) as bigint

  console.log('[beat3] C claimable before:', claimableBefore, 'isSeizable before:', seizableBefore)
  console.log('[beat3] C USDC before:', usdcBefore.toString(), 'USDC allowance to CreditMarket:', allowance.toString())

  if (allowance < 10_000_000_000n) {
    console.log('[beat3] approving USDC to CreditMarket...')
    const approveHash = await walletClient.writeContract({
      address: USDC_ADDR, abi: ERC20_ABI, functionName: 'approve',
      args: [CREDIT_MARKET_ADDR, 2n ** 256n - 1n], chain: undefined, account,
    } as any)
    await publicClient.waitForTransactionReceipt({ hash: approveHash })
    console.log('[beat3] approve tx:', approveHash)
  }

  const cureHash = await walletClient.writeContract({
    address: CREDIT_MARKET_ADDR, abi: CURE_ABI, functionName: 'cure', args: [], chain: undefined, account,
  } as any)
  const receipt = await publicClient.waitForTransactionReceipt({ hash: cureHash })
  console.log('[beat3] cure() tx:', cureHash, 'status:', receipt.status)

  const claimableAfter = await publicClient.readContract({ address: CREDIT_MARKET_ADDR, abi: CREDIT_MARKET_ABI, functionName: 'claimable', args: [C.address] }) as boolean
  const seizableAfter = await publicClient.readContract({ address: CREDIT_MARKET_ADDR, abi: CREDIT_MARKET_ABI, functionName: 'isSeizable', args: [C.address] }) as boolean
  const usdcAfter = await publicClient.readContract({ address: USDC_ADDR, abi: ERC20_ABI, functionName: 'balanceOf', args: [C.address] }) as bigint
  const fundingDebtAfter = await publicClient.readContract({ address: CREDIT_MARKET_ADDR, abi: CURE_ABI, functionName: 'fundingDebt', args: [C.address] }) as bigint

  console.log('[beat3] C claimable after:', claimableAfter, 'isSeizable after:', seizableAfter)
  console.log('[beat3] C USDC after:', usdcAfter.toString(), '(paid:', (usdcBefore - usdcAfter).toString(), ')')
  console.log('[beat3] C fundingDebt after:', fundingDebtAfter.toString())

  if (receipt.status !== 'success') throw new Error('cure() reverted')
  if (claimableAfter) throw new Error('C still claimable after cure()')
  console.log('[beat3] PASS — C no longer flagged, funding debt cleared')
}

main().catch(e => { console.error('[beat3] FAIL', e); process.exit(1) })
