import { describe, it, expect, beforeEach } from 'vitest'
import {
  parseGraftSavings,
  accumulateGraftSavings,
  getGraftSavings,
  resetGraftSavings,
} from '../../src/shared/graft-savings'

describe('parseGraftSavings', () => {
  it('sums a single footer', () => {
    expect(parseGraftSavings('[graft] tokens saved ≈ 12,345')).toBe(12345)
  })

  it('sums multiple footers', () => {
    const text = 'a\n[graft] tokens saved ≈ 1,000\nb\n[graft] tokens saved ≈ 500\n'
    expect(parseGraftSavings(text)).toBe(1500)
  })

  it('returns 0 when no footer is present', () => {
    expect(parseGraftSavings('no footer here')).toBe(0)
  })
})

describe('accumulateGraftSavings / getGraftSavings', () => {
  beforeEach(() => resetGraftSavings())

  it('accumulates across calls', () => {
    accumulateGraftSavings('[graft] tokens saved ≈ 100')
    accumulateGraftSavings('[graft] tokens saved ≈ 250')
    expect(getGraftSavings()).toBe(350)
  })

  it('ignores empty text', () => {
    accumulateGraftSavings('')
    expect(getGraftSavings()).toBe(0)
  })
})
