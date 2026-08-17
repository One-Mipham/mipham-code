import { describe, it, expect } from 'vitest'
import { streamIdleTimeoutMs, STREAM_IDLE_TIMEOUT_BASE_MS } from '../../src/providers/fetch-utils'

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
