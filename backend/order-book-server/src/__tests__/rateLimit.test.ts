import { describe, it, expect } from 'vitest'
import {
  parseOrderRateLimitMax,
  parseOrderRateLimitWindowMs,
  parseTrustProxy,
  DEFAULT_ORDER_RATE_LIMIT_MAX,
  DEFAULT_ORDER_RATE_LIMIT_WINDOW_MS,
} from '../rateLimit'

describe('parseOrderRateLimitMax', () => {
  it('defaults to 60 when unset', () => {
    expect(parseOrderRateLimitMax(undefined)).toBe(DEFAULT_ORDER_RATE_LIMIT_MAX)
    expect(DEFAULT_ORDER_RATE_LIMIT_MAX).toBe(60)
  })

  it('defaults to 60 for a blank string', () => {
    expect(parseOrderRateLimitMax('  ')).toBe(60)
  })

  it('parses a positive integer', () => {
    expect(parseOrderRateLimitMax('120')).toBe(120)
  })

  it('preserves 0 (disables the limiter — caller-facing sentinel)', () => {
    expect(parseOrderRateLimitMax('0')).toBe(0)
  })

  it('defaults to 60 for a negative number', () => {
    expect(parseOrderRateLimitMax('-5')).toBe(60)
  })

  it('defaults to 60 for a non-numeric string', () => {
    expect(parseOrderRateLimitMax('not-a-number')).toBe(60)
  })

  it('truncates a fractional value', () => {
    expect(parseOrderRateLimitMax('12.9')).toBe(12)
  })
})

describe('parseOrderRateLimitWindowMs', () => {
  it('defaults to 60_000 when unset', () => {
    expect(parseOrderRateLimitWindowMs(undefined)).toBe(DEFAULT_ORDER_RATE_LIMIT_WINDOW_MS)
    expect(DEFAULT_ORDER_RATE_LIMIT_WINDOW_MS).toBe(60_000)
  })

  it('defaults to 60_000 for a blank string', () => {
    expect(parseOrderRateLimitWindowMs('')).toBe(60_000)
  })

  it('parses a positive integer', () => {
    expect(parseOrderRateLimitWindowMs('5000')).toBe(5000)
  })

  it('defaults to 60_000 for zero (a window must be positive)', () => {
    expect(parseOrderRateLimitWindowMs('0')).toBe(60_000)
  })

  it('defaults to 60_000 for a negative number', () => {
    expect(parseOrderRateLimitWindowMs('-1000')).toBe(60_000)
  })

  it('defaults to 60_000 for a non-numeric string', () => {
    expect(parseOrderRateLimitWindowMs('soon')).toBe(60_000)
  })
})

describe('parseTrustProxy', () => {
  it('defaults to false when unset', () => {
    expect(parseTrustProxy(undefined)).toBe(false)
  })

  it('defaults to false for a blank string', () => {
    expect(parseTrustProxy('   ')).toBe(false)
  })

  it('parses "true" (case-insensitive) as boolean true', () => {
    expect(parseTrustProxy('true')).toBe(true)
    expect(parseTrustProxy('TRUE')).toBe(true)
  })

  it('parses "false" as boolean false', () => {
    expect(parseTrustProxy('false')).toBe(false)
  })

  it('parses a positive integer as a hop count', () => {
    expect(parseTrustProxy('1')).toBe(1)
    expect(parseTrustProxy('2')).toBe(2)
  })

  it('defaults to false for zero (not a valid hop count)', () => {
    expect(parseTrustProxy('0')).toBe(false)
  })

  it('defaults to false for a negative number', () => {
    expect(parseTrustProxy('-1')).toBe(false)
  })

  it('defaults to false for an unparseable value', () => {
    expect(parseTrustProxy('yes-please')).toBe(false)
  })
})
