// Standard anvil default accounts (mnemonic "test test test test test test test
// test test test test junk", derivation path m/44'/60'/0'/0/<i>). These are
// public, well-known local-dev-only keys — verified against a live `anvil
// --chain-id 84532` startup banner while building this stack. NEVER use on a
// real network.
import type { Address, Hex } from 'viem'

export interface DemoAccount {
  label: string
  address: Address
  privateKey: Hex
}

export const DEPLOYER: DemoAccount = {
  label: 'Deployer (anvil #0)',
  address: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  privateKey: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
}

// NOTE: uses anvil account #9, not #1. Pre-existing orphaned matching-engine
// processes from an earlier, incomplete attempt at this same demo (discovered
// while building this stack — see docs/demo-runbook.md "Known environment
// quirks") are already running with SETTLER_PRIVATE_KEY = anvil #1, polling
// the exact same demo ports (8547/3011/6380). They could not be killed (no
// permission to terminate processes this session didn't start/track). Using a
// different account here avoids a tx-nonce race between that zombie and this
// script's own settler if both ever submit against the same account.
export const SETTLER: DemoAccount = {
  label: 'Settler / matching-engine (anvil #9)',
  address: '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720',
  privateKey: '0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6',
}

export const KEEPER: DemoAccount = {
  label: 'Keeper (anvil #2)',
  address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  privateKey: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
}

export const PRESENTER: DemoAccount = {
  label: 'Presenter (anvil #3)',
  address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  privateKey: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
}

export const MARKET_MAKER: DemoAccount = {
  label: 'Market Maker (anvil #4)',
  address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  privateKey: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
}

export const DISTRESSED_UPBET: DemoAccount = {
  label: 'Distressed Upbet (anvil #5)',
  address: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc',
  privateKey: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
}

export const DOOMED_UPBET: DemoAccount = {
  label: 'Doomed Upbet (anvil #6)',
  address: '0x976EA74026E726554dB657fA54763abd0C3a0aa9',
  privateKey: '0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e',
}

// A = Presenter, B = Market Maker, C = Distressed Upbet, D = Doomed Upbet
// (letters match the naming used in the demo brief / runbook)
export const A = PRESENTER
export const B = MARKET_MAKER
export const C = DISTRESSED_UPBET
export const D = DOOMED_UPBET
