#!/usr/bin/env bash
# Brings up the multi-market smoke stack on THROWAWAY infra (anvil :8549 chain-id 84532,
# redis :6392, order-book :3021, funding-keeper health :3022, liquidation-keeper :3023,
# liquidator-bot health :3024). 3 markets (mstr legacy-registered, crwv, try) + all 5
# services in REGISTRY mode. Writes $RUN_DIR/env.json for multi-market-smoke.ts.
# Tear down with multi-market-down.sh (kills by recorded PGID, restores broadcast/cache).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"

log()  { printf '\033[1;36m[smoke-up]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[smoke-up][error]\033[0m %s\n' "$*" >&2; exit 1; }
port_busy() { ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${1}\$"; }
wait_port() { for ((i=0;i<${3:-120};i++)); do (exec 3<>/dev/tcp/127.0.0.1/$1) 2>/dev/null && { exec 3>&- 3<&-; return 0; }; sleep 0.5; done; fail "$2 did not open :$1"; }
wait_http() { for ((i=0;i<${3:-240};i++)); do curl -sf -o /dev/null "$1" && return 0; sleep 0.5; done; fail "$2 not responding at $1 (see $RUN_DIR/*.log)"; }

for p in $ANVIL_PORT $REDIS_PORT $ORDER_BOOK_PORT $FUNDING_HEALTH_PORT $LIQ_KEEPER_PORT $BOT_HEALTH_PORT; do
  port_busy "$p" && fail "port $p busy — run multi-market-down.sh or free it (never reuse the user's 8545-8547/6379/6380/30xx ports)"
done
[[ -x "$FORGE" && -x "$ANVIL" && -x "$CAST" ]] || fail "foundry binaries missing in $FOUNDRY_BIN"
command -v redis-server >/dev/null || fail "redis-server not on PATH"

[[ ! -e "$RUN_DIR/anvil.pid" ]] || fail "$RUN_DIR already holds a run — run multi-market-down.sh first"
mkdir -p "$RUN_DIR"

# node_modules symlink so tsx resolves viem/ioredis from scripts/smoke (same quirk as scripts/demo)
[[ -e "$SMOKE_DIR/node_modules" ]] || ln -s ../../backend/matching-engine/node_modules "$SMOKE_DIR/node_modules"

# ── forge outputs that will be overwritten by broadcasts on chain 84532 ────────
# Real Base Sepolia shares chain id 84532, so a local broadcast clobbers
# contracts/broadcast/<Script>/84532/run-latest.json. Back up first; down.sh restores.
BK="$RUN_DIR/forge-backup"
if [[ ! -d "$BK" ]]; then
  log "backing up contracts/broadcast + contracts/cache -> $BK"
  mkdir -p "$BK"
  rsync -a "$REPO_ROOT/contracts/broadcast" "$BK/"
  rsync -a "$REPO_ROOT/contracts/cache" "$BK/"
fi

# ── spawn helper: own session/process group, PGID recorded (down.sh kills the group) ──
spawn() { # name logfile cmd...
  local name="$1" logf="$2"; shift 2
  setsid nohup "$@" >"$logf" 2>&1 < /dev/null &
  local pid=$!
  echo "$pid" > "$RUN_DIR/$name.pid"
  local pgid; pgid="$(ps -o pgid= -p "$pid" | tr -d ' ')"
  [[ "$pgid" == "$pid" ]] || log "warning: $name pgid $pgid != pid $pid (group kill falls back to pid)"
}

# ── 1. anvil + Multicall3 ────────────────────────────────────────────────────
log "anvil --chain-id $CHAIN_ID --port $ANVIL_PORT"
spawn anvil "$RUN_DIR/anvil.log" "$ANVIL" --chain-id "$CHAIN_ID" --port "$ANVIL_PORT"
wait_port "$ANVIL_PORT" anvil
"$CAST" rpc anvil_setCode 0xcA11bde05977b3631167028862bE2a173976CA11 "$(cat "$REPO_ROOT/scripts/demo/multicall3.bytecode")" --rpc-url "$RPC_URL" >/dev/null

# ── 2. contracts (per docs/multi-market-local-rehearsal.md) ──────────────────
cd "$REPO_ROOT/contracts"
OUT=cache/smoke            # must live under contracts/ (fs_permissions "./"); gitignored
rm -rf "$OUT"; mkdir -p "$OUT"
export DEPLOYER_PRIVATE_KEY=$K0 KEEPER_ADDRESS=$KEEPER_ADDR
log "mock USDC"
USDC=$("$FORGE" create script/DeployLocal.s.sol:MockUSDC --rpc-url "$RPC_URL" --private-key "$K0" --broadcast 2>"$RUN_DIR/deploy-usdc.err" | awk '/Deployed to:/{print $3}')
[[ -n "$USDC" ]] || { cat "$RUN_DIR/deploy-usdc.err"; fail "mock USDC deploy failed"; }
log "USDC=$USDC; legacy single-market deploy (mstr)"
USDC_ADDRESS=$USDC DEPLOYMENTS_OUT=$OUT/legacy.json "$FORGE" script script/Deploy.s.sol --rpc-url "$RPC_URL" --broadcast >"$RUN_DIR/deploy-legacy.log" 2>&1 || { tail -30 "$RUN_DIR/deploy-legacy.log"; fail "Deploy.s.sol failed"; }
log "MarketRegistry (+ register mstr)"
LEGACY_DEPLOYMENT=$OUT/legacy.json DEPLOYMENTS_DIR=$OUT/net "$FORGE" script script/DeployMarketRegistry.s.sol --rpc-url "$RPC_URL" --broadcast >"$RUN_DIR/deploy-registry.log" 2>&1 || { tail -30 "$RUN_DIR/deploy-registry.log"; fail "DeployMarketRegistry failed"; }
for M in "crwv|CoreWeave|corporate|CRWV|100000000000000000" "try|Turkey|sovereign|TRY|20000000000000000"; do
  IFS='|' read SLUG NAME TYPE TICKER MARK <<< "$M"
  log "AddMarket $SLUG"
  MARKET_SLUG=$SLUG ENTITY_NAME="$NAME" ENTITY_TYPE=$TYPE TOKEN_TICKER=$TICKER INITIAL_MARK=$MARK DEPLOYMENTS_DIR=$OUT/net \
    "$FORGE" script script/AddMarket.s.sol --rpc-url "$RPC_URL" --broadcast >"$RUN_DIR/deploy-$SLUG.log" 2>&1 || { tail -30 "$RUN_DIR/deploy-$SLUG.log"; fail "AddMarket $SLUG failed"; }
done
REG=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$OUT/net/core.json','utf8')).marketRegistry)")
IF=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$OUT/net/core.json','utf8')).insuranceFund)")
[[ "$REG" == 0x* && "$IF" == 0x* ]] || fail "could not read registry/insuranceFund from $OUT/net/core.json"
log "registry=$REG insuranceFund=$IF"
cat > "$RUN_DIR/env.json" <<JSON
{"rpcUrl":"$RPC_URL","chainId":$CHAIN_ID,"usdc":"$USDC","registry":"$REG","insuranceFund":"$IF",
 "orderBookUrl":"$ORDER_BOOK_URL","fundingHealthUrl":"http://127.0.0.1:$FUNDING_HEALTH_PORT","liqKeeperUrl":"http://127.0.0.1:$LIQ_KEEPER_PORT",
 "botHealthUrl":"http://127.0.0.1:$BOT_HEALTH_PORT","redisPort":$REDIS_PORT,"runDir":"$RUN_DIR","smokeDir":"$SMOKE_DIR"}
JSON

# ── 3. redis + services (registry mode) ──────────────────────────────────────
log "redis :$REDIS_PORT"
spawn redis "$RUN_DIR/redis.log" redis-server --port "$REDIS_PORT" --save '' --appendonly no
wait_port "$REDIS_PORT" redis

COMMON_ENV=(BASE_SEPOLIA_RPC_URL="$RPC_URL" CHAIN_ID="$CHAIN_ID" MARKET_REGISTRY_ADDRESS="$REG" REGISTRY_REFRESH_MS=3000 USDC_ADDRESS="$USDC")

log "order-book-server :$ORDER_BOOK_PORT (LEGACY_SWEEP_MS=2000, rate limit off)"
( cd "$REPO_ROOT/backend/order-book-server" && spawn order-book-server "$RUN_DIR/order-book-server.log" env "${COMMON_ENV[@]}" \
    PORT="$ORDER_BOOK_PORT" REDIS_HOST=127.0.0.1 REDIS_PORT="$REDIS_PORT" LEGACY_SWEEP_MS=2000 ORDER_RATE_LIMIT_MAX=0 FEE_REFRESH_MS=5000 \
    ./node_modules/.bin/tsx src/main.ts )
wait_http "$ORDER_BOOK_URL/markets" order-book-server

log "matching-engine (settler = anvil #2)"
( cd "$REPO_ROOT/backend/matching-engine" && spawn matching-engine "$RUN_DIR/matching-engine.log" env "${COMMON_ENV[@]}" \
    ORDER_BOOK_URL="$ORDER_BOOK_URL" POLL_INTERVAL_MS=500 SETTLER_PRIVATE_KEY="$K2" REDIS_HOST=127.0.0.1 REDIS_PORT="$REDIS_PORT" \
    ./node_modules/.bin/tsx src/main.ts )

KEEPER_NODE=(node -r ts-node/register)
log "funding-keeper (anvil #1; real main(), cron swapped to every 4s by fast-cron.js; health :$FUNDING_HEALTH_PORT)"
( cd "$REPO_ROOT/backend/keepers" && spawn funding-keeper "$RUN_DIR/funding-keeper.log" env "${COMMON_ENV[@]}" TS_NODE_TRANSPILE_ONLY=1 \
    KEEPER_PRIVATE_KEY="$K1" HEALTH_PORT="$FUNDING_HEALTH_PORT" SMOKE_CRON='*/4 * * * * *' \
    node -r "$SMOKE_DIR/fast-cron.js" -r ts-node/register funding-keeper.ts )
log "liquidation-keeper :$LIQ_KEEPER_PORT"
( cd "$REPO_ROOT/backend/keepers" && spawn liquidation-keeper "$RUN_DIR/liquidation-keeper.log" env "${COMMON_ENV[@]}" TS_NODE_TRANSPILE_ONLY=1 \
    PORT="$LIQ_KEEPER_PORT" POLL_INTERVAL_MS=2000 \
    node -r ts-node/register liquidation-keeper.ts )
log "liquidator-bot (anvil #3; health :$BOT_HEALTH_PORT)"
( cd "$REPO_ROOT/backend/keepers" && spawn liquidator-bot "$RUN_DIR/liquidator-bot.log" env "${COMMON_ENV[@]}" TS_NODE_TRANSPILE_ONLY=1 \
    LIQUIDATOR_PRIVATE_KEY="$K3" HEALTH_PORT="$BOT_HEALTH_PORT" ORDER_BOOK_URL="$ORDER_BOOK_URL" POLL_INTERVAL_MS=3000 \
    node -r ts-node/register liquidator-bot.ts )
wait_http "http://127.0.0.1:$FUNDING_HEALTH_PORT/health" funding-keeper
wait_http "http://127.0.0.1:$LIQ_KEEPER_PORT/health" liquidation-keeper
wait_http "http://127.0.0.1:$BOT_HEALTH_PORT/health" liquidator-bot
log "stack up. env: $RUN_DIR/env.json  logs: $RUN_DIR/*.log"
