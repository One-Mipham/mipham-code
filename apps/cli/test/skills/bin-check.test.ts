import { describe, it, expect } from 'vitest'
import { isBinAvailable, checkRequiredBins } from '../../src/skills/bin-check'

describe('bin-check', () => {
  it('isBinAvailable finds a binary on an explicit PATH (unix)', () => {
    expect(isBinAvailable('ls', '/bin:/usr/bin')).toBe(true)
  })

  it('isBinAvailable returns false for a missing binary', () => {
    expect(isBinAvailable('definitely-not-a-real-bin-xyz', '/tmp')).toBe(false)
  })

  it('isBinAvailable checks an explicit path directly', () => {
    expect(isBinAvailable('/definitely/not/real', '')).toBe(false)
  })

  it('checkRequiredBins returns only the missing bins', () => {
    expect(checkRequiredBins(['ls', 'not-real-xyz'], '/bin:/usr/bin')).toEqual(['not-real-xyz'])
  })

  it('checkRequiredBins returns empty when all bins are present', () => {
    expect(checkRequiredBins(['ls'], '/bin:/usr/bin')).toEqual([])
  })
})
