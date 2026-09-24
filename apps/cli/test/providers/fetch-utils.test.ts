import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  streamIdleTimeoutMs,
  STREAM_IDLE_TIMEOUT_BASE_MS,
  fetchWithRetry,
  retryDelayMs,
  RETRY_AFTER_MAX_MS,
} from '../../src/providers/fetch-utils'

describe('streamIdleTimeoutMs', () => {
  it('returns base timeout for unknown/absent effort', () => {
    expect(streamIdleTimeoutMs()).toBe(STREAM_IDLE_TIMEOUT_BASE_MS)
    expect(streamIdleTimeoutMs('low')).toBe(STREAM_IDLE_TIMEOUT_BASE_MS)
    expect(streamIdleTimeoutMs('medium')).toBe(STREAM_IDLE_TIMEOUT_BASE_MS)
    expect(streamIdleTimeoutMs('bogus')).toBe(STREAM_IDLE_TIMEOUT_BASE_MS)
  })

  it('scales by effort: high 2×, xhigh 3×, max 4×', () => {
    expect(streamIdleTimeoutMs('high')).toBe(STREAM_IDLE_TIMEOUT_BASE_MS * 2)
    expect(streamIdleTimeoutMs('xhigh')).toBe(STREAM_IDLE_TIMEOUT_BASE_MS * 3)
    expect(streamIdleTimeoutMs('max')).toBe(STREAM_IDLE_TIMEOUT_BASE_MS * 4)
  })

  it('monotonically increases with effort', () => {
    const levels = ['low', 'medium', 'high', 'xhigh', 'max']
    for (let i = 1; i < levels.length; i++) {
      expect(streamIdleTimeoutMs(levels[i]!)).toBeGreaterThanOrEqual(
        streamIdleTimeoutMs(levels[i - 1]!),
      )
    }
  })
})

describe('retryDelayMs', () => {
  it('falls back to exponential backoff when the header is absent', () => {
    expect(retryDelayMs(null, 0, 1000)).toBe(1000)
    expect(retryDelayMs(null, 1, 1000)).toBe(2000)
    expect(retryDelayMs(null, 2, 1000)).toBe(4000)
  })

  it('caps a long Retry-After instead of sleeping for it', () => {
    // A 5xx answering `Retry-After: 3600` used to sleep the CLI for a full hour.
    expect(retryDelayMs('3600', 0, 1000)).toBe(RETRY_AFTER_MAX_MS)
    expect(retryDelayMs('120', 0, 1000)).toBe(RETRY_AFTER_MAX_MS)
    expect(RETRY_AFTER_MAX_MS).toBeLessThan(3600 * 1000)
  })

  it('honours a Retry-After inside the cap', () => {
    expect(retryDelayMs('5', 0, 1000)).toBe(5000)
  })

  it('floors Retry-After: 0 so retries never go back to back', () => {
    expect(retryDelayMs('0', 0, 1000)).toBeGreaterThan(0)
    // A negative value is nonsense too — same floor.
    expect(retryDelayMs('-5', 0, 1000)).toBeGreaterThan(0)
  })

  it('never turns an unparseable header into a zero or NaN sleep', () => {
    // `NaN * 1000` reaches setTimeout as 0 — an unthrottled retry storm that
    // looks exactly like "no delay configured".
    for (const header of ['soon', 'NaN', '', ' ', 'Retry-After']) {
      const d = retryDelayMs(header, 1, 1000)
      expect(Number.isFinite(d)).toBe(true)
      expect(d).toBeGreaterThan(0)
    }
  })

  it('understands the HTTP-date form, clamped the same way', () => {
    const past = new Date(Date.now() - 60_000).toUTCString()
    expect(retryDelayMs(past, 0, 1000)).toBeGreaterThan(0)

    const far = new Date(Date.now() + 3600_000).toUTCString()
    expect(retryDelayMs(far, 0, 1000)).toBe(RETRY_AFTER_MAX_MS)
  })
})

describe('fetchWithRetry', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('retries once on first-byte timeout, then throws a clear error', async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init.signal!.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'))
        })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      fetchWithRetry(
        'https://example.com/api',
        { method: 'POST' },
        { timeout: 10, maxRetries: 1, baseDelay: 1 },
      ),
    ).rejects.toThrow(/No response from API/)

    expect(fetchMock).toHaveBeenCalledTimes(2) // initial + 1 retry
  })

  it('does not retry on caller abort', async () => {
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      return new Promise<Response>((_, reject) => {
        init.signal!.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted', 'AbortError'))
        })
      })
    })
    vi.stubGlobal('fetch', fetchMock)

    const caller = new AbortController()
    const p = fetchWithRetry(
      'https://example.com/api',
      { method: 'POST', signal: caller.signal },
      { timeout: 60_000, maxRetries: 3, baseDelay: 1 },
    )
    caller.abort()

    await expect(p).rejects.toThrow(/aborted/i)
    expect(fetchMock).toHaveBeenCalledTimes(1) // no retry on caller cancel
  })
})
