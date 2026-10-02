#!/usr/bin/env bash
# Copies the canonical backend/shared/registry.ts (+ its test) into each backend
# service. `--check` fails (exit 1) if any copy has drifted — run in CI.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
targets=(
  "$here/../order-book-server/src/registry.ts"
  "$here/../matching-engine/src/registry.ts"
  "$here/../keepers/registry.ts"
)
tests=(
  "$here/../order-book-server/src/__tests__/registry.test.ts"
  "$here/../matching-engine/src/__tests__/registry.test.ts"
  "$here/../keepers/__tests__/registry.test.ts"
)
rc=0
for i in "${!targets[@]}"; do
  if [[ "${1:-}" == "--check" ]]; then
    cmp -s "$here/registry.ts" "${targets[$i]}" || { echo "DRIFT: ${targets[$i]}"; rc=1; }
  else
    cp "$here/registry.ts" "${targets[$i]}"
    # the test imports '../registry' from __tests__ in every service layout
    cp "$here/registry.test.ts" "${tests[$i]}"
  fi
done
[[ "${1:-}" == "--check" && $rc -eq 0 ]] && echo "registry.ts copies in sync"
exit $rc
