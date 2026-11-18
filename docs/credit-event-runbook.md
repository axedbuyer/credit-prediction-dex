# Credit-event runbook

How the team handles a credit event. Policy: the team multisig follows the ISDA Credit
Derivatives Determinations Committee (DC). Design: `docs/design/motion-escrow-and-mark.md`.
User-facing copy: `frontend/app/docs/credit-events/page.tsx`. Invariants: root `CLAUDE.md`
5, 10 and 11.

Sections 1–6 describe **batch 4** (motions are informational and escrow post-EDD carry).
The live markets are still **batch 3**, which behaves differently. Read §7 until batch 4
is deployed.

## 1. Roles and wallets

| Who | What |
|---|---|
| Attester / admin | Today the deployer EOA `0x0D0917e418bc99Ecbfbd1Eb25a98d09CeFB580f1`; a 2-of-3 Safe before mainnet. Holds `ORACLE_ROLE` on each OracleRouter: open/close motions, confirm. |
| Motion opener | Optional hot key on the on-call rota with OracleRouter `MOTION_ROLE`: can only **open** a motion (`openMotion()`). A false motion only delays Downbet carry until the attester closes it. |
| OracleRouter | Holds CreditMarket `ORACLE_ROLE`; forwards `setMotionPending(bool)`, `openMotion()` and `confirmCreditEvent()`. |
| Monitor | One named team member on rota; backup named in the team channel. |

Addresses per market: `contracts/deployments/base-sepolia/markets/<slug>.json`
(`$CREDIT_MARKET`, `$ORACLE_ROUTER`).

## 2. Monitoring

- Watch **All DC Requests** at https://www.cdsdeterminationscommittees.org/ in a browser at
  least twice a day (every working day), and daily at weekends while any market is listed.
  The site's `robots.txt` disallows automated access: no scraper or poller without written
  permission from the site operator (requested via its contact page).
- Look for a question on a listed entity, e.g. "Has a Bankruptcy Credit Event occurred
  with respect to CoreWeave, Inc.?".
- Also set news alerts on each listed entity and on "Determinations Committee". A DC
  question is the trigger for action; news is early warning only.
- Speed matters: the motion's on-chain time is Pari's EDD. Carry between the DC request
  and the motion is not escrowed.

## 3. Decision table

| Event | Action | Result |
|---|---|---|
| DC question on a listed entity appears | **Open motion** on that market, at once | EDD recorded; post-EDD carry escrowed; trading, flagging, claims, Pay carry all continue |
| DC rules **Yes** on an event the market covers | Set `DC_YES_HOLD` (§4), then `confirmCreditEvent()` within minutes | Market pauses; post-EDD carry void and refunded to its payers; Upbets redeem at $1 via `settleYES` |
| DC rules **Yes** on an event the market does NOT cover | **Close motion** (treat as No) | Escrow released |
| DC rules **No** or declines | **Close motion** | Escrow released; post-EDD Upbet carry becomes ordinary debt |

Each market's covered events are framed by the team before listing (decided privately; never
name industry transaction types or settlement matrices in public copy or in git). Nothing
on-chain encodes the event type; the team checks it against the market's listed events.

## 4. Actions

### Via `/admin` (preferred)

Connect the attester wallet, pick the market, then **Open motion**, **Confirm credit event**
or **Close motion**. `/admin` refuses to confirm unless a motion is open, and refuses to
close a motion after a confirmed event. **Pause** is for emergencies only; it is not part of
the credit-event flow.

### Keeper flagging switch (`DC_YES_HOLD`)

Between a DC "Yes" announcement and the confirm transaction, liquidations still run. The
moment the DC announces Yes on a covered event, set `DC_YES_HOLD=<slug>` (comma-separate
several, or `*`) on the Railway **funding-keeper** and **liquidator-bot** services. Each
redeploys in about 1–2 minutes and then neither flags nor claims in that market; check
`dcYesHold` on the liquidator-bot `/health`. Claims by third parties on already-flagged
positions stay permissionless, so confirm fast. Remove the variable after confirmation (the
on-chain guard takes over). If the DC rules No, remove it when closing the motion.

### Fallback with `cast`

Key stays in the environment or a keystore, never inline in the command.

```bash
export PATH=$HOME/.foundry/bin:$PATH
RPC_URL=https://sepolia.base.org
# Open a motion (attester, or the motion-opener key)
cast send $ORACLE_ROUTER "openMotion()" --rpc-url $RPC_URL --private-key $ATTESTER_KEY
# Close a motion on a DC No (attester only)
cast send $ORACLE_ROUTER "setMotionPending(bool)" false --rpc-url $RPC_URL --private-key $ATTESTER_KEY
# Confirm on a DC Yes on a covered event, motion open (attester only)
cast send $ORACLE_ROUTER "confirmCreditEvent()" --rpc-url $RPC_URL --private-key $ATTESTER_KEY
# Read state
cast call $CREDIT_MARKET "motionPending()(bool)" --rpc-url $RPC_URL
cast call $CREDIT_MARKET "motionId()(uint256)" --rpc-url $RPC_URL
```

Use `--account <keystore>` instead of `--private-key` where a keystore exists. On a Safe,
submit the same calls as Safe transactions.

## 5. After a ruling

**Confirmed (Yes):**

```bash
cast call $CREDIT_MARKET "creditEventConfirmed()(bool)" --rpc-url $RPC_URL   # true
cast call $CREDIT_MARKET "motionPending()(bool)"        --rpc-url $RPC_URL   # false (resolved Yes)
cast call $CREDIT_MARKET "paused()(bool)"               --rpc-url $RPC_URL   # true
```

- From Portfolio, a holder's **settleYES** pays $1 per Upbet minus pre-EDD carry, plus any
  post-EDD carry they paid. Downbets are worth $0.
- Anyone can call `settleFunding(<address>)` to pay out an address's refund, including the
  InsuranceFund's.
- Keepers never flag and the liquidator bot never claims on this market again (on-chain
  guard). Other markets are unaffected.

**Closed (No):** escrowed Downbet carry is paid at each holder's next settlement
(`settleFunding(<address>)` works for anyone). Nothing else changes.

## 6. Comms

- **Motion opened:** announce within the hour: "A DC question has been raised on
  [Entity]. Trading and liquidations continue. Carry from now on is held until the DC rules:
  Upbet holders get it back if the DC rules Yes. Keep your carry paid to avoid liquidation."
- **Result:** announce the DC ruling with a link. Yes: Upbets redeem at $1 on Portfolio.
  No: held carry is paid out to Downbet holders.

## 7. Batch-3 caveat (until batch 4 is live)

Batch 3 (live) still has the OLD motion semantics: an open motion **freezes** flagging and
claims, carry is not escrowed, and confirmation does NOT block flagging or claims by itself.
The attester got CreditMarket `ORACLE_ROLE` via `GrantMotionRole.s.sol` (block 60319124).
Until batch 4 is live:

- **Never confirm without an open motion** (a liquidator could seize an Upbet about to pay
  $1 at the stale mark).
- **Never close a motion after confirming.**
- Batch-3 motions go directly to CreditMarket (`$CREDIT_MARKET`, not the router):
  `cast send $CREDIT_MARKET "setMotionPending(bool)" true --rpc-url $RPC_URL --private-key $ATTESTER_KEY`.
- Batch-3 comms: "Liquidations on this market are frozen while it is decided."

Batch 4 replaces all of this (`docs/redeploy-batch4-runbook.md`).
