#!/usr/bin/env bash
# One-liner: stack up -> smoke -> stack down (always tears down + restores forge broadcast/cache).
set -uo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$DIR/multi-market-down.sh" >/dev/null 2>&1 || true     # clear any stale run of OUR stack (by recorded PIDs only)
"$DIR/multi-market-up.sh" || { "$DIR/multi-market-down.sh"; exit 2; }
( cd "$DIR" && ./node_modules/.bin/tsx multi-market-smoke.ts ); rc=$?
"$DIR/multi-market-down.sh"
exit $rc
