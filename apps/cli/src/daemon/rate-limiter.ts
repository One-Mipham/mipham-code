// apps/cli/src/daemon/rate-limiter.ts
//
// In-memory sliding-window rate limiter for daemon HTTP API.
// Each key (typically client IP or token) gets maxRequests per windowMs.

interface WindowEntry {
  count: number
  resetAt: number
}

export class RateLimiter {
  private windows = new Map<string, WindowEntry>()
  private cleanupTimer: ReturnType<typeof setInterval>

  constructor(
    private maxRequests: number = 100,
    private windowMs: number = 60_000,
  ) {
    // Clean expired entries every 60 seconds
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000)
    // Allow timer to not block process exit
    if (typeof this.cleanupTimer === 'object' && 'unref' in this.cleanupTimer) {
      ;(this.cleanupTimer as unknown as { unref(): void }).unref()
    }
  }

  /**
   * Check whether a request from `key` should be allowed.
   * Returns the decision along with remaining quota and reset timestamp.
   */
  check(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now()
    let entry = this.windows.get(key)

    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + this.windowMs }
      this.windows.set(key, entry)
    }

    if (entry.count >= this.maxRequests) {
      return { allowed: false, remaining: 0, resetAt: entry.resetAt }
    }

    entry.count++
    return {
      allowed: true,
      remaining: this.maxRequests - entry.count,
      resetAt: entry.resetAt,
    }
  }

  /**
   * Remove all entries whose window has expired.
   */
  private cleanup(): void {
    const now = Date.now()
    for (const [key, entry] of this.windows) {
      if (now >= entry.resetAt) {
        this.windows.delete(key)
      }
    }
  }

  /**
   * Stop the cleanup interval. Call when shutting down the daemon.
   */
  stop(): void {
    clearInterval(this.cleanupTimer)
  }
}
