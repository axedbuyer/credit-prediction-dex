#!/usr/bin/env bash
# Advances the demo anvil chain by <days> and calls accrueFunding() (permissionless)
# so funding catches up — used live in a demo to push Wallet C ("Distressed
# Upbet") over the seizure trigger in front of the audience. Requires demo-up.sh
# to have been run first (reads scripts/demo/.run/env.sh for addresses/keys).
#
# Usage: ./warp.sh <days>
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUN_DIR="$SCRIPT_DIR/.run"
CAST="$HOME/.foundry/bin/cast"

[[ -f "$RUN_DIR/env.sh" ]] || { echo "no $RUN_DIR/env.sh — run demo-up.sh first"; exit 1; }
# shellcheck source=/dev/null
source "$RUN_DIR/env.sh"

DAYS="${1:?usage: ./warp.sh <days>}"
SECONDS_TO_WARP=$((DAYS * 86400))

echo "[warp] advancing chain time by ${DAYS} day(s) (${SECONDS_TO_WARP}s)..."
"$CAST" rpc evm_increaseTime "$SECONDS_TO_WARP" --rpc-url "$RPC_URL" >/dev/null
"$CAST" rpc evm_mine --rpc-url "$RPC_URL" >/dev/null
echo "[warp] calling accrueFunding() (permissionless, deployer key)..."
"$CAST" send "$CREDIT_MARKET_ADDR" "accrueFunding()" --rpc-url "$RPC_URL" --private-key "$DEPLOYER_KEY" >/dev/null

NEW_TIME=$("$CAST" block latest --field timestamp --rpc-url "$RPC_URL")
MARK=$("$CAST" call "$CREDIT_MARKET_ADDR" "currentMark()(uint256)" --rpc-url "$RPC_URL")
C_SEIZABLE=$("$CAST" call "$CREDIT_MARKET_ADDR" "isSeizable(address)(bool)" "$C_ADDR" --rpc-url "$RPC_URL")
C_EPOCHS=$("$CAST" call "$CREDIT_MARKET_ADDR" "epochsToExpire(address)(uint256)" "$C_ADDR" --rpc-url "$RPC_URL")
C_CLAIMABLE=$("$CAST" call "$CREDIT_MARKET_ADDR" "claimable(address)(bool)" "$C_ADDR" --rpc-url "$RPC_URL")

# The real funding-keeper only ticks every 8h of WALL-CLOCK time (its cron
# schedule has nothing to do with the chain-time jump above), so it will not
# flag C during a live meeting. Fast-forward that reaction here — if C just
# crossed the trigger and isn't flagged yet, flag it now with the keeper key
# so the frozen banner shows up immediately after this command returns.
if [[ "$C_SEIZABLE" == "true" && "$C_CLAIMABLE" == "false" ]]; then
  echo "[warp] C crossed the seizure trigger — flagging now (simulating the keeper's reaction)..."
  "$CAST" send "$CREDIT_MARKET_ADDR" "flagClaimable(address)" "$C_ADDR" \
    --rpc-url "$RPC_URL" --private-key "$KEEPER_KEY" >/dev/null
  C_CLAIMABLE=true
fi

cat <<SUMMARY

[warp] chain time is now  : ${NEW_TIME}
[warp] currentMark        : ${MARK}
[warp] C.isSeizable        : ${C_SEIZABLE}
[warp] C.epochsToExpire    : ${C_EPOCHS}
[warp] C.claimable         : ${C_CLAIMABLE}

SUMMARY
