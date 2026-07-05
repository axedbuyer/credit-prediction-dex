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