#!/usr/bin/env bash
# Tears down everything demo-up.sh started. Only ever kills PIDs this script
# itself recorded in .run/ (and only after re-checking the process is still
# what we think it is) — never touches the user's own long-lived anvil
# (:8545/:8546), order-book-server (:3001), or next dev (:3000).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
RUN_DIR="$SCRIPT_DIR/.run"
DEPLOYMENTS_JSON="$REPO_ROOT/contracts/deployments/base-sepolia.json"
FRONTEND_ENV="$REPO_ROOT/frontend/.env.local"

log() { printf '\n\033[1;36m[demo-down]\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m[demo-down][warn]\033[0m %s\n' "$1"; }

if [[ ! -d "$RUN_DIR" ]]; then
  log "no $RUN_DIR found — nothing to tear down"
  exit 0
fi

# kill_pidfile <file> <expected substring in /proc/PID/cmdline>
# For simple single-process launches (anvil, redis-server, npx next, node
# <keeper>.ts) the recorded PID *is* the real process and its cmdline names it.
kill_pidfile() {
  local file="$1" expect="$2"
  [[ -f "$file" ]] || return 0
  local pid
  pid="$(cat "$file")"
  [[ -n "$pid" ]] || return 0
  if ! ps -p "$pid" >/dev/null 2>&1; then
    log "pid $pid ($file) already gone"
    return 0
  fi
  local cmd
  cmd="$(tr '\0' ' ' <"/proc/$pid/cmdline" 2>/dev/null || ps -p "$pid" -o cmd=)"
  if [[ "$cmd" != *"$expect"* ]]; then
    warn "pid $pid no longer looks like '$expect' (cmd: $cmd) — NOT killing, check manually"
    return 0
  fi
  kill "$pid" 2>/dev/null && log "killed pid $pid ($expect)" || warn "failed to kill pid $pid"
}

# kill_pidfile_tree <file> <expected substring in the process's cwd>
# For `npm run dev` launches (order-book-server, matching-engine): the recorded
# PID is npm's own wrapper process — its cmdline is just "npm run dev" (no
# service name to match), and it does not reliably forward SIGTERM to the
# actual tsx/node child it spawned. Identify it by cwd instead (demo-up.sh
# always cd's into the service's own directory first) and kill the whole
# descendant tree, leaves first.
kill_pidfile_tree() {
  local file="$1" expect_cwd="$2"
  [[ -f "$file" ]] || return 0
  local pid
  pid="$(cat "$file")"
  [[ -n "$pid" ]] || return 0
  if ! ps -p "$pid" >/dev/null 2>&1; then
    log "pid $pid ($file) already gone"
    return 0
  fi
  local cwd
  cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
  if [[ "$cwd" != *"$expect_cwd"* ]]; then
    warn "pid $pid cwd ($cwd) doesn't look like '.../$expect_cwd' — NOT killing, check manually"
    return 0
  fi
  local all=("$pid") frontier=("$pid")
  while [[ ${#frontier[@]} -gt 0 ]]; do
    local next=()
    for p in "${frontier[@]}"; do
      for child in $(pgrep -P "$p" 2>/dev/null); do
        all+=("$child")
        next+=("$child")
      done
    done
    frontier=("${next[@]}")
  done
  local i
  for ((i = ${#all[@]} - 1; i >= 0; i--)); do
    kill "${all[$i]}" 2>/dev/null
  done
  log "killed pid tree rooted at $pid (${#all[@]} processes, cwd matched '$expect_cwd')"
}

log "stopping frontend"
# `next dev` also forks a long-lived "next-server" child that outlives its
# parent if only the parent is signalled (same class of bug as npm run dev
# below) — tree-kill it too. cwd-matching is safe here even though the
# user's own :3000 dev server shares the same cwd, because we only ever act
# on the specific PID this script itself recorded.
kill_pidfile_tree "$RUN_DIR/frontend.pid" "/frontend"

log "stopping liquidation-keeper"
kill_pidfile "$RUN_DIR/liquidation-keeper.pid" "liquidation-keeper"

log "stopping funding-keeper"
kill_pidfile "$RUN_DIR/funding-keeper.pid" "funding-keeper"

log "stopping matching-engine"
kill_pidfile_tree "$RUN_DIR/matching-engine.pid" "backend/matching-engine"

log "stopping order-book-server"
kill_pidfile_tree "$RUN_DIR/order-book-server.pid" "backend/order-book-server"

# redis: only kill if THIS demo-up.sh run started it (recorded via env.sh's
# REUSE_REDIS=0 and a redis.pid file). If it was reused (already running,
# not ours), just flush it clean and leave it for whatever else uses it.
REUSE_REDIS=1
[[ -f "$RUN_DIR/env.sh" ]] && source "$RUN_DIR/env.sh"
if [[ "${REUSE_REDIS:-1}" -eq 0 ]]; then
  log "stopping demo redis"
  kill_pidfile "$RUN_DIR/redis.pid" "redis-server"
else
  log "redis on :${REDIS_PORT:-6380} was reused (not started by demo-up.sh) — flushing, not killing"
  redis-cli -p "${REDIS_PORT:-6380}" flushall >/dev/null 2>&1 || true
fi

log "stopping anvil"
kill_pidfile "$RUN_DIR/anvil.pid" "anvil"

log "restoring contracts/deployments/base-sepolia.json"
if git -C "$REPO_ROOT" diff --quiet -- contracts/deployments/base-sepolia.json 2>/dev/null; then
  log "deployments.json unchanged, nothing to restore"
elif git -C "$REPO_ROOT" checkout -- contracts/deployments/base-sepolia.json 2>/dev/null; then
  log "restored from git"
else
  warn "git checkout failed — restoring from backup instead"
  [[ -f "$RUN_DIR/base-sepolia.json.bak" ]] && cp "$RUN_DIR/base-sepolia.json.bak" "$DEPLOYMENTS_JSON"
fi

log "restoring frontend/.env.local"
if [[ -f "$RUN_DIR/env.local.bak" ]]; then
  cp "$RUN_DIR/env.local.bak" "$FRONTEND_ENV"
  log "restored previous frontend/.env.local from backup"
else
  rm -f "$FRONTEND_ENV"
  log "removed demo frontend/.env.local (none existed before demo-up.sh)"
fi

log "removing $RUN_DIR"
rm -rf "$RUN_DIR"

log "demo stack down. User services (anvil :8545/:8546, order-book-server :3001, next dev :3000) were not touched."
