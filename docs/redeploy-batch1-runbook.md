# Redeploy batch 1 — runbook (Base Sepolia)

Full fresh deploy of all seven contracts (CreditMarket changed, so everything that
references it is redeployed — `docs/redeploy-guide.md` §3c). Ships:

- the unified `owed()` fix for findings F1, F2, F4 (`docs/security/invariant-findings-2026-09-26.md`);
- launch guard-rails: `depositCap`, bounded `setMark` (+ `adminSetMark` override);
- Slither follow-ups (constructor zero-address checks, `nonReentrant` `coverShortfall`);
- a `Deploy.s.sol` that grants every role and sets every parameter in one broadcast, then
  asserts the configuration on-chain (KEEPER/PAUSER grants are no longer manual; the
  OracleRouter attester role — never granted on the 2026-07 system — is now granted).

Code: branch `fix/unified-owed` (draft PR, **do not merge before step 3.4**).

## Rehearsal evidence (2026-09-29)

Broadcast to a local anvil fork of Base Sepolia (block 47,457,707) from a clean checkout of
`5584d35`: 24 txs, **8,623,263 gas** (≈0.00005 ETH at 0.006 gwei), post-broadcast
assertions passed, tracked deployments JSON untouched. On the fork: all roles/fee/cap/bounds
as intended; mint works, `owed()` live; keeper 23%→27% after 1h ✓, immediate second update →
`MarkUpdateTooSoon` ✓, 27%→40% after the interval → `MarkStepTooLarge` ✓, 27%→31% ✓. An
earlier fork run also exercised flag + tail-case claim: `P = min(owed, m×Q)` exact,
InsuranceFund covered exactly `owed − m×Q`, YES transferred not burned.

Test suites on the branch: 151 contract tests (incl. a 21-selector invariant suite, 9/9
planted bugs caught), keepers 184, order-book-server 91, matching-engine 44, frontend
type-check clean.

## Parameters (defaults in `Deploy.s.sol`; override via env)

| Env | Default | Meaning |
|---|---|---|
| `DEPOSIT_CAP` | `50000000000` | 50,000 USDC of outstanding complete sets (raw 6-dec) |
| `MAX_MARK_STEP` | `50000000000000000` | a keeper `setMark` may move ≤ 5 percentage points… |
| `MIN_MARK_INTERVAL` | `3600` | …and at most once per hour (admin `adminSetMark` bypasses) |
| `KEEPER_ADDRESS` | `0x63F9…FeC54` | funding-keeper wallet (KEEPER_ROLE) |
| `PAUSER_ADDRESS` / `ORACLE_ATTESTER_ADDRESS` / `TEAM_WALLET` | deployer | until the Safe ceremony |

`INITIAL_MARK` 23%, fee 50 bps split 50/50, epoch 1 day — unchanged.

## 0. Pre-flight

1. Branch CI green on the draft PR; local `cd contracts && forge test` green.
2. `git status` clean and `git log -1` = the reviewed commit — the broadcast compiles the
   working tree.
3. Deployer ETH ≥ 0.0003 (was 0.00083 on 2026-09-29).
4. **Vercel env vars can't be changed from this machine** — the owner does step 3.2 in the
   dashboard.

## 1. Wind down the old system (≈5 min)

The old market holds only the deployer's 12 complete sets (12 USDC collateral, no debt, no
other holders, empty InsuranceFund).

```bash
cd contracts && set -a && . ./.env && set +a
OLD_CM=0x26C3d2E6C29e8E414A4424aa9c9AFa5eFF15F51b
cast send $OLD_CM 'redeem(uint256)' 12000000 --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url base_sepolia   # recovers 12 USDC
cast send $OLD_CM 'pause()' --private-key "$DEPLOYER_PRIVATE_KEY" --rpc-url base_sepolia                  # no new mints into the old market
```

The deployer's resting orders on the hosted book reference the old contracts; they're
flushed in 3.3. Trading is effectively down from here until 3.5.

## 2. Broadcast (≈5 min)

```bash
cd contracts && export PATH=$HOME/.foundry/bin:$PATH && set -a && . ./.env && set +a
git diff --quiet src script && forge test                  # clean + green
forge script script/Deploy.s.sol --rpc-url base_sepolia --broadcast --verify --slow
```

Must end with `=== Post-broadcast configuration assertions passed ===` and
`ONCHAIN EXECUTION COMPLETE & SUCCESSFUL`. It rewrites
`contracts/deployments/base-sepolia.json` (with `startBlock`). If `--verify` missed any
contract: `forge script script/VerifyContracts.s.sol --rpc-url base_sepolia`.

**Never** run a dry run against the real RPC first without restoring the deployments JSON
(the dry run rewrites it — HANDOVER gotcha). If the broadcast dies part-way, nothing live
references the new contracts yet: fix and re-run (fresh nonces → fresh addresses).
Rollback of step 1 = `cast send $OLD_CM 'unpause()'`.

## 3. Fan-out (≈20 min)

1. **Railway** (`--skip-deploys` on each; the merge in 3.4 redeploys everything):
   `CREDIT_MARKET_ADDRESS`, `YES_TOKEN_ADDRESS`, `NO_TOKEN_ADDRESS`, `CLOB_SETTLEMENT_ADDRESS`
   on order-book-server / matching-engine / funding-keeper / liquidation-keeper /
   liquidator-bot as each uses them (`docs/hosted-env-vars.md`), plus
   `LIQUIDATION_ENGINE_ADDRESS` + `INSURANCE_FUND_ADDRESS` on liquidator-bot and
   `HOLDER_INDEX_FROM_BLOCK = startBlock` on funding-keeper, liquidation-keeper and
   liquidator-bot. (Holder-index Redis keys are namespaced by token address — no flush.)
2. **Vercel** (owner, dashboard): the seven `NEXT_PUBLIC_*_ADDRESS` vars. Must be saved
   **before** 3.4 — the merge triggers the production build that bakes them in.
3. **Flush hosted Redis order state** (old EIP-712 domain → every resting order/nonce is
   dead): delete `orders:*`, `orderbook:*`, `nonces:*` only — never `holder-index:*`.
4. **Commit** the new `contracts/deployments/base-sepolia.json`, `docs/hosted-env-vars.md`,
   `.github/workflows/uptime.yml` (`CREDIT_MARKET_ADDRESS` constant for the funding-keeper
   staleness check) on the branch; mark the PR ready; **merge** → Railway rebuilds all five
   services, Vercel deploys production.
5. **Re-seed**: re-mint + two-sided quotes with the deployer (`scripts/demo/mm-sepolia-seed.ts`
   against the hosted book; it re-approves the new contracts), and deposit a few USDC into
   the new InsuranceFund (`deposit(uint256)`) so an early tail-case claim can't revert.

## 4. Verify (≈10 min)

- Explorer shows all seven contracts verified.
- order-book-server `/health`: `fee.source: "chain"`, `feeBps: 50` (new CLOB).
- liquidation-keeper `/health`: `holderIndex.backfillComplete: true`, `syncedToBlock` past
  `startBlock`, no `lastError`; funding-keeper and liquidator-bot logs clean.
- `/orderbook` shows the seeded quotes; one small test trade settles on-chain.
- Frontend: market page loads, position card reads `owed()`, a Downbet buy signs.
- Next funding-keeper tick accrues on the NEW market; uptime workflow run green.

## 5. After

Update `docs/HANDOVER.md` state + `CLAUDE.md` status (findings fixed AND deployed),
`docs/security/invariant-findings-2026-09-26.md` status, memory. The old contracts stay
paused and empty.
