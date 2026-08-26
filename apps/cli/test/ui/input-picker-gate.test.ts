import { describe, it, expect } from 'vitest'
import { shouldAutoOpenPicker } from '../../src/ui/input'

describe('shouldAutoOpenPicker', () => {
  it('opens when typing a leading slash and enabled', () => {
    expect(shouldAutoOpenPicker('/loop', '', true)).toBe(true)
  })

  it('does not open when disabled', () => {
    expect(shouldAutoOpenPicker('/loop', '', false)).toBe(false)
  })

  it('does not open when the previous value already starts with a slash', () => {
    expect(shouldAutoOpenPicker('/loop 60s', '/loop', true)).toBe(false)
  })

  it('does not open when the value has no leading slash', () => {
    expect(shouldAutoOpenPicker('hello', '', true)).toBe(false)
  })
})
