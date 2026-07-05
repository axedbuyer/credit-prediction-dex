# Pari Demo Runbook (BD Meeting)

This runs the whole product — landing page, live order book, price chart,
funding carry, a real trade through the CLOB, a frozen/distressed position, a
liquidation claim, and a credit-event settlement — on a local anvil chain that
takes about 90 seconds to seed. Everything lives under `scripts/demo/`.

Terminology used below matches the product's UI language: **Upbet = YES**,
**Downbet = NO**. Never say "YES/NO token" or "hazard rate" out loud in the
room — see root `CLAUDE.md`.

---

## Before the meeting (do this the night before, or 15 minutes ahead)

1. **Bring up the stack:**
   ```
   cd scripts/demo
   ./demo-up.sh
   ```
   Takes ~1-2 minutes (anvil boot, deploy, ~90s of on-chain seeding: a NO-token
   sell-off for two distressed wallets, a chart-history time warp of ~11
   months, a keeper flag, fresh mints, a resting order book, and a few
   recent trades). It prints a summary block at the end with every contract
   address and all four wallet private keys — keep that terminal open, or
   re-run `cat scripts/demo/.run/env.sh` any time during the meeting.

2. **Import the 4 demo wallets into MetaMask** (private key import), one
   nickname each so you can switch fast:
   | Nickname | Role | Anvil account |
   |---|---|---|
   | Presenter | buys Upbet live | #3 |
   | Market Maker | resting book liquidity (you don't switch to this one) | #4 |
   | Distressed Upbet | close to frozen, not yet flagged | #5 |
   | Doomed Upbet | already flagged claimable | #6 |

   Keys are printed by `demo-up.sh` and also saved in
   `scripts/demo/.run/env.sh` as `A_KEY`/`C_KEY`/`D_KEY` (`B_KEY` too, though
   you won't need to switch into it live).

3. **Add the network in MetaMask:** name it "Pari Local", RPC URL
   `http://127.0.0.1:8547`, chain ID `84532`, currency `ETH`. **Chain ID 84532
   is also real Base Sepolia's ID** — MetaMask will treat this as a second RPC
   entry for the same network rather than a new one. That's fine: add it as
   an additional RPC under the existing Base Sepolia network entry and make
   sure it's the **selected** RPC before you start (MetaMask shows the active
   RPC under the network name). If you're demoing from a machine that also
   uses real Base Sepolia, double check the selection right before walking on
   stage — an easy mixup.

4. **Open http://localhost:3010 and click through every page once**
   (landing, market, portfolio, liquidate, admin) so Next.js finishes
   compiling each route ahead of time — the first hit after `next dev` starts
   is slow, subsequent ones are instant.

5. Sanity-check the demo beats are seeded correctly before anyone walks in:
   ```
   curl -s http://localhost:3013/claimable                 # should list Doomed Upbet (wallet D)
   curl -s http://localhost:3011/orderbook                 # should show ~4 bids / ~4 asks
   ```

---

## Minute-by-minute demo script

**0:00 — Landing page.** `http://localhost:3010`. Set the scene: a fully
collateralized prediction market on MicroStrategy credit risk, Polymarket-style
Upbet/Downbet tokens, on-chain settlement.

**1:00 — Market page.** Order book, price chart (~11 months of history,
climbing from ~23% to ~31%), and the funding/carry ticker. Point out the
resting book depth (3 bids / 3 asks around the current price) and the DAILY
CARRY ticker — Upbet holders pay carry to Downbet holders every epoch, which
is what makes this a real credit instrument and not just a binary bet.

**3:00 — Connect Wallet (Presenter).** Switch MetaMask to the Presenter
account. Portfolio shows a small existing Upbet position plus USDC (seeded so
there's something to look at even before the live trade).

**4:00 — Buy Upbet, live.** On the market page, place a small buy that crosses
one of the Market Maker's resting asks. Walk through: sign the EIP-712 order
in MetaMask (no gas — it's off-chain until matched) → the matching engine
picks it up within ~500ms → `CLOBSettlement.verifyAndSettle` confirms on
anvil → the filled ask shrinks or disappears from the order book (2s poll)
and the position is yours — show it in Portfolio in the next beat.

**5:30 — Portfolio.** Refresh: the new position is there — cost basis, equity,
P&L, and (Upbet-only) Epochs To Expire.

**6:30 — Fast-forward the funding clock.** In a terminal:
   ```
   cd scripts/demo
   ./warp.sh 3
   ```
   This jumps chain time forward 3 days and accrues funding. Narrate: this
   simulates real carry passing in seconds. Run it again (`./warp.sh 5` or so)
   if you want to push further — the script prints Distressed Upbet's
   (wallet C) `isSeizable`/`epochsToExpire` after every call, and **the moment
   it crosses the trigger it auto-flags the position** (simulating the
   funding-keeper's reaction, which in production ticks every 8 real-world
   hours and can't react live in a demo).

**7:30 — Switch to Distressed Upbet (wallet C).** Portfolio now shows the
frozen-position panel: a client-side cure-cost estimate, "approve" then
"cure" buttons. Walk through **cure()**: the holder pays the frozen funding
obligation in cash, keeps the Upbet position *and* the ~3% sliver a liquidator
would otherwise have earned, and accrual resumes from now. Click cure — the
position unfreezes live.

**9:00 — `/liquidate` page.** Switch back to Presenter (or stay on whichever
wallet — liquidation is permissionless, anyone can claim). Doomed Upbet
(wallet D) is listed — it was seeded already flagged. Show the claim price
(fixed by formula, no Dutch auction/discount ticker) and click **Claim**: the
Doomed Upbet token transfers to the claiming wallet (never burned), NO holders
are made whole from the claim payment, and the position disappears from the
claimable list.

**10:30 — Admin page.** Team-only credit-event submission. Confirm a credit
event for the market (pauses trading, sets `creditEventConfirmed`).

**11:30 — Portfolio, one more time.** Upbet settles at $1.00 (full notional,
zero recovery) via `settleYES`; Downbet is worth $0. This is the payoff that
makes the whole thing a real credit hedge, not just a chart.

**12:30 — Wrap.** Return to the landing page. Q&A.

---

## Useful commands mid-meeting

```
cd scripts/demo
cat .run/env.sh                 # every address + private key, source-able
./warp.sh <days>                # advance chain time, accrue funding, auto-flag if triggered
curl -s http://localhost:3013/claimable | jq   # (no jq in this sandbox — pipe to `node -e` or just eyeball the JSON)
```

If a page looks stale, it's polling — give it a couple seconds, or refresh.

---

## After the meeting

```
cd scripts/demo
./demo-down.sh
```
Kills only the processes this script started (anvil :8547, redis if it
started one, order-book-server :3011, matching-engine, both keepers, next dev
:3010), restores `contracts/deployments/base-sepolia.json` and
`frontend/.env.local` to their pre-demo state via git, and removes
`scripts/demo/.run/`. It does **not** touch your own long-lived dev services
(anvil :8545/:8546, order-book-server :3001, next dev :3000) — those keep
running untouched throughout.

---

## Known environment quirks (read once, then ignore)

- **A stray redis on :6380 and orphaned matching-engine processes may already
  exist** from an earlier, incomplete attempt at wiring this exact demo (found
  during development — evidence in a shell history, not something either of
  us set up on purpose, and not always killable due to process-ownership
  restrictions in some environments). `demo-up.sh` reuses (and flushes) an
  existing redis on :6380 rather than failing; it does not try to touch
  unrelated matching-engine processes. If trades stop matching for no visible
  reason, check `ps aux | grep matching-engine` for a duplicate.
- **YES/NO tokens report 18 decimals via ERC20 `decimals()`** even though
  every amount in the system (mint, trade, funding) is computed in the same
  raw 6-decimal scale as USDC (`mint(usdcAmount)` mints the identical raw
  integer to both legs). MetaMask's own token-balance display for YES/NO (if
  you ever add them as custom tokens) will be wrong by a factor of 10^12 —
  don't do that live; read balances from the app's portfolio page instead,
  which already knows to treat them as 6-decimal.
- **The funding-keeper's cron is wall-clock (every 8h), not chain-time** — it
  will not react to `warp.sh` during the meeting. `warp.sh` compensates by
  flagging the position itself the moment it crosses the trigger.
- Google Fonts fetches fail in a no-network sandbox (`next dev` falls back to
  system fonts automatically) — cosmetic only, ignore the console warning.
- **If trades stop matching mid-demo** (a price level looks permanently
  wedged — nothing fills even though bid/ask are clearly crossed), the fix in
  v1b1-7 covers the known cause (a non-pruned `verifyAndSettle` revert, e.g.
  `OrderExpired`, used to leave both matched orders stuck forever in the
  engine's in-memory pending-settlement set). If a fresh wedge shows up
  anyway, the fastest recovery is to just restart the matching engine — it
  has no persistent state of its own (the order book lives in Redis, not in
  the engine process):
  ```
  cd scripts/demo
  source .run/env.sh
  kill "$(cat .run/matching-engine.pid)" 2>/dev/null   # or: pkill -f 'backend/matching-engine'
  cd ../../backend/matching-engine
  ORDER_BOOK_URL=http://localhost:3011 POLL_INTERVAL_MS=500 \
    YES_TOKEN_ADDRESS="$YES_ADDR" NO_TOKEN_ADDRESS="$NO_ADDR" USDC_ADDRESS="$USDC_ADDR" \
    SETTLER_PRIVATE_KEY="$SETTLER_KEY" BASE_SEPOLIA_RPC_URL="$RPC_URL" \
    REDIS_HOST=localhost REDIS_PORT="$REDIS_PORT" \
    nohup npm run dev >/tmp/matching-engine-restart.log 2>&1 &
  ```
  (this mirrors the exact env block `demo-up.sh` uses to launch it — see
  `scripts/demo/demo-up.sh`'s "6. matching-engine" step). If instead just one
  specific order looks stuck (not the whole book), it's usually faster to
  cancel it directly with `scripts/demo/cancel-order.ts` rather than
  restarting the whole engine:
  ```
  cd scripts/demo
  source .run/env.sh
  ORDER_BOOK_URL=http://localhost:3011 CLOB_SETTLEMENT_ADDRESS="$CLOB_ADDR" CHAIN_ID="$CHAIN_ID" \
    ./node_modules/.bin/tsx cancel-order.ts <orderId> <A|B|C|D>
  ```
