import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CAPACITY,
  DEFAULT_REFILL_PER_SECOND,
  MAX_BUCKETS,
  RateLimiter,
} from '../src/ratelimit.js'

const T0 = 1_800_000_000_000

describe('the bucket admits an honest client and sheds a flood', () => {
  it('admits a full burst of queue-sized deliveries without shedding', () => {
    // The client's local queue holds 100 events, so 100 requests in one burst is
    // the worst honest case. Nothing legitimate may be shed at that size.
    const limiter = new RateLimiter()
    for (let i = 0; i < 100; i++) expect(limiter.take('ip', T0), `request ${i}`).toBe(true)
  })

  it('admits exactly capacity, then sheds until enough time passes', () => {
    const limiter = new RateLimiter(DEFAULT_CAPACITY, DEFAULT_REFILL_PER_SECOND)
    for (let i = 0; i < DEFAULT_CAPACITY; i++) expect(limiter.take('ip', T0)).toBe(true)
    expect(limiter.take('ip', T0)).toBe(false)
    expect(limiter.take('ip', T0)).toBe(false)

    // Refill is continuous, not per-second: half a second buys half a token's
    // worth, which is still under the one needed.
    expect(limiter.take('ip', T0 + 10)).toBe(false)
    expect(limiter.take('ip', T0 + 1_000)).toBe(true)
  })

  it('never refills past capacity', () => {
    const limiter = new RateLimiter(10, 20)
    limiter.take('ip', T0)
    // A long idle period must not accumulate a debt of tokens.
    const later = T0 + 60 * 60 * 1000
    for (let i = 0; i < 10; i++) expect(limiter.take('ip', later)).toBe(true)
    expect(limiter.take('ip', later)).toBe(false)
  })

  it('a shed request does not consume the token it never had', () => {
    const limiter = new RateLimiter(1, 1)
    expect(limiter.take('ip', T0)).toBe(true)
    expect(limiter.take('ip', T0)).toBe(false)
    // Exactly one second's worth of refill, so exactly one more request.
    expect(limiter.take('ip', T0 + 1_000)).toBe(true)
    expect(limiter.take('ip', T0 + 1_000)).toBe(false)
  })
})

describe('buckets are per key', () => {
  it('gives different keys independent buckets', () => {
    const limiter = new RateLimiter(1, 1)
    expect(limiter.take('a', T0)).toBe(true)
    expect(limiter.take('a', T0)).toBe(false)
    // A flood from one address must not deny service to another.
    expect(limiter.take('b', T0)).toBe(true)
  })

  it('shares one bucket between callers that send no key', () => {
    const limiter = new RateLimiter(1, 1)
    expect(limiter.take('__unknown__', T0)).toBe(true)
    expect(limiter.take('__unknown__', T0)).toBe(false)
  })
})

describe('the bucket map is itself bounded', () => {
  it('stops growing at MAX_BUCKETS rather than leaking a key per address', () => {
    const limiter = new RateLimiter()
    for (let i = 0; i < MAX_BUCKETS + 50; i++) limiter.take(`ip-${i}`, T0)
    expect(limiter.size).toBeLessThanOrEqual(MAX_BUCKETS)
  })

  it('evicts a bucket that has since refilled before one that is still drained', () => {
    const limiter = new RateLimiter(2, 1)
    const refilledAt = T0 + 10_000

    // Drained long ago, so by `refilledAt` it would be full again — it carries
    // no state worth keeping.
    limiter.take('refilled', T0)
    limiter.take('refilled', T0)

    for (let i = 0; i < MAX_BUCKETS - 1; i++) limiter.take(`filler-${i}`, refilledAt)

    // Drained *now*, so it is genuinely still shedding and must survive.
    limiter.take('live', refilledAt)
    limiter.take('live', refilledAt)

    // One more new key trips the eviction pass.
    limiter.take('trigger', refilledAt)

    expect(limiter.take('live', refilledAt)).toBe(false)
  })
})
