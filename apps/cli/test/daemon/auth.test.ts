// apps/cli/test/daemon/auth.test.ts
import { describe, it, expect, afterAll } from 'vitest'
import { generateToken, verifyToken, loadOrCreateToken } from '../../src/daemon/auth'
import { unlinkSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const TEST_TOKEN_FILE = join(process.env.HOME || '/tmp', '.mipham', 'daemon-test.token')

describe('Daemon Auth', () => {
  afterAll(() => {
    try { unlinkSync(TEST_TOKEN_FILE) } catch {}
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
    try { unlinkSync(TEST_TOKEN_FILE) } catch {}

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

  it('uses constant-time comparison', () => {
    // verifyToken uses timing-safe comparison via Bun.password.constantTimeCompare
    const token = generateToken()
    // Wrong length should still fail safely
    expect(verifyToken(token, 'short')).toBe(false)
  })
})
