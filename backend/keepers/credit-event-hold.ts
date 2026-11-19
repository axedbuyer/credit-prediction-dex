// "DC Yes announced" switch (batch 4, docs/credit-event-runbook.md §4).
//
// Between the DC announcing "Yes" on a listed entity and the attester's
// confirmCreditEvent() landing, the contracts still allow flagging and claims. The
// team's own services stop at once when this switch names the market:
//
//   DC_YES_HOLD=crwv          one market (comma-separate several)
//   DC_YES_HOLD=*             every market
//
// funding-keeper stops flagging and liquidator-bot stops claiming in a held market.
// Setting the variable on Railway redeploys the service (~1–2 min); neither service
// flags or claims at boot, so the restart itself is safe. After confirmation the
// on-chain guard takes over (flagClaimable / claims revert forever) and the variable
// can be removed.

export interface CreditEventHold {
  held(slug: string): boolean
  /** For /health. */
  describe(): string[]
}

export function parseHold(raw: string | undefined): CreditEventHold {
  const items = (raw ?? '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => s.length > 0)
  const all = items.includes('*')
  const set = new Set(items)
  return {
    held: (slug: string) => all || set.has(slug.toLowerCase()),
    describe: () => (all ? ['*'] : [...set]),
  }
}

export function holdFromEnv(env: NodeJS.ProcessEnv = process.env): CreditEventHold {
  const hold = parseHold(env.DC_YES_HOLD)
  const d = hold.describe()
  if (d.length > 0) {
    console.log(`[hold] DC_YES_HOLD active for: ${d.join(', ')} — no flagging/claiming there`)
  }
  return hold
}
