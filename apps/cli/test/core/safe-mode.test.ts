import { describe, it, expect, afterEach } from 'vitest'
import { isSafeMode } from '../../src/core/safe-mode'

const original = process.env.MIPHAM_SAFE_MODE
afterEach(() => {
  if (original === undefined) delete process.env.MIPHAM_SAFE_MODE
  else process.env.MIPHAM_SAFE_MODE = original
})

describe('isSafeMode', () => {
  it('is enabled only by the exact value "1"', () => {
    process.env.MIPHAM_SAFE_MODE = '1'
    expect(isSafeMode()).toBe(true)
  })

  it.each(['', '0', 'true', 'yes', ' 1'])('ignores %j', (value) => {
    process.env.MIPHAM_SAFE_MODE = value
    expect(isSafeMode()).toBe(false)
  })

  it('is disabled when unset', () => {
    delete process.env.MIPHAM_SAFE_MODE
    expect(isSafeMode()).toBe(false)
  })
})
