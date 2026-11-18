# Credit-event runbook

How the team handles a credit event. Policy: the team multisig follows the ISDA Credit
Derivatives Determinations Committee (DC). User-facing copy:
`frontend/app/docs/credit-events/page.tsx`. Invariants: root `CLAUDE.md` 5 and 10.

## 1. Roles and wallets

| Who | What |
|---|---|
| Attester / admin | Today the deployer EOA `0x0D0917e418bc99Ecbfbd1Eb25a98d09CeFB580f1`; a 2-of-3 Safe before mainnet. Holds `ORACLE_ROLE` on each OracleRouter and acts through `/admin`. |
| OracleRouter | Holds CreditMarket `ORACLE_ROLE` and forwards `confirmCreditEvent()` (and, from batch 4, `setMotionPending(bool)`). On batch 3 the attester also gets CreditMarket `ORACLE_ROLE` via `GrantMotionRole.s.sol` (§7). |
| Monitor | One named team member on rota; backup named in the team channel. |

Addresses per market: `contracts/deployments/base-sepolia/markets/<slug>.json`
(`$CREDIT_MARKET`, `$ORACLE_ROUTER`).

## 2. Monitoring

- Watch **All DC Requests** at https://www.cdsdeterminationscommittees.org/ at least twice
  a day (every working day), and daily at weekends while any market is listed.
- Look for a question on a listed entity (MicroStrategy, CoreWeave, Republic of Turkey), e.g.
  "Has a Bankruptcy Credit Event occurred with respect to CoreWeave, Inc.?".
- Also watch the entity's news (filings, missed coupons, moratorium announcements). A DC
  question is the trigger for action; news is early warning only.

## 3. Decision table

| Event | Action | Result |
|---|---|---|
| DC question on a listed entity appears | **Open motion** on that market (optional `pause()`) | Flagging and liquidation claims freeze |
| DC rules **Yes** on an event type the market covers | `confirmCreditEvent()`; **leave the motion open** | Market pauses; YES redeems 1:1 via `settleYES` |
| DC rules **Yes** on a type the market does NOT cover | **Close motion**, `unpause()` if paused; no settlement | Market resumes |
| DC rules **No** or declines | **Close motion** + `unpause()` | Market resumes |

Covered types: corporate (MSTR, CRWV) Bankruptcy, Failure to Pay; Turkey Failure to Pay,
Repudiation/Moratorium, Restructuring. Nothing on-chain encodes the type; the team checks it.
Pause halts mint, redeem and cure; carry keeps accruing and CLOB trades still settle.

## 4. Actions

### Via `/admin` (preferred)

Connect the attester wallet, pick the market, then **Open motion**, **Pause**,
**Confirm credit event**, **Close motion** or **Unpause**. `/admin` refuses to confirm
unless a motion is open, and refuses to close a motion after a confirmed event.

### Fallback with `cast`

Key stays in the environment or a keystore, never inline in the command.

```bash
export PATH=$HOME/.foundry/bin:$PATH
RPC_URL=https://sepolia.base.org
# Open / close motion (batch 4: through the router)
cast send $ORACLE_ROUTER "setMotionPending(bool)" true  --rpc-url $RPC_URL --private-key $ATTESTER_KEY
cast send $ORACLE_ROUTER "setMotionPending(bool)" false --rpc-url $RPC_URL --private-key $ATTESTER_KEY
# Pause / unpause (PAUSER_ROLE holder)
cast send $CREDIT_MARKET "pause()"   --rpc-url $RPC_URL --private-key $ATTESTER_KEY
cast send $CREDIT_MARKET "unpause()" --rpc-url $RPC_URL --private-key $ATTESTER_KEY
# Confirm (only after a DC Yes on a covered event, motion already open)
cast send $ORACLE_ROUTER "confirmCreditEvent()" --rpc-url $RPC_URL --private-key $ATTESTER_KEY
```

Use `--account <keystore>` instead of `--private-key` where a keystore exists. On a Safe,
submit the same calls as Safe transactions.

## 5. After confirmation

```bash
cast call $CREDIT_MARKET "creditEventConfirmed()(bool)" --rpc-url $RPC_URL   # true
cast call $CREDIT_MARKET "motionPending()(bool)"        --rpc-url $RPC_URL   # true (stays)
cast call $CREDIT_MARKET "paused()(bool)"               --rpc-url $RPC_URL   # true
```

- The motion stays open forever. Do not close it.
- From Portfolio, a holder's **settleYES** works: Upbets pay $1, Downbets $0.
- Keepers and the liquidator bot skip flag/claim on this market. Check their logs.
- Other markets are unaffected; do not touch them.

## 6. Comms

- **Motion opened:** announce within the hour: "A DC question has been raised on
  [Entity]. Liquidations on this market are frozen while it is decided. Trading continues."
- **Result:** announce the DC ruling with a link. Confirmed: say Upbets now redeem at $1 on
  Portfolio. Rejected: say the market has resumed.

## 7. Batch-3 caveat (until batch 4 is live)

On batch-3 contracts the attester has no motion rights by default, and confirmation does
NOT block flagging or claims by itself. Until `GrantMotionRole.s.sol` has been run by the
owner and the batch-4 contracts are live:

- **Never confirm without an open motion** (a liquidator could seize an Upbet about to pay
  $1 at the stale mark).
- **Never close a motion after confirming.**
- Batch-3 motions go directly to CreditMarket (`$CREDIT_MARKET`, not the router), and only
  work once the attester holds CreditMarket `ORACLE_ROLE`:
  `cast send $CREDIT_MARKET "setMotionPending(bool)" true --rpc-url $RPC_URL --private-key $ATTESTER_KEY`.

Batch 4 removes both limits on-chain (`docs/redeploy-batch4-runbook.md`).
