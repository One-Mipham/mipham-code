/**
 * Token-bucket rate limiting, as a denial-of-service backstop.
 *
 * **What this is not.** It is not protecting a scarce resource: the handler is
 * a single-event O(1) aggregate behind a loopback proxy, and the one thing
 * that could grow without bound — `counters` label cardinality — is already
 * closed by the allowlist, not by rate. So the numbers below are sized to
 * admit every honest client with room to spare and to trip only on a flood.
 *
 * The sizing is a client bound, not a guess: `queue.ts` caps the local queue at
 * 100 entries, so the most a legitimate CLI can deliver in one burst is 100
 * requests. The bucket is four times that, and refills in twenty seconds.
 *
 * **The key must be unforgeable.** The caller passes `X-Real-IP`, which our
 * nginx sets to `$remote_addr`. `X-Forwarded-For` is explicitly *not* used:
 * every existing vhost in this organisation appends to it
 * (`$proxy_add_x_forwarded_for`), so a client sending its own header wins the
 * leftmost slot and gets a fresh bucket per request — a rate limiter that
 * grants unlimited requests is worse than none, because it reads as protection.
 */

/** Requests a fresh bucket admits before shedding. */
export const DEFAULT_CAPACITY = 400

/** Tokens restored per second. */
export const DEFAULT_REFILL_PER_SECOND = 20

/**
 * Ceiling on tracked buckets.
 *
 * A map keyed by client address is itself a growth surface — a flood from many
 * addresses would otherwise be a memory leak wearing a rate limiter's clothes.
 * On overflow, buckets that have fully refilled are dropped first (they carry
 * no state worth keeping), and only if that is not enough is the oldest
 * touched bucket evicted. Evicting a live bucket can only ever *grant* a
 * request, which is the safe direction here.
 */
export const MAX_BUCKETS = 10_000

interface Bucket {
  tokens: number
  /** Last time this bucket was touched, ms. Used for eviction order. */
  last: number
}

export class RateLimiter {
  #buckets = new Map<string, Bucket>()
  readonly #capacity: number
  readonly #refillPerMs: number

  constructor(capacity = DEFAULT_CAPACITY, refillPerSecond = DEFAULT_REFILL_PER_SECOND) {
    this.#capacity = capacity
    this.#refillPerMs = refillPerSecond / 1000
  }

  /** Consume one token. `false` means shed this request. */
  take(key: string, now = Date.now()): boolean {
    const bucket = this.#buckets.get(key)

    if (bucket === undefined) {
      this.#evictIfNeeded(now)
      this.#buckets.set(key, { tokens: this.#capacity - 1, last: now })
      return true
    }

    const refilled = Math.min(
      this.#capacity,
      bucket.tokens + (now - bucket.last) * this.#refillPerMs,
    )
    bucket.last = now

    if (refilled < 1) {
      // Deliberately no `Retry-After`. The client trusts it unboundedly
      // (`fetch-utils.ts` does `parseInt(retryAfter) * 1000` into a bare
      // `setTimeout` that holds the event loop), so a large value parks the
      // user's CLI for that long. Shedding without a hint costs the client a
      // fixed backoff and cannot be weaponised.
      bucket.tokens = refilled
      return false
    }

    bucket.tokens = refilled - 1
    return true
  }

  get size(): number {
    return this.#buckets.size
  }

  #evictIfNeeded(now: number): void {
    if (this.#buckets.size < MAX_BUCKETS) return

    // "Fully refilled" has to be *computed*, not read off `bucket.tokens`.
    // That field is only brought up to date inside `take`, so it is always
    // strictly below capacity in the map — comparing it directly would make
    // this whole pass dead code that reads as a safeguard.
    for (const [key, bucket] of this.#buckets) {
      const refilled = bucket.tokens + (now - bucket.last) * this.#refillPerMs
      if (refilled >= this.#capacity) this.#buckets.delete(key)
    }
    if (this.#buckets.size < MAX_BUCKETS) return

    // Still full of live buckets: drop the least recently touched. `Map`
    // preserves insertion order, so this is an O(n) scan rather than a sort.
    let oldestKey: string | undefined
    let oldestLast = Infinity
    for (const [key, bucket] of this.#buckets) {
      if (bucket.last < oldestLast) {
        oldestLast = bucket.last
        oldestKey = key
      }
    }
    if (oldestKey !== undefined) this.#buckets.delete(oldestKey)
  }
}
