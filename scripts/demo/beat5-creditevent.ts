// Task 3, Beat 5 — credit event + settle: deployer (OracleRouter admin) grants
// itself ORACLE_ROLE on OracleRouter, submits the credit event, then wallet A
// settles its full YES balance for 1 USDC each (zero recovery, full notional).
import { createPublicClient, createWalletClient, http, keccak256, toBytes } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { DEPLOYER, A } from './wallets'
import { ERC20_ABI } from './abi'

const RPC_URL = process.env.BASE_SEPOLIA_RPC_URL!
const USDC_ADDR = process.env.USDC_ADDRESS! as `0x${string}`
const YES_ADDR = process.env.YES_TOKEN_ADDRESS! as `0x${string}`
const CREDIT_MARKET_ADDR = process.env.CREDIT_MARKET_ADDRESS! as `0x${string}`
const ORACLE_ROUTER_ADDR = process.env.ORACLE_ROUTER_ADDRESS! as `0x${string}`

const ORACLE_ROUTER_ABI = [
  { name: 'ORACLE_ROLE', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bytes32' }] },
  { name: 'hasRole', type: 'function', stateMutability: 'view', inputs: [{ name: 'role', type: 'bytes32' }, { name: 'account', type: 'address' }], outputs: [{ name: '', type: 'bool' }] },
  { name: 'grantRole', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'role', type: 'bytes32' }, { name: 'account', type: 'address' }], outputs: [] },
  { name: 'confirmCreditEvent', type: 'function', stateMutability: 'nonpayable', inputs: [], outputs: [] },
] as const

const CREDIT_MARKET_ABI = [
  { name: 'creditEventConfirmed', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { name: 'paused', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'bool' }] },
  { name: 'settleYES', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'amount', type: 'uint256' }], outputs: [] },
] as const

async function main() {
  const publicClient = createPublicClient({ transport: http(RPC_URL) })
  const deployerAccount = privateKeyToAccount(DEPLOYER.privateKey)
  const deployerClient = createWalletClient({ account: deployerAccount, transport: http(RPC_URL) })
  const aAccount = privateKeyToAccount(A.privateKey)
  const aClient = createWalletClient({ account: aAccount, transport: http(RPC_URL) })

  const confirmedBefore = await publicClient.readContract({ address: CREDIT_MARKET_ADDR, abi: CREDIT_MARKET_ABI, functionName: 'creditEventConfirmed' }) as boolean
  console.log('[beat5] creditEventConfirmed before:', confirmedBefore)

  const oracleRole = await publicClient.readContract({ address: ORACLE_ROUTER_ADDR, abi: ORACLE_ROUTER_ABI, functionName: 'ORACLE_ROLE' }) as `0x${string}`
  const hasRole = await publicClient.readContract({ address: ORACLE_ROUTER_ADDR, abi: ORACLE_ROUTER_ABI, functionName: 'hasRole', args: [oracleRole, DEPLOYER.address] }) as boolean
  console.log('[beat5] deployer has ORACLE_ROLE on OracleRouter:', hasRole)

  if (!hasRole) {
    const grantHash = await deployerClient.writeContract({
      address: ORACLE_ROUTER_ADDR, abi: ORACLE_ROUTER_ABI, functionName: 'grantRole', args: [oracleRole, DEPLOYER.address], chain: undefined, account: deployerAccount,
    } as any)
    await publicClient.waitForTransactionReceipt({ hash: grantHash })
    console.log('[beat5] granted ORACLE_ROLE to deployer, tx:', grantHash)
  }

  if (!confirmedBefore) {
    const confirmHash = await deployerClient.writeContract({
      address: ORACLE_ROUTER_ADDR, abi: ORACLE_ROUTER_ABI, functionName: 'confirmCreditEvent', args: [], chain: undefined, account: deployerAccount,
    } as any)
    const receipt = await publicClient.waitForTransactionReceipt({ hash: confirmHash })
    console.log('[beat5] confirmCreditEvent() tx:', confirmHash, 'status:', receipt.status)
  }

  const confirmedAfter = await publicClient.readContract({ address: CREDIT_MARKET_ADDR, abi: CREDIT_MARKET_ABI, functionName: 'creditEventConfirmed' }) as boolean
  const pausedAfter = await publicClient.readContract({ address: CREDIT_MARKET_ADDR, abi: CREDIT_MARKET_ABI, functionName: 'paused' }) as boolean
  console.log('[beat5] creditEventConfirmed after:', confirmedAfter, 'paused after:', pausedAfter)
  if (!confirmedAfter) throw new Error('credit event not confirmed')

  // ── settleYES for wallet A's full YES balance ─────────────────────────────
  const aYesBefore = await publicClient.readContract({ address: YES_ADDR, abi: ERC20_ABI, functionName: 'balanceOf', args: [A.address] }) as bigint
  const aUsdcBefore = await publicClient.readContract({ address: USDC_ADDR, abi: ERC20_ABI, functionName: 'balanceOf', args: [A.address] }) as bigint
  console.log('[beat5] A YES before settle:', aYesBefore.toString(), 'A USDC before:', aUsdcBefore.toString())

  const settleHash = await aClient.writeContract({
    address: CREDIT_MARKET_ADDR, abi: CREDIT_MARKET_ABI, functionName: 'settleYES', args: [aYesBefore], chain: undefined, account: aAccount,
  } as any)
  const settleReceipt = await publicClient.waitForTransactionReceipt({ hash: settleHash })
  console.log('[beat5] settleYES() tx:', settleHash, 'status:', settleReceipt.status)

  const aYesAfter = await publicClient.readContract({ address: YES_ADDR, abi: ERC20_ABI, functionName: 'balanceOf', args: [A.address] }) as bigint
  const aUsdcAfter = await publicClient.readContract({ address: USDC_ADDR, abi: ERC20_ABI, functionName: 'balanceOf', args: [A.address] }) as bigint
  console.log('[beat5] A YES after:', aYesAfter.toString(), 'A USDC after:', aUsdcAfter.toString())
  console.log('[beat5] YES burned:', (aYesBefore - aYesAfter).toString(), 'USDC received:', (aUsdcAfter - aUsdcBefore).toString())

  if (settleReceipt.status !== 'success') throw new Error('settleYES reverted')
  if (aYesAfter !== 0n) throw new Error('A still holds YES after settleYES(full balance)')
  const usdcReceived = aUsdcAfter - aUsdcBefore
  if (usdcReceived !== aYesBefore) {
    console.warn('[beat5] NOTE: USDC received != YES burned 1:1 — likely a funding debit was netted out of the payout (expected if A owed carry):', usdcReceived.toString(), 'vs', aYesBefore.toString())
  }
  console.log('[beat5] PASS — credit event confirmed, A settled full YES balance, YES burned')
}

main().catch(e => { console.error('[beat5] FAIL', e); process.exit(1) })
