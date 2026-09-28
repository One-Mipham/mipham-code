// apps/cli/src/daemon/auth.ts
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, existsSync, mkdirSync, statSync, chmodSync } from 'node:fs'
import { atomicWriteFileSync } from '../shared/atomic-write'
import { isRegularFile } from '../shared/regular-file'
import { logger } from './logger'
import { dirname } from 'node:path'

/**
 * Generate a 64-character hex token using cryptographically secure random bytes.
 */
export function generateToken(): string {
  return randomBytes(32).toString('hex')
}

/**
 * Read the token file: type gate first, then pull a drifted mode back.
 *
 * The type gate is not defensive form. `readFileSync` on a FIFO with no writer
 * blocks **synchronously** until one appears — timers and signal handlers cannot
 * queue behind it, so at daemon startup it looks like nothing happening at all
 * (measured: the process is still inside the call when the watchdog kills it, and
 * had printed no error). A FIFO on this path is a signal something is wrong, so
 * name the path and refuse rather than wait forever.
 *
 * The repair targets the 0o600 this module itself declares (both writers pass
 * `mode: 0o600`), not the credential key's 0o400 — a drifted 0644 token is
 * readable by every local user, and the bearer token it holds buys full control
 * of the daemon. The read path is the only place that ever notices, so the repair
 * lives here; and it says so, because the widened mode may have been set on
 * purpose by someone who deserves to know it was taken back.
 *
 * Exported so that every reader of this file goes through it: `mipham attach`
 * used to inline its own `existsSync + readFileSync` copy, and that copy had
 * neither half of this gate. Caller's precondition: the path exists.
 */
export function readTokenFile(tokenPath: string): string {
  if (!isRegularFile(tokenPath)) {
    throw new Error(
      `${tokenPath} is not a regular file — refusing to read the daemon token from it ` +
        `(remove or replace it with a regular file).`,
    )
  }
  const mode = statSync(tokenPath).mode & 0o777
  if (mode !== 0o600) {
    chmodSync(tokenPath, 0o600)
    logger.warn('daemon token file was not 0600 — tightened', {
      path: tokenPath,
      from: mode.toString(8),
      to: '600',
    })
  }
  return readFileSync(tokenPath, 'utf-8').trim()
}

/**
 * Load an existing token from disk, or create one if it doesn't exist.
 * The token file is created with 0o600 permissions.
 *
 * A path that exists but is not a regular file throws (see `readTokenFile`) —
 * it is never treated as "absent", because writing over it would destroy
 * whatever occupies the path and mint a token that locks out every client
 * already paired with the running one.
 */
export function loadOrCreateToken(tokenPath: string): string {
  if (existsSync(tokenPath)) {
    return readTokenFile(tokenPath)
  }

  const token = generateToken()
  mkdirSync(dirname(tokenPath), { recursive: true, mode: 0o700 })
  atomicWriteFileSync(tokenPath, token, { mode: 0o600 })
  return token
}

/**
 * Verify a provided token against the expected token.
 * Uses a constant-time comparison to prevent timing attacks.
 *
 * `Bun.password` has no `constantTimeCompare` — on bun 1.3.14 it is
 * `['hash','hashSync','verify','verifySync']`. Calling it threw a TypeError, so
 * every authenticated remote request got a 500 instead of the intended 200/403.
 * Node's `timingSafeEqual` is the same primitive and works under Bun.
 *
 * Length is checked first because `timingSafeEqual` throws RangeError when the
 * buffers differ in length; unequal length is itself a mismatch, so returning
 * false early leaks nothing that comparing would not.
 */
export function verifyToken(expected: string, provided: string): boolean {
  if (!provided || !expected) return false
  const a = Buffer.from(expected)
  const b = Buffer.from(provided)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Generate a new API token, overwrite the token file, and return the new token.
 */
export function rotateToken(tokenPath: string): string {
  const token = generateToken()
  atomicWriteFileSync(tokenPath, token, { mode: 0o600 })
  return token
}

/**
 * Read all tokens from the token file.
 * Currently supports a single token per file; returns it as a single-element array.
 * Returns an empty array if the file does not exist.
 */
export function listTokens(tokenPath: string): string[] {
  if (!existsSync(tokenPath)) return []
  const token = readTokenFile(tokenPath)
  return token ? [token] : []
}

/**
 * Create an auth middleware for Bun.serve that checks the Authorization header.
 * Returns a Response if auth fails, or null if auth passes.
 *
 * In the default 127.0.0.1-only configuration, all requests are implicitly
 * trusted and auth is bypassed. Auth enforcement activates when
 * MIPHAM_BIND=0.0.0.0 for remote access.
 *
 * Loopback says *where* a request came from, not *who* sent it — a web page in
 * the user's own browser is also loopback. Two guards close that gap:
 * `originMiddleware` in cors.ts and the session cwd check in workspace-guard.ts.
 */
export function authMiddleware(
  request: Request,
  validToken: string,
  peerAddress: string | undefined,
): Response | null {
  // Allow health endpoint without auth
  const url = new URL(request.url)
  if (url.pathname === '/api/v1/health') return null

  // Trust only actual loopback connections (socket IP), never the spoofable Host header.
  const isLoopback =
    peerAddress === '127.0.0.1' || peerAddress === '::1' || peerAddress === '::ffff:127.0.0.1'
  if (isLoopback) return null

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
