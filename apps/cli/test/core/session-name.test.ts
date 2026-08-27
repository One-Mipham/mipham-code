import { describe, it, expect } from 'vitest'
import { generateSessionName } from '../../src/core/session-name.js'

describe('generateSessionName', () => {
  it('returns the resume value when provided', () => {
    expect(generateSessionName('resumed-session')).toBe('resumed-session')
  })

  it('includes milliseconds so same-second launches do not collide', () => {
    const a = generateSessionName(undefined, new Date('2026-08-27T12:34:56.123Z'))
    const b = generateSessionName(undefined, new Date('2026-08-27T12:34:56.789Z'))

    expect(a).not.toBe(b)
    expect(a).toBe('session-2026-08-27T12-34-56-123Z')
    expect(b).toBe('session-2026-08-27T12-34-56-789Z')
  })

  it('defaults to the current time (with ms) when no date is passed', () => {
    const name = generateSessionName(undefined)
    expect(name).toMatch(/^session-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/)
  })
})
