import {
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  statSync,
} from 'node:fs'
import { join, basename } from 'node:path'
import { homedir, hostname } from 'node:os'
import type { SessionInfo, CrossSessionInbound } from '../../shared/types'

const MIPHAM_HOME = join(homedir(), '.mipham')
const ACTIVE_SESSIONS_DIR = join(MIPHAM_HOME, '.active-sessions')

/** A session whose heartbeat file hasn't been touched in this long is dead. */
const STALE_SESSION_TTL_MS = 10 * 60 * 1000 // 10 min — heartbeat is 30s

/**
 * Register the current session as active.
 * Writes a SessionInfo JSON file + updates mtime for heartbeat.
 */
export function registerActiveSession(info: SessionInfo): void {
  mkdirSync(ACTIVE_SESSIONS_DIR, { recursive: true })
  const filePath = join(ACTIVE_SESSIONS_DIR, `${info.id}.json`)
  writeFileSync(filePath, JSON.stringify(info, null, 2), 'utf-8')
}

/**
 * Update heartbeat (mtime) for an active session.
 */
export function heartbeatSession(sessionId: string): void {
  const filePath = join(ACTIVE_SESSIONS_DIR, `${sessionId}.json`)
  if (existsSync(filePath)) {
    // Touch the file by rewriting it
    const raw = readFileSync(filePath, 'utf-8')
    writeFileSync(filePath, raw, 'utf-8') // updates mtime
  }
}

/**
 * Unregister a session (called on shutdown).
 */
export function unregisterSession(sessionId: string): void {
  const filePath = join(ACTIVE_SESSIONS_DIR, `${sessionId}.json`)
  try {
    if (existsSync(filePath)) unlinkSync(filePath)
  } catch {
    // Best-effort
  }
}

/**
 * Discover all active sessions.
 * Reads ~/.mipham/.active-sessions/ directory.
 */
export function discoverSessions(): SessionInfo[] {
  if (!existsSync(ACTIVE_SESSIONS_DIR)) return []

  try {
    const files = readdirSync(ACTIVE_SESSIONS_DIR).filter((f) => f.endsWith('.json'))
    const now = Date.now()

    const sessions: SessionInfo[] = []
    for (const file of files) {
      const filePath = join(ACTIVE_SESSIONS_DIR, file)
      try {
        // Prune stale session files (crashed without unregistering). A live
        // session's 30s heartbeat keeps mtime fresh; 10 min of silence = dead.
        if (now - statSync(filePath).mtimeMs > STALE_SESSION_TTL_MS) {
          unlinkSync(filePath)
          continue
        }
        const raw = readFileSync(filePath, 'utf-8')
        const info = JSON.parse(raw) as SessionInfo
        sessions.push(info)
      } catch {
        // Skip corrupt files
      }
    }

    // Sort by most recently active
    sessions.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    return sessions
  } catch {
    return []
  }
}

/**
 * Create a SessionInfo for the current process.
 */
export function createSessionInfo(
  sessionId: string,
  name: string,
  cwd?: string,
  provider?: string,
  model?: string,
  crossSessionInbound?: CrossSessionInbound,
): SessionInfo {
  return {
    id: sessionId,
    name,
    machine: hostname(),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    cwd,
    provider,
    model,
    crossSessionInbound,
  }
}

/**
 * Return a unique session name among active sessions. If `preferred` is taken
 * by another session (excluding `selfId`), append `-2`, `-3`, … until free.
 * Pure with respect to `existing` — no filesystem access, so it's unit-testable.
 */
export function ensureUniqueSessionName(
  preferred: string,
  existing: SessionInfo[],
  selfId?: string,
): string {
  const taken = new Set(existing.filter((s) => s.id !== selfId).map((s) => s.name))
  if (!taken.has(preferred)) return preferred
  let i = 2
  while (taken.has(`${preferred}-${i}`)) i++
  return `${preferred}-${i}`
}

/**
 * Rename an active session in the registry. Enforces uniqueness against other
 * live sessions (excluding self). Returns null if the session isn't registered.
 */
export function renameActiveSession(sessionId: string, newName: string): string | null {
  const filePath = join(ACTIVE_SESSIONS_DIR, `${sessionId}.json`)
  if (!existsSync(filePath)) return null
  const raw = readFileSync(filePath, 'utf-8')
  const info = JSON.parse(raw) as SessionInfo
  const others = discoverSessions().filter((s) => s.id !== sessionId)
  info.name = ensureUniqueSessionName(newName, others)
  writeFileSync(filePath, JSON.stringify(info, null, 2), 'utf-8')
  return info.name
}

/**
 * Derive a human-readable session title from the first user message.
 * Collapses whitespace and truncates to 40 chars. Returns null when the
 * result is too short (< 3 chars) to be a meaningful title, so callers can
 * keep the existing default name instead of degrading it.
 */
export function deriveSessionTitle(input: string): string | null {
  const cleaned = input.replace(/\s+/g, ' ').trim()
  if (cleaned.length < 3) return null
  return cleaned.length > 40 ? cleaned.slice(0, 40) + '…' : cleaned
}

/**
 * Whether `name` is still the auto-generated default (the cwd basename, or a
 * uniqueness suffix like `-2`/`-10`). Used to avoid overwriting a name the
 * user deliberately chose via /rename.
 */
export function isDefaultSessionName(name: string | undefined, cwd: string): boolean {
  if (!name) return false
  const base = basename(cwd) || 'session'
  if (name === base) return true
  if (!name.startsWith(base + '-')) return false
  return /^\d+$/.test(name.slice(base.length + 1))
}
