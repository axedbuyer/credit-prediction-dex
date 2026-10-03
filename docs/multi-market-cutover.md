# Multi-market cutover — Base Sepolia runbook (phase 4)

*Written 2026-10-02. Status: **stage A done 2026-10-03** (PRs #2 + #3; live in legacy mode,
sweep moved 6 orders + 2 nonce sets); **stage B done 2026-10-03** — fork rehearsal passed
(whole stage cost 0.000049 ETH), registry `0xdF1A5141310140edF6fDaE3cd339FD042dF15720`, crwv and
try added (try broadcast run by the owner — the auto-mode classifier blocked it for Claude);
**stage C (Railway) done 2026-10-03** — all five services in registry mode (3 markets),
books seeded for crwv + try at 1 token/level (deployer held only ~6 USDC; re-seed bigger
with `MM_QTY=4 … mm-sepolia-seed.ts --market <slug>` after a Circle-faucet top-up);
Vercel var pending (owner, dashboard).**
*Original status line: **not executed.** Every on-chain step needs the owner's explicit
go-ahead (checkpoint CP4). Read with `docs/multi-market-design.md`, `docs/hosted-env-vars.md`,
`docs/multi-market-local-rehearsal.md` and the gotchas in `docs/HANDOVER.md`.*

The rollout is split so that **code ships first in legacy mode** (zero behaviour change), and
the switch to multi-market is a pure env-var flip that can be undone by unsetting it.

## Stage A — ship the code, still single-market (no chain txs)

1. Merge `feat/multi-market-contracts` → `main` (owner pushes from outside WSL). Railway rebuilds
   all five services and Vercel rebuilds the frontend automatically. No env var changes:
   with `MARKET_REGISTRY_ADDRESS` / `NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS` unset, every service
   runs in **legacy mode** — exactly one market, `mstr`, from today's address vars.
2. Watch the order-book-server logs during the deploy overlap: `swept legacy keys: N order(s)…`
   lines move the resting MSTR book from `orderbook:bids|asks` into `orderbook:mstr:*`; they
   stop once the old instance is gone. Then `GET /orderbook` (and `?market=mstr`) must show
   the same resting quotes as before (7 levels seeded 2026-07-19, unless filled since).
3. Check `/health` on order-book-server, liquidation-keeper (and funding-keeper/bot logs):
   `registry.mode == "legacy"`, one market `mstr`. Uptime workflow: run it manually — it
   checks the one (MSTR) CreditMarket, from `.markets` or its fallback.
4. Frontend: https://credit-prediction-dex.vercel.app — home is now a one-market list;
   `/market/mstr` trades as before. First trade from a wallet now asks for a USDC approval
   to the CLOB (new — the old TradePanel never requested one).

**Rollback for stage A:** revert the merge on `main`; the sweep is one-way, but legacy-mode
code reads `orderbook:mstr:*`, so only a revert to pre-multi-market code would need the keys
moved back (`RENAME orderbook:mstr:bids orderbook:bids`, same for asks).

## Stage B — deploy registry + new markets (chain txs — CP4 approval required)

Deployer `0x0D09…80f1` (DEFAULT_ADMIN on the batch-1 set and InsuranceFund). Top it up with
Base Sepolia ETH first: two AddMarket runs deploy 12 contracts plus ~20 role/config txs each.

### B0 — fork rehearsal (mandatory, as for batch 1)

```bash
cd contracts; F=~/.foundry/bin
cp -a broadcast /tmp/broadcast-backup        # rehearsals on chain 84532 overwrite run-latest.json
$F/anvil --fork-url https://sepolia.base.org --port 8549 &      # kill by PID afterwards
export DEPLOYER_PRIVATE_KEY=<deployer key from contracts/.env>
OUT=cache/fork-rehearsal
DEPLOYMENTS_DIR=$OUT $F/forge script script/DeployMarketRegistry.s.sol --rpc-url http://127.0.0.1:8549 --broadcast
MARKET_SLUG=crwv ENTITY_NAME=CoreWeave ENTITY_TYPE=corporate TOKEN_TICKER=CRWV INITIAL_MARK=100000000000000000 \
  DEPLOYMENTS_DIR=$OUT $F/forge script script/AddMarket.s.sol --rpc-url http://127.0.0.1:8549 --broadcast
MARKET_SLUG=try ENTITY_NAME=Turkey ENTITY_TYPE=sovereign TOKEN_TICKER=TRY INITIAL_MARK=20000000000000000 \
  DEPLOYMENTS_DIR=$OUT $F/forge script script/AddMarket.s.sol --rpc-url http://127.0.0.1:8549 --broadcast
rm -rf broadcast && cp -a /tmp/broadcast-backup broadcast   # restore the real batch-1 record
```

Every script must print `Post-broadcast configuration assertions passed`.
`DeployMarketRegistry` reads `deployments/base-sepolia.json` read-only and asserts the
live MSTR set: fee 50 bps / 5000 insurance share, roles. **If someone changed MSTR's fee
config since 2026-10-01 the assertion fails — investigate, don't bypass.** The registry
records MSTR with `startBlock` = the legacy file's 47528136 (keeper holder-index start).

### B1 — real broadcast

Same three commands against `--rpc-url $BASE_SEPOLIA_RPC_URL` (no `DEPLOYMENTS_DIR`
override → writes `deployments/base-sepolia/core.json` + `markets/{mstr,crwv,try}.json`).
Run each WITHOUT `--broadcast` first (writes nothing, logs "DRY RUN"), then with it.
Back up `contracts/broadcast` before and keep the new run files. Commit the new
deployments files. The legacy flat `deployments/base-sepolia.json` stays as-is.

### B2 — verify on Blockscout

`MarketRegistry` + 2 × (YESToken, NOToken, CreditMarket, CLOBSettlement, OracleRouter,
LiquidationEngine) with `forge verify-contract … --verifier blockscout` (the Etherscan key
is rejected — see `docs/redeploy-batch1-runbook.md` Outcome). Constructor args: tokens now
take `(admin, name, symbol)`. Check status via `/api/v2/smart-contracts/<addr>`.

### B3 — on-chain sanity

`cast call <registry> "marketCount()(uint256)"` == 3; `allMarkets()` shows mstr/MicroStrategy/0,
crwv/CoreWeave/0, try/Turkey/1, all active. Each new CLOB: `feeBps()` 50,
`insuranceFund()` == the shared fund `0x1a0d…403b`. InsuranceFund `hasRole(LIQUIDATOR_ROLE)`
for all three engines.

## Stage C — flip to multi-market (env vars only)

1. Railway — set on **all five** services, then redeploy each (a `variable delete` does not
   redeploy; `--set` does):
   `MARKET_REGISTRY_ADDRESS=<registry>` (order-book-server and matching-engine already have
   `BASE_SEPOLIA_RPC_URL`). Leave the old single-set vars in place for now (ignored in
   registry mode; they make rollback a one-var change).
2. Vercel — add `NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS=<registry>`, redeploy.
3. Check: every `/health` → `registry.mode == "registry"`, `marketCount` 3, no `lastError`;
   liquidation-keeper `/health` `.markets` lists all three with holder indexes backfilling
   from each `startBlock` (new markets: a few hundred blocks, instant). `GET /markets` on the
   order book lists all three. Run the uptime workflow manually: three funding checks.
4. Ops: liquidator float still ≥ the largest single claim (unchanged); keeper wallet has
   KEEPER_ROLE on both new CreditMarkets (AddMarket asserted it); top up keeper ETH — it now
   sends one accrue tx per market per epoch.
5. Seed: `scripts/demo/mm-sepolia-seed.ts --market crwv` and `--market try` against the Railway
   order-book URL (deployer as maker; quotes around 10% and 2%). The deployer must hold
   minted CRWV/TRY sets and USDC approvals per new CLOB.
6. Frontend walk-through: home lists three markets ("Will CoreWeave …", "Will Turkey …");
   one small Upbet buy + Downbet buy per new market from a fresh wallet (approval prompt
   per market CLOB); portfolio aggregates; /liquidate empty.
7. Update `docs/hosted-env-vars.md` (registry address), `.github/workflows/uptime.yml`
   constants if needed, the frontend `docs/contract-addresses` page, `docs/HANDOVER.md`,
   memory notes.

**Rollback for stage C:** unset `MARKET_REGISTRY_ADDRESS` / `NEXT_PUBLIC_MARKET_REGISTRY_ADDRESS`
and redeploy → back to legacy `mstr`. CRWV/TRY contracts stay live on-chain (users can
still `redeem` directly; keepers stop accruing them — so only roll back before those markets
have real positions, or keep a keeper on them).
