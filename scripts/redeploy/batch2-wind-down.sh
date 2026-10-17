#!/usr/bin/env bash
# Wind down a superseded market batch: batch-1 markets in the batch-2 redeploy
# (docs/redeploy-batch2-runbook.md); batch-2 markets in batch 3 with
# OLD_DEPLOYMENTS=contracts/deployments/base-sepolia/archive/batch2
# (docs/redeploy-batch3-runbook.md).
# Per old market: redeem the deployer's complete sets (USDC back), pause the CreditMarket,
# deactivate it in the OLD registry, and revoke the old LiquidationEngine's LIQUIDATOR_ROLE
# on the shared InsuranceFund. Reads addresses from the ARCHIVED deployment files
# (OLD_DEPLOYMENTS, default the batch-1 archive).
#
#   scripts/redeploy/batch2-wind-down.sh <rpc-url>        (needs DEPLOYER_PRIVATE_KEY in env)
#
# Idempotent: skips a redeem with nothing to redeem, a pause already in place, an inactive
# entry and an already-revoked role, so it can be re-run after a public-RPC hiccup.
set -euo pipefail
RPC=${1:?usage: batch2-wind-down.sh <rpc-url>}
: "${DEPLOYER_PRIVATE_KEY:?export DEPLOYER_PRIVATE_KEY (contracts/.env)}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OLD="${OLD_DEPLOYMENTS:-$ROOT/contracts/deployments/base-sepolia/archive/batch1}"
[[ "$OLD" = /* ]] || OLD="$ROOT/$OLD"
CAST=${CAST:-$HOME/.foundry/bin/cast}
j() { python3 -c "import json,sys;print(json.load(open(sys.argv[1]))[sys.argv[2]])" "$1" "$2"; }
send() { "$CAST" send "$@" --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url "$RPC" >/dev/null; }
call() { "$CAST" call "$@" --rpc-url "$RPC" | awk '{print $1}'; }

DEPLOYER=$("$CAST" wallet address --private-key "$DEPLOYER_PRIVATE_KEY")
REG=$(j "$OLD/core.json" marketRegistry)
IF=$(j "$OLD/core.json" insuranceFund)
LR=$(call "$IF" 'LIQUIDATOR_ROLE()(bytes32)')
echo "deployer $DEPLOYER  old registry $REG  insuranceFund $IF"

for slug in mstr crwv try; do
  f="$OLD/markets/$slug.json"
  CM=$(j "$f" creditMarket); Y=$(j "$f" yesToken); N=$(j "$f" noToken); LE=$(j "$f" liquidationEngine)
  y=$(call "$Y" 'balanceOf(address)(uint256)' "$DEPLOYER"); n=$(call "$N" 'balanceOf(address)(uint256)' "$DEPLOYER")
  pairs=$(( y < n ? y : n ))
  if [ "$(call "$CM" 'paused()(bool)')" = "false" ] && [ "$pairs" -gt 0 ]; then
    send "$CM" 'redeem(uint256)' "$pairs"; echo "$slug: redeemed $pairs pairs"
  else echo "$slug: nothing to redeem (pairs=$pairs)"; fi
  if [ "$(call "$CM" 'paused()(bool)')" = "false" ]; then send "$CM" 'pause()'; echo "$slug: paused"; fi
  id=$(call "$REG" 'marketIdBySlug(string)(uint256)' "$slug")
  send "$REG" 'setActive(uint256,bool)' "$id" false; echo "$slug: inactive in old registry"
  if [ "$(call "$IF" 'hasRole(bytes32,address)(bool)' "$LR" "$LE")" = "true" ]; then
    send "$IF" 'revokeRole(bytes32,address)' "$LR" "$LE"; echo "$slug: revoked LIQUIDATOR_ROLE from old engine $LE"
  fi
  echo "$slug: supply YES $(call "$Y" 'totalSupply()(uint256)') NO $(call "$N" 'totalSupply()(uint256)') collateral $(call "$(j "$f" usdc)" 'balanceOf(address)(uint256)' "$CM") paused $(call "$CM" 'paused()(bool)')"
done
