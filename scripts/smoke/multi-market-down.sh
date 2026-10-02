#!/usr/bin/env bash
# Tears down ONLY what multi-market-up.sh started (by recorded PID/PGID — never a pattern
# kill), then restores contracts/broadcast + contracts/cache exactly from the pre-run
# backup and verifies the real batch-1 deploy record is intact.
set -uo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
log() { printf '\033[1;36m[smoke-down]\033[0m %s\n' "$*"; }

for name in liquidator-bot liquidation-keeper funding-keeper matching-engine order-book-server redis anvil; do
  pidf="$RUN_DIR/$name.pid"
  [[ -f "$pidf" ]] || continue
  pid="$(cat "$pidf")"
  kill -CONT -- "-$pid" 2>/dev/null || true        # a SIGSTOPped group can't handle TERM
  kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for ((i=0;i<20;i++)); do kill -0 "$pid" 2>/dev/null || break; sleep 0.25; done
  if kill -0 "$pid" 2>/dev/null; then kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; fi
  log "stopped $name (pid/pgid $pid)"
  rm -f "$pidf"
done

BK="$RUN_DIR/forge-backup"
if [[ -d "$BK" ]]; then
  log "restoring contracts/broadcast + contracts/cache from $BK"
  rsync -a --delete "$BK/broadcast/" "$REPO_ROOT/contracts/broadcast/"
  rsync -a --delete "$BK/cache/" "$REPO_ROOT/contracts/cache/"
  rm -rf "$BK"
  B="$REPO_ROOT/contracts/broadcast/Deploy.s.sol/84532"
  if cmp "$B/run-latest.json" "$B/run-1790824920355.json"; then log "cmp OK: run-latest.json == real batch-1 record run-1790824920355.json"
  else log "ERROR: run-latest.json differs from run-1790824920355.json"; exit 1; fi
else
  log "no forge backup in $RUN_DIR (nothing to restore)"
fi
for p in $ANVIL_PORT $REDIS_PORT $ORDER_BOOK_PORT $FUNDING_HEALTH_PORT $LIQ_KEEPER_PORT $BOT_HEALTH_PORT; do
  ss -ltn 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${p}\$" && log "WARNING: port $p still listening"
done
log "done"
