import { describe, it, expect } from 'vitest'
import { base, baseSepolia } from 'viem/chains'
import { chainFor, rpcUrlFromEnv } from '../chains'

describe('chainFor', () => {
  it('selects Base mainnet for 8453', () => expect(chainFor(8453, 'http://x')).toBe(base))
  it('selects Base Sepolia for 84532', () => expect(chainFor(84532, 'http://x')).toBe(baseSepolia))
  it('builds a Local chain for anvil', () => {
    const c = chainFor(31337, 'http://127.0.0.1:8545')
    expect(c.id).toBe(31337)
    expect(c.name).toBe('Local')
    expect(c.rpcUrls.default.http).toEqual(['http://127.0.0.1:8545'])
  })
})

describe('rpcUrlFromEnv', () => {
  it('prefers RPC_URL', () => expect(rpcUrlFromEnv({ RPC_URL: 'a', BASE_SEPOLIA_RPC_URL: 'b' })).toBe('a'))
  it('falls back to BASE_SEPOLIA_RPC_URL', () => expect(rpcUrlFromEnv({ BASE_SEPOLIA_RPC_URL: 'b' })).toBe('b'))
  it('ignores blank RPC_URL', () => expect(rpcUrlFromEnv({ RPC_URL: ' ', BASE_SEPOLIA_RPC_URL: 'b' })).toBe('b'))
  it('is undefined when neither set', () => expect(rpcUrlFromEnv({})).toBeUndefined())
})
