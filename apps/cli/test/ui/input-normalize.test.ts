import { describe, it, expect } from 'vitest'
import { normalizeInput } from '../../src/ui/input'

describe('normalizeInput', () => {
  it('leaves plain text untouched', () => {
    expect(normalizeInput('hello world')).toBe('hello world')
  })

  it('collapses LF / CR / CRLF / Tab into a single space', () => {
    expect(normalizeInput('a\nb')).toBe('a b')
    expect(normalizeInput('a\rb')).toBe('a b')
    expect(normalizeInput('a\r\nb')).toBe('a b')
    expect(normalizeInput('a\tb')).toBe('a b')
  })

  it('collapses runs of control chars into one space (no double spaces)', () => {
    expect(normalizeInput('a\n\nb')).toBe('a b')
    expect(normalizeInput('a\r\n\tb')).toBe('a b')
  })
})
