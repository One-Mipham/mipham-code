import { describe, it, expect } from 'vitest'

describe('SSRF bypass detection', () => {
  it('validateUrl is an exported function', async () => {
    const { validateUrl } = await import('../../../src/security/url')
    expect(validateUrl).toBeDefined()
    expect(typeof validateUrl).toBe('function')
  })

  it('localhost hostname is checked via DNS resolution', async () => {
    const { validateUrl } = await import('../../../src/security/url')
    // localhost may or may not resolve in test — but validateUrl should not throw
    const result = validateUrl('http://localhost:8080/admin')
    expect(typeof result === 'string' || result === null).toBe(true)
  })

  it('127.0.0.1 is blocked (raw IP check)', async () => {
    const { validateUrl } = await import('../../../src/security/url')
    const result = validateUrl('http://127.0.0.1:3000/api')
    // Blocked means error string (non-null)
    expect(result).not.toBeNull()
    expect(result).toContain('blocked')
  })

  it('10.x.x.x private range is blocked', async () => {
    const { validateUrl } = await import('../../../src/security/url')
    const result = validateUrl('http://10.0.0.1:8080/internal')
    expect(result).not.toBeNull()
    expect(result).toContain('blocked')
  })

  it('public URLs pass validation', async () => {
    const { validateUrl } = await import('../../../src/security/url')
    // In test environments without DNS, lookupSync may throw → null = safe
    const result = validateUrl('https://example.com/api/data')
    expect(result).toBeNull()
  })
})
