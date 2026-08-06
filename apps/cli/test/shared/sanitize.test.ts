import { describe, it, expect } from 'vitest'
import { stripDangerousUnicode, sanitizeParams } from '../../src/shared/sanitize'

describe('stripDangerousUnicode', () => {
  it('strips zero-width space (U+200B)', () => {
    expect(stripDangerousUnicode('hello​world')).toBe('helloworld')
  })

  it('strips zero-width joiner (U+200D)', () => {
    expect(stripDangerousUnicode('hello‍world')).toBe('helloworld')
  })

  it('strips zero-width non-joiner (U+200C)', () => {
    expect(stripDangerousUnicode('hello‌world')).toBe('helloworld')
  })

  it('strips LTR/RTL marks (U+200E/F)', () => {
    expect(stripDangerousUnicode('hello‎‏world')).toBe('helloworld')
  })

  it('strips BOM (U+FEFF)', () => {
    expect(stripDangerousUnicode('﻿hello')).toBe('hello')
  })

  it('strips word joiner (U+2060)', () => {
    expect(stripDangerousUnicode('hello⁠world')).toBe('helloworld')
  })

  it('strips bidi control characters (U+202A-E, U+2066-9)', () => {
    const bidi = '‪‫‬‭‮⁦⁧⁨⁩'
    expect(stripDangerousUnicode(bidi + 'safe' + bidi)).toBe('safe')
  })

  it('preserves CJK characters', () => {
    expect(stripDangerousUnicode('你好世界')).toBe('你好世界')
  })

  it('preserves emoji', () => {
    expect(stripDangerousUnicode('hello 👋 world')).toBe('hello 👋 world')
  })

  it('returns unchanged for clean input', () => {
    expect(stripDangerousUnicode('echo "hello world"')).toBe('echo "hello world"')
  })

  it('handles empty string', () => {
    expect(stripDangerousUnicode('')).toBe('')
  })
})

describe('sanitizeParams', () => {
  it('sanitizes all string values in params', () => {
    const result = sanitizeParams({
      command: 'ls​ -la',
      description: 'list‍ files',
      timeout: 5000,
      nested: { key: 'value﻿' },
    })
    expect(result.command).toBe('ls -la')
    expect(result.description).toBe('list files')
    expect(result.timeout).toBe(5000)
    expect(result.nested).toEqual({ key: 'value' })
  })
})
