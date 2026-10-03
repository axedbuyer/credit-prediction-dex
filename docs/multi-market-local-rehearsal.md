# Multi-market local rehearsal (anvil)

Rehearses the phase-1 scripts end to end on a throwaway anvil: mock USDC -> legacy
single-market deploy (stands in for the live MSTR set) -> `DeployMarketRegistry` -> `AddMarket`
for `crwv` and `try`. Every script asserts its own on-chain configuration after broadcast.
Phase 2 reuses this sequence to bring up the 2-market anvil stack.

Run from `contracts/`. Use a spare port (never 8545-8547, those are the demo anvils).

```bash
F=~/.foundry/bin; RPC=http://127.0.0.1:8549
$F/anvil --chain-id 84532 --port 8549 &          # note: kill by PID when done

# anvil default key #0
export DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
# Outputs MUST live under contracts/ (foundry.toml fs_permissions is "./"); cache/ is gitignored.
OUT=cache/p1-anvil

# 1. mock USDC
USDC=$($F/forge create script/DeployLocal.s.sol:MockUSDC --rpc-url $RPC \
        --private-key $DEPLOYER_PRIVATE_KEY --broadcast | awk '/Deployed to:/{print $3}')

# 2. legacy single-market deploy (scratch output path, never deployments/base-sepolia.json)
USDC_ADDRESS=$USDC DEPLOYMENTS_OUT=$OUT/legacy.json \
  $F/forge script script/Deploy.s.sol --rpc-url $RPC --broadcast

# 3. registry + register legacy set as `mstr` (reads legacy.json read-only)
#    dry run first: logs "DRY RUN - would write", writes nothing
LEGACY_DEPLOYMENT=$OUT/legacy.json DEPLOYMENTS_DIR=$OUT/net \
  $F/forge script script/DeployMarketRegistry.s.sol --rpc-url $RPC
test ! -e $OUT/net/core.json && echo "dry run wrote nothing"
LEGACY_DEPLOYMENT=$OUT/legacy.json DEPLOYMENTS_DIR=$OUT/net \
  $F/forge script script/DeployMarketRegistry.s.sol --rpc-url $RPC --broadcast

# 4. add markets (INITIAL_MARK is a 1e18-scaled integer: 0.10e18 = 100000000000000000)
for M in "crwv|CoreWeave|corporate|CRWV|100000000000000000" \
         "try|Turkey|sovereign|TRY|20000000000000000"; do
  IFS='|' read SLUG NAME TYPE TICKER MARK <<< "$M"
  export MARKET_SLUG=$SLUG ENTITY_NAME="$NAME" ENTITY_TYPE=$TYPE TOKEN_TICKER=$TICKER \
         INITIAL_MARK=$MARK DEPLOYMENTS_DIR=$OUT/net
  $F/forge script script/AddMarket.s.sol --rpc-url $RPC               # dry run: no file written
  $F/forge script script/AddMarket.s.sol --rpc-url $RPC --broadcast
done

# 5. inspect
REG=$(python3 -c "import json;print(json.load(open('$OUT/net/core.json'))['marketRegistry'])")
$F/cast call $REG "allMarkets()((string,string,uint8,address,address,address,address,address,address,bool,uint64,uint64)[])" --rpc-url $RPC
ls $OUT/net $OUT/net/markets      # core.json, markets/{mstr,crwv,try}.json
```

Optional env on `AddMarket`: `KEEPER_ADDRESS`, `PAUSER_ADDRESS`, `ORACLE_ATTESTER_ADDRESS`,
`TEAM_WALLET`, `DEPOSIT_CAP` (default 50_000e6), `MAX_MARK_STEP` (0.05e18), `MIN_MARK_INTERVAL` (1h).

## Gotchas

- Files are written only under `--broadcast` (`vm.isContext(ScriptBroadcast)`); a dry run logs the
  JSON it would write. Dry runs need the registry/core.json to already exist for `AddMarket`.
- `forge script --broadcast` records to `contracts/broadcast/<Script>/84532/` and overwrites that
  script's `run-latest.json` (and `cache/<Script>/84532/run-latest.json`). Chain id 84532 is also
  real Base Sepolia, so after a rehearsal restore `Deploy.s.sol`'s `run-latest.json` from the
  newest real `run-<timestamp>.json` and delete the rehearsal's timestamped copy. (Using a
  different `--chain-id` on anvil avoids this entirely.)
- The deployer key must be admin of the shared InsuranceFund and of the MarketRegistry;
  `AddMarket` checks both (and that the slug is free) before broadcasting anything.
