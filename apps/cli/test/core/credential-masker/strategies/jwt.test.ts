import { describe, it, expect } from 'vitest'
import { JwtMaskingStrategy } from '../../../../src/core/credential-masker/strategies/jwt'
import type { JwtMaskingRule, CredentialExtractRule } from '../../../../src/shared/types'

describe('JwtMaskingStrategy', () => {
  const strategy = new JwtMaskingStrategy()

  // Helper: create a valid JWT with given payload
  function makeJWT(payload: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
    const sig = 'dGhpcyBpcyBhIGZha2Ugc2lnbmF0dXJl' // "this is a fake signature" in base64
    return `${header}.${body}.${sig}`
  }

  it('canHandle returns true for JWT rules', () => {
    const rule: JwtMaskingRule = {
      path: '**/token.json',
      type: 'jwt',
      decode: 'jwt',
      maskClaims: ['sub'],
    }
    expect(strategy.canHandle(rule)).toBe(true)
  })

  it('canHandle returns false for non-JWT rules', () => {
    const rule: CredentialExtractRule = { path: '**/*', mode: 'extract', extract: [] }
    expect(strategy.canHandle(rule)).toBe(false)
  })

  it('masks specified claims in JWT payload', () => {
    const jwt = makeJWT({ sub: 'user-123', email: 'user@example.com', role: 'admin' })
    const rule: JwtMaskingRule = {
      path: '**/*',
      type: 'jwt',
      decode: 'jwt',
      maskClaims: ['sub', 'email'],
    }
    const result = strategy.mask(jwt, rule)

    // Should still be valid JWT structure
    const parts = result.split('.')
    expect(parts).toHaveLength(3)

    // Decode the masked payload
    const payload = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf-8'))
    expect(payload.sub).toBe('[MASKED]')
    expect(payload.email).toBe('[MASKED]')
    expect(payload.role).toBe('admin') // not in maskClaims
  })

  it('leaves JWT unchanged if no claims match', () => {
    const jwt = makeJWT({ role: 'admin' })
    const rule: JwtMaskingRule = {
      path: '**/*',
      type: 'jwt',
      decode: 'jwt',
      maskClaims: ['sub'],
    }
    const result = strategy.mask(jwt, rule)
    expect(result).toBe(jwt)
  })

  it('handles non-JWT lines by passing through', () => {
    const content = 'This is not a JWT\n' + makeJWT({ sub: '123' }) + '\nJust text'
    const rule: JwtMaskingRule = {
      path: '**/*',
      type: 'jwt',
      decode: 'jwt',
      maskClaims: ['sub'],
    }
    const result = strategy.mask(content, rule)
    const lines = result.split('\n')
    expect(lines[0]).toBe('This is not a JWT')
    expect(lines[2]).toBe('Just text')
    // Middle line should be masked
    const mid = JSON.parse(Buffer.from(lines[1]!.split('.')[1]!, 'base64url').toString('utf-8'))
    expect(mid.sub).toBe('[MASKED]')
  })

  it('handles multiple JWTs on separate lines', () => {
    const jwt1 = makeJWT({ sub: 'user-1' })
    const jwt2 = makeJWT({ sub: 'user-2' })
    const content = `${jwt1}\n${jwt2}`
    const rule: JwtMaskingRule = {
      path: '**/*',
      type: 'jwt',
      decode: 'jwt',
      maskClaims: ['sub'],
    }
    const result = strategy.mask(content, rule)
    const lines = result.split('\n')
    for (const line of lines) {
      const payload = JSON.parse(Buffer.from(line.split('.')[1]!, 'base64url').toString('utf-8'))
      expect(payload.sub).toBe('[MASKED]')
    }
  })

  it('handles empty content', () => {
    const rule: JwtMaskingRule = {
      path: '**/*',
      type: 'jwt',
      decode: 'jwt',
      maskClaims: ['sub'],
    }
    expect(strategy.mask('', rule)).toBe('')
  })

  it('preserves JWT header and signature unchanged', () => {
    const jwt = makeJWT({ sub: 'user-1', iat: 1234567890 })
    const originalParts = jwt.split('.')
    const rule: JwtMaskingRule = {
      path: '**/*',
      type: 'jwt',
      decode: 'jwt',
      maskClaims: ['sub'],
    }
    const result = strategy.mask(jwt, rule)
    const resultParts = result.split('.')
    expect(resultParts[0]).toBe(originalParts[0]) // header unchanged
    expect(resultParts[2]).toBe(originalParts[2]) // signature unchanged
  })
})
