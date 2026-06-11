# Frontend Context

Parent spec: see root CLAUDE.md

## Stack
Next.js 14 App Router, TypeScript, wagmi v2, viem, RainbowKit, Tailwind CSS
TradingView Lightweight Charts

## Chain config
Base Sepolia chainId: 84532
Base mainnet chainId: 8453

## Key rule
Never show "YES/NO token", "hazard rate", "bps", "notional" in UI.
Use: "YES", "NO", "X% annual probability", "Daily carry".
Read positions via YES.balanceOf(address) and NO.balanceOf(address).

## Do not build
Mobile layout, fee distributor UI, market listing UI, LP vault UI