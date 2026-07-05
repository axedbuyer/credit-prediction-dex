#!/usr/bin/env bash
# One-command local demo stack for Pari (credit prediction DEX) — brings up a
# fresh anvil chain, deploys contracts, starts every backend service on
# demo-only ports, seeds a full narrative (see seed-demo.ts), and starts the
# frontend pointed at the demo deployment. Leaves the user's own long-lived
# dev services (anvil :8545/:8546, order-book-server :3001, next dev :3000)
# completely untouched.
#
# Usage: ./demo-up.sh
# Teardown: ./demo-down.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUN_DIR="$SCRIPT_DIR/.run"
FOUNDRY_BIN="$HOME/.foundry/bin"
ANVIL="$FOUNDRY_BIN/anvil"
FORGE="$FOUNDRY_BIN/forge"
CAST="$FOUNDRY_BIN/cast"

DEPLOYMENTS_JSON="$REPO_ROOT/contracts/deployments/base-sepolia.json"
FRONTEND_ENV="$REPO_ROOT/frontend/.env.local"

# ─── demo ports (never the user's own dev ports) ──────────────────────────────
ANVIL_PORT=8547
REDIS_PORT=6380
FRONTEND_PORT=3010
ORDER_BOOK_PORT=3011
FUNDING_KEEPER_HEALTH_PORT=3012
LIQUIDATION_KEEPER_PORT=3013
CHAIN_ID=84532
RPC_URL="http://127.0.0.1:${ANVIL_PORT}"
ORDER_BOOK_URL="http://localhost:${ORDER_BOOK_PORT}"
LIQUIDATION_KEEPER_URL="http://localhost:${LIQUIDATION_KEEPER_PORT}"

# ─── well-known anvil dev accounts (verified against a live anvil banner —
# see scripts/demo/wallets.ts for the same constants used by seed-demo.ts) ────
DEPLOYER_ADDR="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
DEPLOYER_KEY="0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
SETTLER_ADDR="0xa0Ee7A142d267C1f36714E4a8F75612F20a79720"     # anvil #9 — see wallets.ts for why not #1
SETTLER_KEY="0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6"
KEEPER_ADDR="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"      # anvil #2
KEEPER_KEY="0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a"
A_ADDR="0x90F79bf6EB2c4f870365E785982E1f101E93b906"           # anvil #3 — Presenter
A_KEY="0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6"
B_ADDR="0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65"           # anvil #4 — Market Maker
B_KEY="0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a"
C_ADDR="0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc"           # anvil #5 — Distressed Upbet
C_KEY="0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba"
D_ADDR="0x976EA74026E726554dB657fA54763abd0C3a0aa9"           # anvil #6 — Doomed Upbet
D_KEY="0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"

log() { printf '\n\033[1;36m[demo-up]\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[demo-up][warn]\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m[demo-up][error]\033[0m %s\n' "$1"; exit 1; }

wait_for_port() {
  local host="$1" port="$2" label="$3" tries="${4:-60}"
  for ((i = 0; i < tries; i++)); do
    if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then exec 3>&- 3<&-; return 0; fi
    sleep 0.5
  done
  fail "$label did not open $host:$port within $((tries / 2))s"
}

wait_for_http() {
  local url="$1" label="$2" tries="${3:-60}"
  for ((i = 0; i < tries; i++)); do
    if curl -sf -o /dev/null "$url"; then return 0; fi
    sleep 0.5
  done
  fail "$label did not respond at $url within $((tries / 2))s"
}

port_busy() {
  local port="$1"
  ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${port}\$"
}

# ─── 0. preflight ──────────────────────────────────────────────────────────────
log "preflight checks"

[[ -x "$ANVIL" ]] || fail "anvil not found at $ANVIL"
[[ -x "$FORGE" ]] || fail "forge not found at $FORGE"
[[ -x "$CAST"  ]] || fail "cast not found at $CAST"
command -v node >/dev/null || fail "node not found on PATH"
command -v npx  >/dev/null || fail "npx not found on PATH"
command -v redis-cli >/dev/null || fail "redis-cli not found on PATH"
command -v curl >/dev/null || fail "curl not found on PATH"

for p in "$ANVIL_PORT" "$FRONTEND_PORT" "$ORDER_BOOK_PORT" "$FUNDING_KEEPER_HEALTH_PORT" "$LIQUIDATION_KEEPER_PORT"; do
  port_busy "$p" && fail "port $p is already in use — run demo-down.sh first, or free it manually"
done
log "demo ports (${ANVIL_PORT},${FRONTEND_PORT},${ORDER_BOOK_PORT},${FUNDING_KEEPER_HEALTH_PORT},${LIQUIDATION_KEEPER_PORT}) are free"

REUSE_REDIS=0
if port_busy "$REDIS_PORT"; then
  if redis-cli -p "$REDIS_PORT" ping 2>/dev/null | grep -q PONG; then
    warn "port $REDIS_PORT already serves a working redis — reusing it (not started by this script, will NOT be killed by demo-down.sh). Flushing it for a clean seed."
    redis-cli -p "$REDIS_PORT" flushall >/dev/null
    REUSE_REDIS=1
  else
    fail "port $REDIS_PORT is busy with something that isn't redis — free it manually"
  fi
fi

rm -rf "$RUN_DIR"
mkdir -p "$RUN_DIR"

# scripts/demo needs its own node_modules (tsx module-resolution quirk — see
# root CLAUDE.md brief). Try a real install; if the network is unreachable
# (observed in this sandbox), fall back to symlinking backend/matching-engine's
# node_modules, which already vendors the same viem+tsx versions.
if [[ ! -d "$SCRIPT_DIR/node_modules" ]]; then
  log "installing scripts/demo dependencies (viem, tsx)"
  if ! (cd "$SCRIPT_DIR" && npm install --no-audit --no-fund >"$RUN_DIR/npm-install.log" 2>&1); then
    warn "npm install failed (likely no network) — falling back to a symlink onto backend/matching-engine/node_modules"
    rm -rf "$SCRIPT_DIR/node_modules" "$SCRIPT_DIR/package-lock.json"
    ln -s "../../backend/matching-engine/node_modules" "$SCRIPT_DIR/node_modules"
  fi
fi
[[ -d "$SCRIPT_DIR/node_modules/viem" ]] || fail "scripts/demo/node_modules/viem missing — install dependencies manually"

# ─── 1. anvil ──────────────────────────────────────────────────────────────────
log "starting anvil --chain-id $CHAIN_ID --port $ANVIL_PORT"
nohup "$ANVIL" --chain-id "$CHAIN_ID" --port "$ANVIL_PORT" >"$RUN_DIR/anvil.log" 2>&1 &
echo $! >"$RUN_DIR/anvil.pid"
wait_for_port 127.0.0.1 "$ANVIL_PORT" "anvil"
log "anvil up (pid $(cat "$RUN_DIR/anvil.pid"))"

# Etch Multicall3 onto the demo chain. Real Base Sepolia (and every chain in
# viem's default chain list) has Multicall3 predeployed at this canonical
# CREATE2 address; a bare `anvil` does not. wagmi's useReadContracts batches
# through it, so without this step /portfolio, PositionCard, and /admin
# silently render blank values on the demo chain. Bytecode in
# scripts/demo/multicall3.bytecode is the exact runtime code fetched via
# `cast code 0xcA11bde05977b3631167028862bE2a173976CA11` against a public
# mainnet RPC (identical bytecode on every chain that has it deployed);
# vendored here so future boots work offline.
MULTICALL3_ADDR="0xcA11bde05977b3631167028862bE2a173976CA11"
MULTICALL3_BYTECODE_FILE="$SCRIPT_DIR/multicall3.bytecode"
[[ -f "$MULTICALL3_BYTECODE_FILE" ]] || fail "missing $MULTICALL3_BYTECODE_FILE"
log "etching Multicall3 onto anvil at $MULTICALL3_ADDR"
"$CAST" rpc anvil_setCode "$MULTICALL3_ADDR" "$(cat "$MULTICALL3_BYTECODE_FILE")" --rpc-url "$RPC_URL" >"$RUN_DIR/multicall3-setcode.log" 2>&1 \
  || fail "anvil_setCode for Multicall3 failed — see $RUN_DIR/multicall3-setcode.log"
DEPLOYED_CODE="$("$CAST" code "$MULTICALL3_ADDR" --rpc-url "$RPC_URL")"
[[ "$DEPLOYED_CODE" != "0x" && -n "$DEPLOYED_CODE" ]] || fail "Multicall3 code did not stick at $MULTICALL3_ADDR"
log "Multicall3 present at $MULTICALL3_ADDR ($(( (${#DEPLOYED_CODE} - 2) / 2 )) bytes)"

# ─── 2. deploy contracts ───────────────────────────────────────────────────────
log "deploying contracts (DeployLocal)"
(
  cd "$REPO_ROOT/contracts"
  DEPLOYER_PRIVATE_KEY="$DEPLOYER_KEY" "$FORGE" script script/DeployLocal.s.sol \
    --tc DeployLocal --rpc-url "$RPC_URL" --broadcast
) >"$RUN_DIR/deploy.log" 2>&1 || { cat "$RUN_DIR/deploy.log"; fail "contract deployment failed — see $RUN_DIR/deploy.log"; }

BROADCAST_JSON="$REPO_ROOT/contracts/broadcast/DeployLocal.s.sol/${CHAIN_ID}/run-latest.json"
[[ -f "$BROADCAST_JSON" ]] || fail "broadcast file not found at $BROADCAST_JSON"

# Parse CREATE addresses by contract name (no jq in this environment).
eval "$(node -e '
const fs = require("fs");
const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const want = { MockUSDC: "USDC_ADDR", YESToken: "YES_ADDR", NOToken: "NO_ADDR", CreditMarket: "CREDIT_MARKET_ADDR", CLOBSettlement: "CLOB_ADDR", OracleRouter: "ORACLE_ADDR", InsuranceFund: "INSURANCE_ADDR", LiquidationEngine: "LIQUIDATION_ADDR" };
for (const tx of data.transactions) {
  if (tx.contractName && want[tx.contractName] && tx.contractAddress) {
    console.log(`${want[tx.contractName]}=${tx.contractAddress}`);
  }
}
' "$BROADCAST_JSON")"

for v in USDC_ADDR YES_ADDR NO_ADDR CREDIT_MARKET_ADDR CLOB_ADDR ORACLE_ADDR INSURANCE_ADDR LIQUIDATION_ADDR; do
  [[ -n "${!v:-}" ]] || fail "failed to parse $v from broadcast output"
done
log "deployed: USDC=$USDC_ADDR YES=$YES_ADDR NO=$NO_ADDR CreditMarket=$CREDIT_MARKET_ADDR CLOB=$CLOB_ADDR"

# ─── 3. deployments.json (backup, then overwrite) ─────────────────────────────
log "backing up + overwriting contracts/deployments/base-sepolia.json"
cp "$DEPLOYMENTS_JSON" "$RUN_DIR/base-sepolia.json.bak"
cat >"$DEPLOYMENTS_JSON" <<EOF
{"chainId":${CHAIN_ID},"clobSettlement":"${CLOB_ADDR}","creditMarket":"${CREDIT_MARKET_ADDR}","deployer":"${DEPLOYER_ADDR}","initialMark":230000000000000000,"insuranceFund":"${INSURANCE_ADDR}","noToken":"${NO_ADDR}","oracleRouter":"${ORACLE_ADDR}","usdc":"${USDC_ADDR}","yesToken":"${YES_ADDR}","liquidationEngine":"${LIQUIDATION_ADDR}"}
EOF

# ─── 4. redis ──────────────────────────────────────────────────────────────────
if [[ "$REUSE_REDIS" -eq 0 ]]; then
  log "starting redis --port $REDIS_PORT"
  nohup redis-server --port "$REDIS_PORT" --save '' --appendonly no >"$RUN_DIR/redis.log" 2>&1 &
  echo $! >"$RUN_DIR/redis.pid"
  wait_for_port 127.0.0.1 "$REDIS_PORT" "redis"
fi

# ─── 5. order-book-server ──────────────────────────────────────────────────────
log "starting order-book-server on :$ORDER_BOOK_PORT"
(
  cd "$REPO_ROOT/backend/order-book-server"
  PORT="$ORDER_BOOK_PORT" \
  BASE_SEPOLIA_RPC_URL="$RPC_URL" \
  CHAIN_ID="$CHAIN_ID" \
  REDIS_HOST=localhost \
  REDIS_PORT="$REDIS_PORT" \
  USDC_ADDRESS="$USDC_ADDR" \
  YES_TOKEN_ADDRESS="$YES_ADDR" \
  NO_TOKEN_ADDRESS="$NO_ADDR" \
  CLOB_SETTLEMENT_ADDRESS="$CLOB_ADDR" \
  CREDIT_MARKET_ADDRESS="$CREDIT_MARKET_ADDR" \
  nohup npm run dev >"$RUN_DIR/order-book-server.log" 2>&1 &
  echo $! >"$RUN_DIR/order-book-server.pid"
)
wait_for_http "$ORDER_BOOK_URL/orderbook" "order-book-server"
log "order-book-server up (pid $(cat "$RUN_DIR/order-book-server.pid"))"

# ─── 6. matching-engine ────────────────────────────────────────────────────────
log "starting matching-engine (settler wired, anvil #9 key)"
(
  cd "$REPO_ROOT/backend/matching-engine"
  ORDER_BOOK_URL="$ORDER_BOOK_URL" \
  POLL_INTERVAL_MS=500 \
  YES_TOKEN_ADDRESS="$YES_ADDR" \
  NO_TOKEN_ADDRESS="$NO_ADDR" \
  USDC_ADDRESS="$USDC_ADDR" \
  SETTLER_PRIVATE_KEY="$SETTLER_KEY" \
  BASE_SEPOLIA_RPC_URL="$RPC_URL" \
  REDIS_HOST=localhost \
  REDIS_PORT="$REDIS_PORT" \
  nohup npm run dev >"$RUN_DIR/matching-engine.log" 2>&1 &
  echo $! >"$RUN_DIR/matching-engine.pid"
)
sleep 2
grep -q "settler.*wired" "$RUN_DIR/matching-engine.log" && log "matching-engine settler wired" || warn "matching-engine settler wiring not confirmed — check $RUN_DIR/matching-engine.log"

# ─── 7. seed ────────────────────────────────────────────────────────────────────
log "running seed-demo.ts (this takes a minute — chart-history warp + CLOB trades)"
(
  cd "$SCRIPT_DIR"
  BASE_SEPOLIA_RPC_URL="$RPC_URL" \
  ORDER_BOOK_URL="$ORDER_BOOK_URL" \
  CHAIN_ID="$CHAIN_ID" \
  USDC_ADDRESS="$USDC_ADDR" \
  YES_TOKEN_ADDRESS="$YES_ADDR" \
  NO_TOKEN_ADDRESS="$NO_ADDR" \
  CREDIT_MARKET_ADDRESS="$CREDIT_MARKET_ADDR" \
  CLOB_SETTLEMENT_ADDRESS="$CLOB_ADDR" \
  ./node_modules/.bin/tsx seed-demo.ts
) 2>&1 | tee "$RUN_DIR/seed.log"
[[ "${PIPESTATUS[0]:-0}" -eq 0 ]] || fail "seed-demo.ts failed — see $RUN_DIR/seed.log"

# ─── 8. keepers (started AFTER seeding — see seed-demo.ts header for why:
#        the seed script itself drives the KEEPER account directly to flag D,
#        and starting funding-keeper earlier risks a tx-nonce race against
#        that same account) ─────────────────────────────────────────────────
log "starting funding-keeper (health :$FUNDING_KEEPER_HEALTH_PORT)"
(
  cd "$REPO_ROOT/backend/keepers"
  KEEPER_PRIVATE_KEY="$KEEPER_KEY" \
  BASE_SEPOLIA_RPC_URL="$RPC_URL" \
  CREDIT_MARKET_ADDRESS="$CREDIT_MARKET_ADDR" \
  TRACKED_HOLDERS="${C_ADDR},${D_ADDR}" \
  CHAIN_ID="$CHAIN_ID" \
  HEALTH_PORT="$FUNDING_KEEPER_HEALTH_PORT" \
  nohup node -r ts-node/register funding-keeper.ts >"$RUN_DIR/funding-keeper.log" 2>&1 &
  echo $! >"$RUN_DIR/funding-keeper.pid"
)
wait_for_http "http://localhost:${FUNDING_KEEPER_HEALTH_PORT}/health" "funding-keeper" 20 || warn "funding-keeper /health not confirmed (non-fatal — it only ticks every 8h anyway)"

log "starting liquidation-keeper (:$LIQUIDATION_KEEPER_PORT)"
(
  cd "$REPO_ROOT/backend/keepers"
  BASE_SEPOLIA_RPC_URL="$RPC_URL" \
  CREDIT_MARKET_ADDRESS="$CREDIT_MARKET_ADDR" \
  YES_TOKEN_ADDRESS="$YES_ADDR" \
  TRACKED_HOLDERS="${C_ADDR},${D_ADDR}" \
  POLL_INTERVAL_MS=5000 \
  CHAIN_ID="$CHAIN_ID" \
  PORT="$LIQUIDATION_KEEPER_PORT" \
  nohup node -r ts-node/register liquidation-keeper.ts >"$RUN_DIR/liquidation-keeper.log" 2>&1 &
  echo $! >"$RUN_DIR/liquidation-keeper.pid"
)
wait_for_http "$LIQUIDATION_KEEPER_URL/claimable" "liquidation-keeper"
log "liquidation-keeper up (pid $(cat "$RUN_DIR/liquidation-keeper.pid"))"

# ─── 9. frontend env + dev server ──────────────────────────────────────────────
log "writing frontend/.env.local"
if [[ -f "$FRONTEND_ENV" ]]; then
  cp "$FRONTEND_ENV" "$RUN_DIR/env.local.bak"
fi
cat >"$FRONTEND_ENV" <<EOF
NEXT_PUBLIC_CREDIT_MARKET_ADDRESS=${CREDIT_MARKET_ADDR}
NEXT_PUBLIC_YES_TOKEN_ADDRESS=${YES_ADDR}
NEXT_PUBLIC_NO_TOKEN_ADDRESS=${NO_ADDR}
NEXT_PUBLIC_CLOB_SETTLEMENT_ADDRESS=${CLOB_ADDR}
NEXT_PUBLIC_ORACLE_ROUTER_ADDRESS=${ORACLE_ADDR}
NEXT_PUBLIC_LIQUIDATION_ENGINE_ADDRESS=${LIQUIDATION_ADDR}
NEXT_PUBLIC_USDC_ADDRESS=${USDC_ADDR}
NEXT_PUBLIC_RPC_URL=${RPC_URL}
NEXT_PUBLIC_ORDER_BOOK_URL=${ORDER_BOOK_URL}
NEXT_PUBLIC_LIQUIDATION_KEEPER_URL=${LIQUIDATION_KEEPER_URL}
EOF

log "starting frontend (next dev -p $FRONTEND_PORT, isolated .next-demo build dir)"
(
  cd "$REPO_ROOT/frontend"
  NEXT_DIST_DIR=.next-demo \
  nohup npx next dev -p "$FRONTEND_PORT" >"$RUN_DIR/frontend.log" 2>&1 &
  echo $! >"$RUN_DIR/frontend.pid"
)
wait_for_http "http://localhost:${FRONTEND_PORT}" "frontend" 120
log "frontend up (pid $(cat "$RUN_DIR/frontend.pid"))"

# ─── env.sh for warp.sh / demo-down.sh / manual cast commands ─────────────────
cat >"$RUN_DIR/env.sh" <<EOF
export RPC_URL="$RPC_URL"
export CHAIN_ID="$CHAIN_ID"
export USDC_ADDR="$USDC_ADDR"
export YES_ADDR="$YES_ADDR"
export NO_ADDR="$NO_ADDR"
export CREDIT_MARKET_ADDR="$CREDIT_MARKET_ADDR"
export CLOB_ADDR="$CLOB_ADDR"
export ORACLE_ADDR="$ORACLE_ADDR"
export INSURANCE_ADDR="$INSURANCE_ADDR"
export LIQUIDATION_ADDR="$LIQUIDATION_ADDR"
export DEPLOYER_ADDR="$DEPLOYER_ADDR"
export DEPLOYER_KEY="$DEPLOYER_KEY"
export KEEPER_ADDR="$KEEPER_ADDR"
export KEEPER_KEY="$KEEPER_KEY"
export SETTLER_ADDR="$SETTLER_ADDR"
export SETTLER_KEY="$SETTLER_KEY"
export A_ADDR="$A_ADDR"
export A_KEY="$A_KEY"
export B_ADDR="$B_ADDR"
export B_KEY="$B_KEY"
export C_ADDR="$C_ADDR"
export C_KEY="$C_KEY"
export D_ADDR="$D_ADDR"
export D_KEY="$D_KEY"
export REUSE_REDIS="$REUSE_REDIS"
export REDIS_PORT="$REDIS_PORT"
EOF

# ─── summary ────────────────────────────────────────────────────────────────────
cat <<BANNER

================================================================================
 Pari demo stack is up
================================================================================
 Frontend:            http://localhost:${FRONTEND_PORT}
 Order book:          ${ORDER_BOOK_URL}/orderbook
 Liquidation keeper:  ${LIQUIDATION_KEEPER_URL}/claimable
 Anvil RPC:           ${RPC_URL}  (chainId ${CHAIN_ID})

 Contracts:
   CreditMarket        ${CREDIT_MARKET_ADDR}
   YESToken            ${YES_ADDR}
   NOToken             ${NO_ADDR}
   CLOBSettlement      ${CLOB_ADDR}
   OracleRouter        ${ORACLE_ADDR}
   InsuranceFund       ${INSURANCE_ADDR}
   LiquidationEngine   ${LIQUIDATION_ADDR}
   USDC (mock, 6dp)    ${USDC_ADDR}

 MetaMask wallets (import via private key; add network "Pari Local":
 RPC ${RPC_URL}, chainId ${CHAIN_ID}, currency ETH):

   Presenter        (A)  ${A_ADDR}
                          ${A_KEY}
   Market Maker     (B)  ${B_ADDR}
                          ${B_KEY}
   Distressed Upbet (C)  ${C_ADDR}
                          ${C_KEY}
   Doomed Upbet     (D)  ${D_ADDR}
                          ${D_KEY}

 D is already flagged claimable — check ${LIQUIDATION_KEEPER_URL}/claimable
 C is close to the trigger but not flagged — run ./warp.sh 5 during the demo
 to push it over the edge live.

 Open http://localhost:${FRONTEND_PORT}

 Teardown: ./demo-down.sh
================================================================================
BANNER
