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

---

## Key Decisions (Non-Negotiable)

| Decision | Value |
|---|---|
| Chain (MVP) | Base (EVM standard) |
| Collateral | USDC only |
| Settlement | YES/NO ERC-20 tokens — YES redeems 1:1 USDC on credit event, NO redeems $0 |
| Recovery rate | Zero — YES settles at $1.00 on credit event, NO at $0.00 |
| Funding | Floating, accrued per second against YES token balance at rate = currentMark |
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
/funding-keeper       — calls accrueFunding() on CreditMarket every 8h
/oracle-monitor       — placeholder for ISDA DC scraper (manual multisig in MVP)
```

### Frontend (Next.js 14)

```
/app
  /market/[id]        — main trading page
  /portfolio          — YES/NO token balances, accrued funding, redeem button
  /admin              — internal: submit credit event, pause market (team only)
/components
  OrderBook.tsx       — live bid/ask ladder (poll /orderbook)
  TradePanel.tsx      — enter USDC amount + select YES/NO, sign EIP-712 order
  PriceChart.tsx      — YES token price over time (TradingView Lightweight Charts)
  FundingTicker.tsx   — current annual carry displayed live
  PositionCard.tsx    — reads YES/NO balanceOf(address) + accrued funding debt
                        shows: token balance, current mark, implied USDC value, funding owed
```

Note: frontend reads token balances via standard ERC-20 `balanceOf` calls — no custom
position mapping needed. YES tokens show automatically in MetaMask/Coinbase Wallet.

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

**Funding accrual (per second, borne by YES token holders):**
```
elapsed                  = block.timestamp − lastFundingTime
cumulativeFundingPerYES += currentMark × elapsed / 365 days
lastFundingTime           = block.timestamp

userFundingOwed = YES.balanceOf(user) × (cumulativeFundingPerYES − fundingSnapshot[user])
                  / 1e18
```
Funding owed is deducted from USDC returned on redeem or settleYES.

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

## Reference Links

- OpenZeppelin v5: https://docs.openzeppelin.com/contracts/5.x/
- Foundry book: https://book.getfoundry.sh/
- wagmi v2 signTypedData: https://wagmi.sh/react/api/hooks/useSignTypedData
- Base docs: https://docs.base.org
- EIP-712 spec: https://eips.ethereum.org/EIPS/eip-712
- Polymarket CLOB (reference): https://github.com/Polymarket/clob-client
