// MarketRegistry ABI + market shapes for the frontend.
//
// CANONICAL SOURCE: backend/shared/registry.ts (MARKET_REGISTRY_ABI, MarketInfo,
// EntityType). The ABI constant below is a verbatim copy — if the registry contract
// changes, re-copy from there. (The frontend has its own build context, so it cannot
// import from backend/.)
//
// On-chain `entityType` is a uint8 enum: 0 = corporate, 1 = sovereign.

export type Hex = `0x${string}`

export const MARKET_REGISTRY_ABI = [
  {
    "type": "function",
    "name": "allMarkets",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "tuple[]",
        "internalType": "struct MarketRegistry.Market[]",
        "components": [
          {
            "name": "slug",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "entityName",
            "type": "string",
            "internalType": "string"
          },
          {
            "name": "entityType",
            "type": "uint8",
            "internalType": "enum MarketRegistry.EntityType"
          },
          {
            "name": "creditMarket",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "yesToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "noToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "clobSettlement",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "oracleRouter",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "liquidationEngine",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "active",
            "type": "bool",
            "internalType": "bool"
          },
          {
            "name": "registeredAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "startBlock",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "insuranceFund",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "isRegisteredAddress",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "marketCount",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "marketIdOf",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "usdc",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "MarketActiveSet",
    "inputs": [
      {
        "name": "marketId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "active",
        "type": "bool",
        "indexed": false,
        "internalType": "bool"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MarketRegistered",
    "inputs": [
      {
        "name": "marketId",
        "type": "uint256",
        "indexed": true,
        "internalType": "uint256"
      },
      {
        "name": "slug",
        "type": "string",
        "indexed": false,
        "internalType": "string"
      },
      {
        "name": "creditMarket",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "yesToken",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "noToken",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "clobSettlement",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "oracleRouter",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "liquidationEngine",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  }
] as const

export type EntityType = 'corporate' | 'sovereign'

export interface MarketInfo {
  id: number
  slug: string
  entityName: string
  entityType: EntityType
  creditMarket: Hex
  yesToken: Hex
  noToken: Hex
  clobSettlement: Hex
  oracleRouter: Hex
  liquidationEngine: Hex
  active: boolean
  registeredAt: bigint
  startBlock: bigint
}

// Raw tuple as returned by wagmi/viem for allMarkets().
interface RawMarket {
  slug: string
  entityName: string
  entityType: number
  creditMarket: Hex
  yesToken: Hex
  noToken: Hex
  clobSettlement: Hex
  oracleRouter: Hex
  liquidationEngine: Hex
  active: boolean
  registeredAt: bigint
  startBlock: bigint
}

export function parseRegistryMarkets(raw: readonly RawMarket[]): MarketInfo[] {
  return raw.map((m, i) => ({
    id: i,
    slug: m.slug,
    entityName: m.entityName,
    entityType: m.entityType === 1 ? 'sovereign' : 'corporate',
    creditMarket: m.creditMarket,
    yesToken: m.yesToken,
    noToken: m.noToken,
    clobSettlement: m.clobSettlement,
    oracleRouter: m.oracleRouter,
    liquidationEngine: m.liquidationEngine,
    active: m.active,
    registeredAt: m.registeredAt,
    startBlock: m.startBlock,
  }))
}
