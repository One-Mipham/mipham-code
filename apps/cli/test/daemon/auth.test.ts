// apps/cli/test/daemon/auth.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import {
  generateToken,
  verifyToken,
  loadOrCreateToken,
  authMiddleware,
} from '../../src/daemon/auth'
import { unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const TEST_TOKEN_FILE = join(process.env.HOME || '/tmp', '.mipham', 'daemon-test.token')

describe('Daemon Auth', () => {
  afterAll(() => {
    try {
      unlinkSync(TEST_TOKEN_FILE)
    } catch {}
  })

  it('generates a 64-char hex token', () => {
    const token = generateToken()
    expect(token.length).toBe(64)
    expect(/^[0-9a-f]+$/.test(token)).toBe(true)
  })

  it('generates unique tokens each time', () => {
    const t1 = generateToken()
    const t2 = generateToken()
    expect(t1).not.toBe(t2)
  })

  it('loads existing token or creates new one', () => {
    // Clean state
    try {
      unlinkSync(TEST_TOKEN_FILE)
    } catch {}

    const token1 = loadOrCreateToken(TEST_TOKEN_FILE)
    expect(token1.length).toBe(64)
    expect(existsSync(TEST_TOKEN_FILE)).toBe(true)

    // Second call should return same token
    const token2 = loadOrCreateToken(TEST_TOKEN_FILE)
    expect(token2).toBe(token1)
  })

  it('verifies token correctly', () => {
    const token = generateToken()
    expect(verifyToken(token, token)).toBe(true)
    expect(verifyToken(token, 'wrong-token')).toBe(false)
    expect(verifyToken(token, '')).toBe(false)
  })

  it('rejects wrong-length token safely', () => {
    // verifyToken uses timing-safe comparison via Bun.password.constantTimeCompare
    const token = generateToken()
    // Wrong length should still fail safely
    expect(verifyToken(token, 'short')).toBe(false)
  })
})

describe('authMiddleware', () => {
  const VALID_TOKEN = 'a'.repeat(64)

  it('allows /api/v1/health without auth', () => {
    const req = new Request('http://example.com/api/v1/health')
    const result = authMiddleware(req, VALID_TOKEN, '8.8.8.8')
    expect(result).toBeNull()
  })

  it('allows loopback connections without auth — 127.0.0.1', () => {
    const req = new Request('http://example.com/api/v1/sessions')
    const result = authMiddleware(req, VALID_TOKEN, '127.0.0.1')
    expect(result).toBeNull()
  })

  it('allows loopback connections without auth — ::1', () => {
    const req = new Request('http://example.com/api/v1/sessions')
    const result = authMiddleware(req, VALID_TOKEN, '::1')
    expect(result).toBeNull()
  })

  it('allows loopback connections without auth — ::ffff:127.0.0.1', () => {
    const req = new Request('http://example.com/api/v1/sessions')
    const result = authMiddleware(req, VALID_TOKEN, '::ffff:127.0.0.1')
    expect(result).toBeNull()
  })

  it('rejects a spoofed Host header from a non-loopback peer', () => {
    const req = new Request('http://example.com/api/v1/sessions', {
      headers: { host: 'localhost:3000' },
    })
    const result = authMiddleware(req, VALID_TOKEN, '8.8.8.8')
    expect(result).not.toBeNull()
    expect(result!.status).toBe(401)
  })

  it('returns 401 when Authorization header is missing', async () => {
    const req = new Request('http://example.com/api/v1/sessions')
    const result = authMiddleware(req, VALID_TOKEN, '8.8.8.8')
    expect(result).not.toBeNull()
    expect(result!.status).toBe(401)
    const body = await result!.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe('Missing authorization header')
  })

  it('returns 401 when Authorization header lacks Bearer prefix', async () => {
    const req = new Request('http://example.com/api/v1/sessions', {
      headers: { authorization: 'Basic dGVzdDp0ZXN0' },
    })
    const result = authMiddleware(req, VALID_TOKEN, '8.8.8.8')
    expect(result).not.toBeNull()
    expect(result!.status).toBe(401)
    const body = await result!.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe('Missing authorization header')
  })

  it('returns 403 when token is invalid', async () => {
    const req = new Request('http://example.com/api/v1/sessions', {
      headers: { authorization: `Bearer wrong-token` },
    })
    const result = authMiddleware(req, VALID_TOKEN, '8.8.8.8')
    expect(result).not.toBeNull()
    expect(result!.status).toBe(403)
    const body = await result!.json()
    expect(body.ok).toBe(false)
    expect(body.error).toBe('Invalid token')
  })

  it('returns null when token is valid', () => {
    const req = new Request('http://example.com/api/v1/sessions', {
      headers: { authorization: `Bearer ${VALID_TOKEN}` },
    })
    const result = authMiddleware(req, VALID_TOKEN, '8.8.8.8')
    expect(result).toBeNull()
  })
})
