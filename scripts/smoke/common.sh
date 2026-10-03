#!/usr/bin/env bash
# Shared constants for the multi-market smoke (sourced by multi-market-up.sh / -down.sh / svc.sh).
# ISOLATION: only ever use the ports below. The user's own services live on 8545-8547,
# 6379/6380, 3000-3003 and 3010-3013 — never touch them.
SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SMOKE_DIR/../.." && pwd)"
RUN_DIR="${SMOKE_RUN_DIR:-$SMOKE_DIR/.run}"
FOUNDRY_BIN="$HOME/.foundry/bin"
FORGE="$FOUNDRY_BIN/forge"; ANVIL="$FOUNDRY_BIN/anvil"; CAST="$FOUNDRY_BIN/cast"

ANVIL_PORT=8549
REDIS_PORT=6392
ORDER_BOOK_PORT=3021
FUNDING_HEALTH_PORT=3022
LIQ_KEEPER_PORT=3023
BOT_HEALTH_PORT=3024
CHAIN_ID=84532
RPC_URL="http://127.0.0.1:${ANVIL_PORT}"
ORDER_BOOK_URL="http://127.0.0.1:${ORDER_BOOK_PORT}"

# anvil default keys (public, local-only)
K0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # #0 deployer/admin/attester/team
K1=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d   # #1 keeper
K2=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a   # #2 settler
K3=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6   # #3 liquidator bot
KEEPER_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8                  # #1

SERVICES="order-book-server matching-engine funding-keeper liquidation-keeper liquidator-bot"
