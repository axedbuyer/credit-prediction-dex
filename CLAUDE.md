# Credit Prediction DEX — Project Context for Claude Code

## What We're Building

A fully-collateralized perpetual prediction market on corporate and sovereign credit default
probability. Users trade YES/NO tokens on the question:

> "Will [Entity] have a credit event in the next 12 months?"

The price of a YES token = implied annual default probability (%) = hazard rate.
Position economics are equivalent to a zero-recovery perpetual CDS, structured and
presented as a prediction market.

**Token model (Polymarket-style):** users deposit USDC and receive ERC-20 YES + NO tokens.
These tokens trade on the CLOB. On credit event: YES redeems 1:1 for USDC, NO redeems at $0.

Note: Polymarket uses Gnosis CTF (ERC-1155). We use custom ERC-20 for MVP — simpler to
build, better wallet visibility (auto-appears in MetaMask), same economic model. Migrate to
CTF in V2 if needed.

**⚠️ FUNDING MODEL v1b (mirrored index + formulaic liquidation) — ACTIVE for MVP.**
See "Funding Model v1b" section below. This fixes v1a's broken auto-close mechanism
(burning YES to enforce a cap breaks the YES/NO complete-set invariant — see rationale in
that section). v1b summary:
- cumFundingPerYES and cumFundingPerNO are tracked as two state variables, but since
  YES.totalSupply() == NO.totalSupply() ALWAYS (complete-set invariant), they are numerically
  identical at all times. No mirror-scaling math is needed — this corrects v1a's no-op formula.
- Display layer (per holder): Cost Basis, Equity, P&L, Breakeven Mark, and (YES only)
  Epochs To Expire — the runway until seizure at current mark.
- Seizure trigger (solvency-based, cost-basis-independent): when accrued funding closes to
  within 3% of token mark value, one epoch ahead, the YES position becomes liquidatable.
- LiquidationEngine.sol: formulaic (no Dutch auction) — price = funding owed at flag time.
  YES token TRANSFERS to the liquidator (never burned) — complete-set invariant intact,
  NO holders untouched, no free option for an underfunded YES holder.

---

## Key Decisions (Non-Negotiable)

| Decision | Value |
|---|---|
| Chain (MVP) | Base (EVM standard) |
| Collateral | USDC only |
| Settlement | YES/NO ERC-20 tokens — YES redeems 1:1 USDC on credit event, NO redeems $0 |
| Recovery rate | Zero — YES settles at $1.00 on credit event, NO at $0.00 |
| Funding (v1b) | cumFundingPerYES == cumFundingPerNO always (complete-set invariant); settled in USDC on close/redeem/settle/liquidation |
| Seizure trigger (v1b) | m ≤ 1.03 × f_next, evaluated one epoch ahead (3% buffer, cost-basis-independent) |
| Liquidation (v1b) | Formulaic price = funding owed; YES token TRANSFERS to liquidator (never burned); NO untouched |
| Price primitive | Hazard rate displayed as annual default probability (%) |
| Liquidity mechanism | Polymarket-style off-chain CLOB, on-chain USDC settlement |
| Protocol token | None |
| Leverage | None — fully collateralized |
| LP vault | None in MVP — team wallet seeds initial liquidity |

---

## MVP Scope — Single Market

**Reference entity:** MicroStrategy Incorporated
**Market name:** "Will MicroStrategy have a credit event in the next 12 months?"
**Ticker reference:** MSTR
**Credit events covered (MVP):** Bankruptcy, Failure to Pay
**Network:** Base Sepolia (testnet), then Base mainnet
**Initial seed price:** Set manually by team (reference MSTR CDS spread from TradFi sources)

---

## Architecture

### Smart Contracts

```
CreditMarket.sol      — mints/burns YES+NO tokens, holds USDC collateral, funding accrual, pause
YESToken.sol          — ERC-20, minted by CreditMarket; transferable only via CLOBSettlement
NOToken.sol           — ERC-20, minted by CreditMarket; transferable only via CLOBSettlement
CLOBSettlement.sol    — validates EIP-712 signed orders, atomically swaps tokens ↔ USDC
OracleRouter.sol      — receives credit event attestations, triggers settlement
InsuranceFund.sol     — USDC reserve, timelock-gated, receives 20% of trading fees
FeeDistributor.sol    — splits trading fees: 50% LP / 20% insurance / 30% treasury
```

**⚠️ FUNDING v1b — ONE NEW CONTRACT + tweak CreditMarket.sol:**
```
CreditMarket.sol      — add cumFundingPerNO (mirrors cumFundingPerYES exactly), display
                        helpers (equity, P&L, breakeven, epochsToExpire), seizure-trigger view
LiquidationEngine.sol — NEW. Formulaic claim of seizure-triggered YES positions.
                        No Dutch auction, no discount ramp — price is fully determined by
                        the funding-owed formula. YES token transfers, never burned.
```

**Funding v2 (FUTURE — not building now) would additionally add:**
```
FundingBuffer.sol     — per-wallet prepaid USDC buffer (v2 only — v1b has no buffer)
```
(v2's LiquidationEngine differs from v1b's: v2 adds a Dutch-auction discount ramp on top
of a buffer-exhaustion trigger. v1b's trigger and price are both purely formulaic.)

**Removed vs prior spec (USDC-direct scrapped):**
- ~~Position struct / position mapping~~ — replaced by token balances
- ~~USDC-direct settlement~~ — YES/NO ERC-20 tokens are the settlement vehicle

**Not needed in MVP:**
- MarketFactory.sol (single market, deploy directly)
- LiquidityVault.sol (team wallet provides liquidity manually)
- ISDARelayer.sol (multisig oracle only for MVP)
- BondModule.sol (no permissionless listing yet)

### Token Model (CreditMarket.sol)

```solidity
// Mint: deposit USDC, receive YES + NO tokens in proportion to current mark
function mint(uint256 usdcAmount) external {
    uint256 yesAmount = usdcAmount * currentMark / 1e18;
    uint256 noAmount  = usdcAmount * (1e18 - currentMark) / 1e18;
    USDC.transferFrom(msg.sender, address(this), usdcAmount);
    YES.mint(msg.sender, yesAmount);
    NO.mint(msg.sender, noAmount);
    _syncFunding(msg.sender);
}

// Redeem: burn equal YES+NO pair, get USDC back (pre-settlement only)
function redeem(uint256 tokenAmount) external {
    _syncFunding(msg.sender);
    YES.burn(msg.sender, tokenAmount);
    NO.burn(msg.sender, tokenAmount);
    USDC.transfer(msg.sender, tokenAmount); // 1 YES + 1 NO always = 1 USDC
}

// Settle YES: credit event confirmed, burn YES, receive 1 USDC each
function settleYES(uint256 amount) external onlyCreditEventConfirmed {
    YES.burn(msg.sender, amount);
    USDC.transfer(msg.sender, amount);
}
```

**Token transfer restriction:**
- YES and NO tokens override `_update()` (OZ v5): only `CLOB_ROLE` (CLOBSettlement) and
  CreditMarket itself may transfer tokens. Direct wallet-to-wallet transfers blocked.
- This ensures all movements go through funding-sync paths.

**Funding tracking per address:**
```solidity
uint256 public cumulativeFundingPerYES; // increases over time
mapping(address => uint256) public fundingSnapshot; // snapshot at last sync

function _syncFunding(address user) internal {
    uint256 owed = YES.balanceOf(user) * (cumulativeFundingPerYES - fundingSnapshot[user]) / 1e18;
    fundingSnapshot[user] = cumulativeFundingPerYES;
    // deduct `owed` USDC from user's claimable balance or deduct on next redeem
}
```

---

## ⚠️ Funding Model v1b (Mirrored Index + Formulaic Liquidation) — ACTIVE

**This is the canonical funding spec for the MVP. It supersedes v1a, whose auto-close-at-cap
mechanism was broken (see rationale below). v1b adds one new contract (LiquidationEngine.sol)
but keeps everything else lightweight: no buffer, no Dutch auction, no non-linear mark.**

### Why v1a was broken (do not implement v1a's auto-close)

v1a tried to cap YES funding owed at token value and, when the cap was hit, **burn the YES
token** to auto-close the position. This breaks the complete-set invariant:

```
YES.totalSupply() == NO.totalSupply()  ALWAYS — every mint/redeem moves both supplies
                                         by the same amount, so the ratio is always exactly 1.
```

Burning YES alone (without burning a matching NO) breaks this invariant, creating orphaned
NO tokens whose paired YES no longer exists — those NO holders are still credited funding
that no YES holder is paying. v1a's "mirror scaling by YES.totalSupply()/NO.totalSupply()"
was a no-op (the ratio is always 1) dressed up as a safety mechanism — it did nothing.

There are only two coherent ways to retire a YES position: burn the matching NO too (unfair
— force-closes an innocent NO holder to punish a delinquent YES holder), or **transfer the
YES to someone who keeps paying** (a liquidator). v1b takes the second path.

### Display layer (per holder, shown in UI — does not move cash)

```
Cost Basis (c)        = entry mark (the mark at which YES was bought)
Equity (E)             = m − f_now              // m = current mark, f_now = funding
                                                  // accrued per unit since entry
P&L                    = E − c = (m − c) − f_now
Breakeven Mark         = c + f_now               // mark needed for P&L = 0
Epochs To Expire (YES) = floor( (m/1.03 − f_now) / Δf ),  Δf = m × Δt/365
                          // epochs of runway until seizure trigger, holding m constant
```

`Epochs To Expire` is YES-only (NO never gets liquidated). Worked example at entry
(c = m = 0.05, f_now = 0, daily epoch): Δf = 0.05/365 ≈ 0.000137, Epochs To Expire =
(0.0485/0.000137) ≈ 354 days — consistent with "≈1 year of funding ≈ full token value."

### Seizure trigger (solvency-based, cost-basis-independent)

```
f_next = f_now + m × Δt/365                  // funding owed after one more epoch
Seize when:  m ≤ 1.03 × f_next               // 3% buffer, evaluated one epoch ahead
```

This keys on **equity remaining relative to token value**, never on P&L or cost basis. A
holder deep underwater on the mark but current on funding is left alone — they may be
sitting on cheap protection that pays par on a jump-to-default (negative MTM is never a
liquidation trigger). Cost basis must NOT appear in the trigger: two holders with identical
funding/mark exposure but different entry prices must be equally liquidatable, or one of
them gets a free option at the other's (and NO's) expense.

The 3% buffer doubles as the liquidator's profit margin (see Liquidation Math below) — it
is not just a safety cushion, it is the incentive that makes someone actually claim the
position.

### Liquidation math (locked — formulaic, no Dutch auction)

When the trigger fires, the keeper flags the position claimable and **freezes its funding
accrual** (f_now is locked at the flagging value — no further funding accrues against this
specific position until claimed). This avoids race conditions and keeps the price formula
deterministic.

```
At flag time:
  f_now  = funding owed, frozen at flagging
  m      = current mark (token value per unit notional)

Claim (anyone, first to call — no auction, no discount ramp):
  P = min(f_now, m)                     // formulaic price, capped at token value

  NORMAL CASE (f_now ≤ m — expected, given the 3% buffer):
    Liquidator pays P = f_now USDC → entirely to NO accretion (NO made whole, untouched)
    YES token TRANSFERS to liquidator (NOT burned) — liquidator's funding snapshot resets
      to current cumFundingPerYES (fresh start, inherits the token's full value m, owes
      no back-funding)
    Residual to original holder = 0   // the (m − P) sliver, ≈3% of m, is NOT returned to
      the original holder — it is the liquidator's compensation for executing the seizure
    Liquidator profit (before resale costs) = m − P ≈ 0.03 × m  (the trigger buffer)
    Liquidator resells the YES token on the CLOB for ≈ m, capturing the sliver as profit

  TAIL CASE (f_now > m — keeper downtime / mark gap caused a missed window):
    Liquidator pays P = m (full token value) → to NO accretion
    InsuranceFund tops up the shortfall (f_now − m) → NO accretion
    (so NO is ALWAYS made whole, even in the tail case)
    YES token still transfers to liquidator at P = m (fair — they paid full value)
```

**Why this is NOT "sold at zero":** the YES token is *transferred*, not burned/redeemed — it
still carries full value `m` to whoever holds it. If the liquidator paid zero, NO would be
shorted the ~97% of token value that funding had already accrued and that NO's accretion
index had already promised. Paying `P = f_now` is what actually settles that promise. The
liquidator's profit is the buffer sliver (`m − f_now`), not the whole token value.

**Functionally, liquidation is a forced sale at a below-market formulaic price** — mechanically
similar to a normal CLOB sale (funding is synced, snapshot resets) except the proceeds split
differently: in a normal sale, the seller keeps `m − f_now`; in a liquidation, the liquidator
keeps it instead, as payment for performing the seizure the original holder failed to avoid.

### Critical invariants (enforce in code AND tests)

```
1. Cost basis is NEVER part of the seizure trigger. Trigger keys only on equity vs mark.
2. Negative MTM is NEVER a liquidation trigger by itself — only equity-vs-mark matters.
3. YES tokens are NEVER burned in liquidation — only TRANSFERRED. Complete-set invariant
   (YES.totalSupply() == NO.totalSupply()) must hold before and after every liquidation.
4. NO holders are ALWAYS made whole on a liquidation — P = f_now in the normal case,
   topped up by InsuranceFund in the tail case. NO is never haircut.
5. FREEZE all flagging and claims during a pending credit-event motion (motionPending).
   Never seize someone's protection at a discount moments before it could pay.
6. Liquidation claims are permissionless and first-come — no single liquidator is
   load-bearing. (Known MVP limitation: first-valid-tx-wins has MEV/front-run exposure;
   acceptable for MVP, revisit with private relay if it becomes a problem.)
```

### What stays the same as v1

- Complete-set invariant: 1 YES + 1 NO ← $1 collateral, redeemable for $1, resolves $1/$0.
- Zero recovery. YES settles at full notional on credit event.
- Off-chain CLOB, on-chain settlement.
- Linear token mark (price = hazard rate). v1b does NOT change the mark function.
  (Known tradeoff: mismarks convexity above ~10% hazard rate. Acceptable for MSTR MVP.)

---

## Funding Model v2 (FUTURE — not building now)

Documented for the roadmap only. v2 would add a per-wallet prepaid USDC buffer (so YES
holders get runway before liquidation, rather than relying solely on token-value headroom)
and a Dutch-auction discount ramp (rather than v1b's fixed formulaic price), plus a
non-linear token mark V=(1−e^(−s)) for correct convexity at high hazard rates. v1b already
has the core liquidator mechanism and the no-free-option guarantee — v2 only adds runway
and pricing refinements. Build only after v1b validates PMF and the no-buffer tradeoff
(tighter, more frequent liquidations) proves to be a real UX problem.

---

### CLOB Architecture (Polymarket-style)

Off-chain matching, on-chain USDC settlement:

```
User signs EIP-712 limit order (tokenIn, tokenOut, amountIn, minAmountOut, expiry, nonce)
        ↓
Order submitted to off-chain order book server via REST API
        ↓
Matching engine matches compatible buy/sell orders
        ↓
Matched pair submitted to CLOBSettlement.sol on-chain
        ↓
Contract verifies both signatures →
  syncs funding for both parties (calls CreditMarket._syncFunding) →
  atomically: transfers YES (or NO) tokens from seller to buyer,
              transfers USDC from buyer to seller
```

**Order struct (EIP-712 typed data):**
```solidity
struct Order {
    address maker;
    address tokenIn;     // USDC (buying tokens) or YES/NO address (selling tokens)
    address tokenOut;    // YES or NO address (buying) or USDC (selling)
    uint256 amountIn;
    uint256 minAmountOut; // encodes limit price
    uint256 expiry;
    uint256 nonce;
    bytes   signature;
}
```

**Settlement flow on match (e.g. YES buy):**
```
Buyer:  sends USDC → receives YES tokens
Seller: sends YES tokens → receives USDC
CLOBSettlement calls CreditMarket._syncFunding(buyer) and _syncFunding(seller) first
Then atomically executes both transfers
```

### Backend Services

```
/order-book-server    — REST: POST /order, DELETE /order/:id, GET /orderbook
/matching-engine      — price-time priority matching, submits matched pairs on-chain
/funding-keeper       — v1b: accrueFunding() every epoch, bumps cumFundingPerYES (NO
                        mirrors it exactly); checks seizure trigger per holder; flags +
                        freezes f_now for any position that breaches it
/liquidation-keeper   — v1b: NEW. Exposes GET /claimable (flagged positions + formulaic
                        price P). Does NOT claim itself — claiming is permissionless.
/oracle-monitor       — placeholder for ISDA DC scraper (manual multisig in MVP)
```

### Frontend (Next.js 14)

```
/app
  /market/[id]        — main trading page
  /portfolio          — YES/NO balances, display layer (Cost Basis/Equity/P&L/Breakeven/
                        Epochs To Expire for YES), redeem button
  /admin              — internal: submit credit event, pause market (team only)
  /liquidate          — v1b: NEW. Minimal liquidator dashboard — flagged positions + claim
/components
  OrderBook.tsx       — live bid/ask ladder (poll /orderbook)
  TradePanel.tsx      — enter USDC amount + select YES/NO, sign EIP-712 order
  PriceChart.tsx      — YES token price over time (TradingView Lightweight Charts)
  FundingTicker.tsx   — current annual carry displayed live
  PositionCard.tsx    — v1b: shows Cost Basis, Equity, P&L, Breakeven Mark; YES additionally
                        shows Epochs To Expire with a warning as it approaches zero
  LiquidationCard.tsx — v1b: NEW, simpler than v2's — no discount ticker (price is fixed
                        by formula, not an auction), just shows P and a "Claim" button
```

⚠️ v1b note: unlike v2, there is no buffer UI (no top-up/withdraw) — v1b has no buffer.
The only YES-side health signal is Epochs To Expire. Surface it prominently with a warning
as it nears zero, since that is the user's only early-warning signal before liquidation.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Smart contracts | Solidity 0.8.x, Foundry, OpenZeppelin v5 |
| Chain | Base (EVM) |
| Frontend | Next.js 14 (App Router), TypeScript, wagmi v2, viem, RainbowKit, Tailwind CSS |
| Charts | TradingView Lightweight Charts |
| Order book server | Node.js, TypeScript, Fastify, Redis (order state) |
| Indexing (MVP) | Direct RPC + event polling (no subgraph until V2) |
| Wallet | RainbowKit + wagmi v2 |
| Testing | Foundry (contracts), Vitest (frontend/backend) |
| Deployment | Base Sepolia → Base mainnet |

---

## Smart Contract Standards

- All contracts use OpenZeppelin v5
- UUPS proxy pattern on CreditMarket, CLOBSettlement, OracleRouter
- `AccessControl` roles: `DEFAULT_ADMIN`, `ORACLE_ROLE`, `KEEPER_ROLE`, `PAUSER_ROLE`, `CLOB_ROLE`
- `ReentrancyGuard` on every function that transfers USDC or YES/NO tokens
- Pull-over-push for all USDC payouts — never push to arbitrary addresses
- YES/NO token transfers restricted to `CLOB_ROLE` and CreditMarket via `_update()` override
- `Pausable` on CreditMarket — PAUSER_ROLE halts market during determination window
- Emit events on every state change: TokensMinted, TokensRedeemed, YESSettled,
  FundingAccrued, CreditEventTriggered, MarketPaused

---

## Core Math

**Mint (deposit USDC, receive YES + NO tokens):**
```
yesAmount = usdcIn × currentMark / 1e18
noAmount  = usdcIn × (1e18 − currentMark) / 1e18
invariant: yesAmount + noAmount = usdcIn  (fully collateralized)
```

**Redeem (burn 1 YES + 1 NO, receive 1 USDC — pre-settlement only):**
```
usdcOut = tokenAmount × 1  (always 1:1, YES+NO pair = 1 USDC)
```

**Funding accrual — ⚠️ SEE "FUNDING MODEL v1b" SECTION ABOVE (canonical).**
Key formulas:
```
Token mark:    m = currentMark (linear, unchanged from v1)
YES index:     cumFundingPerYES += m × Δt / 365 days
NO mirror:     cumFundingPerNO  = cumFundingPerYES   ← EXACTLY equal, always
                                  (YES.totalSupply()==NO.totalSupply() always, so the
                                   "mirror scaling" in v1a was a no-op — removed in v1b)
YES owed:      balance × (cumFundingPerYES − snapYES) / 1e18      ← f_now, per holder
NO credit:     balance × (cumFundingPerNO  − snapNO)  / 1e18
Seizure:       m ≤ 1.03 × (f_now + m×Δt/365)   → flag claimable, freeze f_now
Liquidation:   P = min(f_now, m) → to NO accretion; YES TRANSFERS to liquidator (never
               burned); residual (m−P in normal case) kept by liquidator, not returned
Settled:       on CLOB exchange, redeem, settleYES, or liquidation claim
```

**Credit event settlement:**
```
YES token → burns at 1 USDC each  (full notional, zero recovery)
NO token  → worth $0, no redemption
```

**CLOB trade price:**
```
Buying  YES: pay P USDC per YES token  (P = current market ask, 0 < P < 1)
Selling YES: receive P USDC per YES token
Price P represents the market-implied annual default probability
```

---

## UX / Naming Conventions

**Never use in UI:** hazard rate, bps, basis points, protection buyer/seller, notional, token

**Always use in UI:**
- "YES" / "NO" (not long/short)
- "X% annual probability"
- "Daily carry" (not funding rate)
- Market title: "Will MicroStrategy have a credit event in the next 12 months?"
- Price: "23.4% chance"
- YES costs 23.4¢ per $1 / NO costs 76.6¢ per $1
- "Your position: $500 YES @ 23.4% entry"

---

## What NOT to Build in MVP

```
❌ Gnosis CTF / ERC-1155 (custom ERC-20 YES/NO tokens for MVP)
❌ Multiple markets (MSTR only)
❌ LP vault / LPToken (team wallet is liquidity provider)
❌ MarketFactory (deploy CreditMarket directly)
❌ ISDA oracle relayer (multisig only)
❌ USDC bond module for credit event disputes
❌ Subgraph / The Graph (direct RPC polling only)
❌ Fee distribution (fees accumulate in contract)
❌ Referral system
❌ Governance
❌ Insurance fund withdrawals (fund only receives in MVP)
❌ Market listing UI
❌ Mobile optimization (desktop-first)
❌ Wallet-to-wallet YES/NO transfers (CLOB_ROLE restricted only)
```

---

## Claude Code Task Sequence

Each task = one bounded Claude Code session. Work in order.

**Contracts:**
```
1. Init Foundry project, install OpenZeppelin v5, configure foundry.toml for Base.

2. YESToken.sol + NOToken.sol — ERC-20, minted by CreditMarket only. Override _update()
   to restrict transfers to CLOB_ROLE and CreditMarket address only.
   Tests: mint by authorized, mint by unauthorized reverts, transfer by CLOB_ROLE
   succeeds, direct wallet-to-wallet transfer reverts.

3. CreditMarket.sol — mint() and redeem() only, no funding yet.
   Tests: correct YES+NO amounts at different marks, redeem 1:1 invariant holds,
   USDC balances correct, token balances correct.

4. Add _accrueFunding() and fundingSnapshot tracking to CreditMarket.sol.
   Tests: zero funding at t=0, correct accrual after 1 day, correct after mark
   changes mid-period, funding deducted correctly on redeem/settleYES.

5. CLOBSettlement.sol — EIP-712 Order struct (tokenIn, tokenOut, amountIn,
   minAmountOut, expiry, nonce). verifyAndSettle() syncs funding for both parties
   then atomically swaps tokens ↔ USDC.
   Tests: valid YES buy, valid YES sell, valid NO buy, valid NO sell, expired order
   rejected, wrong signature rejected, duplicate nonce rejected, funding synced.

6. OracleRouter.sol — ORACLE_ROLE calls CreditMarket.confirmCreditEvent(), pauses
   mint/redeem, enables settleYES() at 1 USDC per token.
   Tests: role required, settleYES enabled after event, double-trigger blocked,
   YES redeems at 1 USDC, NO redemption reverts.

7. InsuranceFund.sol — receives USDC, ADMIN_ROLE withdraw with 48h timelock.

8. Integration test: full lifecycle —
   mint → sell NO on CLOB (hold YES) → hold 24h (vm.warp) → check funding →
   sell YES on CLOB → separately: trigger credit event → settleYES at 1 USDC.

9. Deploy scripts: deterministic deployment to Base Sepolia, Etherscan verification.
```

**Backend:**
```
10. Order book server — Fastify + TypeScript + Redis.
    Routes: POST /order (validate EIP-712 sig), DELETE /order/:id, GET /orderbook.

11. Matching engine — price-time priority, matches YES-buy vs YES-sell at overlap.

12. On-chain settlement — matched engine calls CLOBSettlement.verifyAndSettle() via viem.
    Handle gas estimation, nonce management, retry on failure.

13. Funding keeper — cron job every 8h calling CreditMarket.accrueFunding().
```

**Frontend:**
```
14. Next.js 14 scaffold — wagmi v2, RainbowKit, Tailwind, Base Sepolia config.

15. OrderBook.tsx — poll GET /orderbook every 2s, render bid/ask price ladder.

16. TradePanel.tsx — input USDC amount, select YES or NO direction. Calls
    CreditMarket.mint() first if user needs tokens, then constructs EIP-712 Order,
    signs with useSignTypedData, POSTs to order book server.

17. PriceChart.tsx — poll TokensMinted + CLOB trade events for price history,
    render with TradingView Lightweight Charts.

18. PortfolioPage — read YES.balanceOf(address) and NO.balanceOf(address).
    Show token balance, implied USDC value at current mark, accrued funding owed.
    Redeem button: burns YES+NO pair via CreditMarket.redeem().
    SettleYES button: appears only after credit event confirmed.

19. AdminPage — OracleRouter.confirmCreditEvent() multisig UI (ORACLE_ROLE only).
```

---

## ⚠️ Claude Code Task Sequence — v1b Funding Fix (INCREMENTAL)

These tasks implement the v1b funding model: mirrored index (no-op scaling removed),
display layer, formulaic seizure trigger, and LiquidationEngine.sol (one new contract).
Do them AFTER the base MVP (tasks 1–19) is complete and tested. See the dedicated
MVP_v1b_BUILD_GUIDE.md for full copy-paste prompts — this is the summary index.

**Contracts (v1b):**
```
v1b-1. Add cumFundingPerNO to CreditMarket.sol. Since YES.totalSupply()==NO.totalSupply()
       always, cumFundingPerNO is simply set equal to cumFundingPerYES on every accrual —
       NO scaling math. Add snapNO[user] snapshots and noFundingCredit(address) view.
       Tests: indices always equal, conservation holds (total owed YES == total credited NO).

v1b-2. Add display-layer view functions to CreditMarket.sol: costBasis(user), equity(user),
       pnl(user), breakevenMark(user), epochsToExpire(user) [YES only]. Pure read-only
       math per the "Funding Model v1b" display-layer formulas.
       Tests: each formula matches the worked example (entry at 5%, ~354 epochs to expire).

v1b-3. Add the seizure-trigger view to CreditMarket.sol: isSeizable(user) returns true when
       m <= 1.03 × (f_now + m×Δt/365). Add flagClaimable(user) [KEEPER_ROLE]: freezes f_now
       for that holder (no further accrual against them) and marks them claimable.
       Tests: trigger fires at the right boundary (fuzz), cost basis has no effect on
       trigger (two holders, same funding/mark, different entry — both trigger identically),
       negative MTM alone never triggers it.

v1b-4. Create src/LiquidationEngine.sol — NEW contract. claim(address user):
       P = min(f_now_frozen, m); normal case pays NO accretion directly; tail case
       (f_now > m) pays m to NO + pulls (f_now−m) from InsuranceFund to top up NO.
       YES token TRANSFERS to liquidator (via CLOB_ROLE path), liquidator's snapshot resets,
       residual is NOT returned to original holder. FREEZE claim() during motionPending.
       Tests: normal-case settlement, tail-case InsuranceFund top-up, YES transfers (never
       burned), complete-set invariant holds before/after, frozen during motionPending,
       residual correctly forfeited to liquidator (not paid to original holder).

v1b-5. Integration tests: worked example end-to-end (entry 5%, hold to trigger, liquidator
       claims, verify NO made whole, verify complete-set invariant, verify liquidator profit
       ≈ 3% of token value before resale costs).

v1b-6. Redeploy/upgrade to Base Sepolia.
```

**Backend (v1b):**
```
v1b-7. Update funding-keeper: each epoch, call accrueFunding(), then check isSeizable() for
       tracked holders, call flagClaimable() for any that breach.
v1b-8. liquidation-keeper (NEW): exposes GET /claimable (flagged positions + formulaic P).
       Does not claim — claiming is permissionless, left to the frontend/external bots.
```

**Frontend (v1b):**
```
v1b-9.  Update PositionCard.tsx: show Cost Basis, Equity, P&L, Breakeven Mark; YES adds
        Epochs To Expire with a warning as it nears zero.
v1b-10. New LiquidationCard.tsx + /liquidate page: poll /claimable, show P, "Claim" button.
        No discount ticker needed (price is fixed by formula).
```

---

## Reference Links

- OpenZeppelin v5: https://docs.openzeppelin.com/contracts/5.x/
- Foundry book: https://book.getfoundry.sh/
- wagmi v2 signTypedData: https://wagmi.sh/react/api/hooks/useSignTypedData
- Base docs: https://docs.base.org
- EIP-712 spec: https://eips.ethereum.org/EIPS/eip-712
- Polymarket CLOB (reference): https://github.com/Polymarket/clob-client
- PRBMath (fixed-point exp/ln for markValue): https://github.com/PaulRBerg/prb-math
- Everlasting options (White & Zhou) — funding model basis: search "everlasting options paper"
