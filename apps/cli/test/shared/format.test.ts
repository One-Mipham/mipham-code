import { describe, it, expect } from 'vitest'
import { formatContextWindow } from '../../src/shared/format'

describe('formatContextWindow', () => {
  it('formats K values', () => {
    expect(formatContextWindow(16384)).toBe('16K')
    expect(formatContextWindow(131072)).toBe('131K')
    expect(formatContextWindow(200000)).toBe('200K')
  })

  it('formats M values', () => {
    expect(formatContextWindow(1000000)).toBe('1M')
    expect(formatContextWindow(1500000)).toBe('1.5M')
  })

  it('passes through sub-thousand values', () => {
    expect(formatContextWindow(4096)).toBe('4K')
    expect(formatContextWindow(500)).toBe('500')
  })
})
