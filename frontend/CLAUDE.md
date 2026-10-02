# Frontend Context

Parent spec: see root CLAUDE.md

## Stack
Next.js 14 App Router, TypeScript, wagmi v2, viem, RainbowKit, Tailwind CSS
TradingView Lightweight Charts

## Chain config
Base Sepolia chainId: 84532
Base mainnet chainId: 8453

## Key rule
Product name is **Pari**. Never show "YES/NO", "token", "hazard rate", "bps", "notional"
in UI — YES/NO are internal names only (code, ABIs, API fields keep yes/no).
Use: "Upbet" (= YES, color --color-danger), "Downbet" (= NO, color --color-teal),
"X% annual probability", "Daily carry".
Design system: frontend/styles/pari/{tokens,components}.css — use CSS tokens or the
Tailwind bridge (bg-surface-1, text-text-2, border-brand…); never hardcode hex, never
use Inter/Roboto/emoji. Direction A (.pari-a-*) = nav/landing/portfolio; Direction B
(.pari-b-*) = market/orderbook/trade/liquidate.
Read positions via YES.balanceOf(address) and NO.balanceOf(address).

## Do not build
Mobile layout, fee distributor UI, market listing UI, LP vault UI

## Multi-market structure (D5: registry-driven discovery)
- `lib/marketRegistry.ts` — MarketRegistry ABI + `MarketInfo` (verbatim copy from the
  canonical `backend/shared/registry.ts`; re-copy on contract change).
- `lib/markets.ts` — THE market source: `useMarkets()`, `useMarket(slug)`,
  `useActiveMarkets()`. Reads `allMarkets()` from `NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS`;
  if unset, legacy mode synthesizes one market `mstr` from the old single-market
  `NEXT_PUBLIC_*` address vars. Nothing else may read `CONTRACT_ADDRESSES` directly.
- `lib/marketCopy.ts` — long-form copy keyed by slug (legal name, ticker, credit events)
  with entityType fallbacks, so a newly registered market renders without a rebuild.
  The ONLY place entity names live; display name = registry `entityName`.
- Routes: `/` market list; `/market/[id]` (id = slug); `/portfolio` aggregates all
  markets; `/liquidate` flagged positions across markets (claim → that market's
  LiquidationEngine); `/admin` has a market picker.
- Components take a `market: Market` prop. TradePanel signs with the EIP-712
  `verifyingContract` AND token addresses from the SAME market object (CLOBSettlement
  doesn't validate that tokens belong to its market); `useFeeBps(clobAddress)` is per market.
- Order book: `GET /orderbook?market=<slug>`; liquidation keeper:
  `GET /claimable[?market=<slug>]` (entries carry `market`, `creditMarket`, `liquidationEngine`).
