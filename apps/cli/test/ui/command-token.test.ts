import { describe, it, expect } from 'vitest'
import { commandToken, hasInlineArgs } from '../../src/ui/command-token'

describe('commandToken', () => {
  it('extracts the first token from a slash filter with inline args', () => {
    expect(commandToken('/loop 60s echo hello')).toBe('loop')
  })

  it('returns the command name for a bare slash command', () => {
    expect(commandToken('/loop')).toBe('loop')
  })

  it('returns empty for just a slash', () => {
    expect(commandToken('/')).toBe('')
  })

  it('lowercases the token', () => {
    expect(commandToken('/LOOP auto')).toBe('loop')
  })

  it('handles a filter without a leading slash', () => {
    expect(commandToken('loop 60s')).toBe('loop')
  })
})

describe('hasInlineArgs', () => {
  it('detects args after the command name', () => {
    expect(hasInlineArgs('/loop 60s echo hello')).toBe(true)
    expect(hasInlineArgs('/loop auto')).toBe(true)
  })

  it('returns false for a bare command', () => {
    expect(hasInlineArgs('/loop')).toBe(false)
  })

  it('ignores a trailing space', () => {
    expect(hasInlineArgs('/loop ')).toBe(false)
  })
})
