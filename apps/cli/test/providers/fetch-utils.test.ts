import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  streamIdleTimeoutMs,
  STREAM_IDLE_TIMEOUT_BASE_MS,
  fetchWithRetry,
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
