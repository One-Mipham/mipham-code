// apps/cli/src/daemon/auth.ts
import { randomBytes } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * bun-types@1.3.14 lacks constantTimeCompare in type definitions,
 * though the method exists at Bun 1.2+ runtime.
 */
interface PasswordWithCompare {
  constantTimeCompare(a: Buffer, b: Buffer): boolean
}

/**
 * Generate a 64-character hex token using cryptographically secure random bytes.
 */
export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Load an existing token from disk, or create one if it doesn't exist.
 * The token file is created with 0o600 permissions.
 */
export function loadOrCreateToken(tokenPath: string): string {
  if (existsSync(tokenPath)) {
    return readFileSync(tokenPath, 'utf-8').trim()
  }

  const token = generateToken()
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 })
  writeFileSync(tokenPath, token, { mode: 0o600 })
  return token
}

/**
 * Verify a provided token against the expected token.
 * Uses Bun's constant-time comparison to prevent timing attacks.
 */
export function verifyToken(expected: string, provided: string): boolean {
  if (!provided || !expected) return false
  return (Bun.password as unknown as PasswordWithCompare).constantTimeCompare(
    Buffer.from(expected),
    Buffer.from(provided),
  )
}

/**
 * Generate a new API token, overwrite the token file, and return the new token.
 */
export function rotateToken(tokenPath: string): string {
  const token = generateToken()
  writeFileSync(tokenPath, token, { mode: 0o600 })
  return token
}

/**
 * Read all tokens from the token file.
 * Currently supports a single token per file; returns it as a single-element array.
 * Returns an empty array if the file does not exist.
 */
export function listTokens(tokenPath: string): string[] {
  if (!existsSync(tokenPath)) return []
  const token = readFileSync(tokenPath, 'utf-8').trim()
  return token ? [token] : []
}

/**
 * Create an auth middleware for Bun.serve that checks the Authorization header.
 * Returns a Response if auth fails, or null if auth passes.
 *
 * In the default 127.0.0.1-only configuration, all requests are implicitly
 * trusted and auth is bypassed. Auth enforcement activates when
 * MIPHAM_BIND=0.0.0.0 for remote access.
 */
export function authMiddleware(request: Request, validToken: string): Response | null {
  // Allow health endpoint without auth
  const url = new URL(request.url)
  if (url.pathname === '/api/v1/health') return null

  // localhost requests skip auth
  const host = request.headers.get('host') || ''
  if (host.startsWith('127.0.0.1') || host.startsWith('localhost') || host.startsWith('[::1]')) {
    return null
  }

  const auth = request.headers.get('authorization')
  if (!auth || !auth.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ ok: false, error: 'Missing authorization header' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const token = auth.slice(7)
  if (!verifyToken(validToken, token)) {
    return new Response(JSON.stringify({ ok: false, error: 'Invalid token' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  return null
}
