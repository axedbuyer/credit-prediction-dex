#!/usr/bin/env bash
# Pause / resume / list a smoke service by its RECORDED process group (never a pattern kill).
#   svc.sh pause  <name>   SIGSTOP the service's process group (simulates downtime)
#   svc.sh resume <name>   SIGCONT
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/common.sh"
cmd="${1:?usage: svc.sh pause|resume <service>}"; name="${2:?service name}"
pidf="$RUN_DIR/$name.pid"
[[ -f "$pidf" ]] || { echo "no pid file for $name" >&2; exit 1; }
pid="$(cat "$pidf")"
case "$cmd" in
  pause)  kill -STOP -- "-$pid" ;;
  resume) kill -CONT -- "-$pid" ;;
  *) echo "unknown command $cmd" >&2; exit 2 ;;
esac
