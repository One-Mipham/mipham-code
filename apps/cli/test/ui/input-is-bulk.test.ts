import { describe, it, expect } from 'vitest'
import { isBulkInput } from '../../src/ui/input'

describe('isBulkInput', () => {
  it('treats single-char typing and delete as non-bulk (immediate display)', () => {
    expect(isBulkInput('', 'a')).toBe(false)
    expect(isBulkInput('abc', 'abcd')).toBe(false)
    expect(isBulkInput('abcd', 'abc')).toBe(false)
  })

  it('treats multi-char jumps (paste / IME replacement) as bulk (throttled)', () => {
    expect(isBulkInput('', 'hello world')).toBe(true)
    expect(isBulkInput('a', 'abcdefg')).toBe(true)
    expect(isBulkInput('abcdefg', 'x')).toBe(true)
  })
})
