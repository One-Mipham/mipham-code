import { readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, hostname } from 'node:os'
import type { SessionInfo } from '../../shared/types'

const MIPHAM_HOME = join(homedir(), '.mipham')
const ACTIVE_SESSIONS_DIR = join(MIPHAM_HOME, '.active-sessions')

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

    const sessions: SessionInfo[] = []
    for (const file of files) {
      try {
        const raw = readFileSync(join(ACTIVE_SESSIONS_DIR, file), 'utf-8')
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
  }
}
