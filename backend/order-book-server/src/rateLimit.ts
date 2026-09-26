// Env parsing helpers for the POST /order + DELETE /order/:id rate limiter
// (see server.ts's buildApp, which wires these into @fastify/rate-limit, and
// root CLAUDE.md's CLOB Architecture section). Kept in a standalone,
// side-effect-free module so they're directly unit-testable — main.ts has
// top-level side effects (connects to Redis) that make it unsuitable to
// import from tests.

export const DEFAULT_ORDER_RATE_LIMIT_MAX = 60
export const DEFAULT_ORDER_RATE_LIMIT_WINDOW_MS = 60_000

/**
 * ORDER_RATE_LIMIT_MAX — shared-bucket max requests per client IP across
 * POST /order + DELETE /order/:id per ORDER_RATE_LIMIT_WINDOW_MS window.
 *
 * `0` disables the limiter entirely: buildApp skips registering
 * @fastify/rate-limit altogether (a literal max:0 passed to the plugin would
 * mean "reject every request", the opposite of disabling it). Useful for the
 * local demo stack (scripts/demo/seed-demo.ts, mm-sepolia-seed.ts) and tests.
 *
 * Unset/blank/non-finite/negative → default 60.
 */
export function parseOrderRateLimitMax(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') return DEFAULT_ORDER_RATE_LIMIT_MAX
  const n = Number(raw.trim())
  if (!Number.isFinite(n) || n < 0) return DEFAULT_ORDER_RATE_LIMIT_MAX
  return Math.trunc(n)
}

/** ORDER_RATE_LIMIT_WINDOW_MS — window length in ms. Unset/blank/invalid/≤0 → default 60_000. */
export function parseOrderRateLimitWindowMs(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') return DEFAULT_ORDER_RATE_LIMIT_WINDOW_MS
  const n = Number(raw.trim())
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_ORDER_RATE_LIMIT_WINDOW_MS
  return Math.trunc(n)
}

/**
 * Fastify's `trustProxy` option (passed straight through to the Fastify()
 * constructor) — governs how `request.ip` (what the rate limiter's default
 * keyGenerator keys on) is derived from X-Forwarded-For, via Fastify's
 * internal use of `proxy-addr`.
 *
 * Semantics:
 *   - unset/blank            → `false` — X-Forwarded-For is ignored;
 *     request.ip is the direct TCP peer. Correct default for local dev
 *     (no reverse proxy in front).
 *   - "true"                 → `true` — ALL hops are trusted, so the
 *     LEFT-MOST X-Forwarded-For entry wins. Spoofable: a client behind a
 *     real proxy can prepend arbitrary fake entries to the header it sends,
 *     and with every hop trusted, proxy-addr walks all the way to that
 *     client-controlled left-most entry. Documented but NOT recommended.
 *   - a positive integer N   → `N` — trust exactly N proxy hops closest to
 *     the server (proxy-addr counts inward from the socket's remote
 *     address); request.ip becomes the Nth entry from the right, which a
 *     client cannot spoof past a correctly-configured hop count. This is
 *     the recommended form. Railway puts TWO proxy hops in front of the
 *     service (measured 2026-09-26 → TRUST_PROXY=2). A wrong hop count fails
 *     silently — too low keys clients on a proxy's IP (shared/rotating
 *     buckets) — so re-verify after any hosting change (docs/hosted-env-vars.md).
 *   - anything else (unparseable) → `false`, with a warning logged.
 */
export function parseTrustProxy(raw: string | undefined): boolean | number {
  if (raw == null) return false
  const trimmed = raw.trim()
  if (trimmed === '') return false
  if (trimmed.toLowerCase() === 'true') return true
  if (trimmed.toLowerCase() === 'false') return false
  const n = Number(trimmed)
  if (Number.isInteger(n) && n > 0) return n
  console.warn(
    `[order-book-server] invalid TRUST_PROXY="${raw}" — ignoring, defaulting to false (no proxy trust)`,
  )
  return false
}
