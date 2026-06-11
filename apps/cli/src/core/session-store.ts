import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import type { Message } from '../shared/types'

export interface SessionMetadata {
  name: string
  createdAt: string
  updatedAt: string
  provider: string
  model: string
  messageCount: number
}

export interface StoredSession {
  metadata: SessionMetadata
  messages: Message[]
}

const HOME = process.env.HOME || '~'
const SESSIONS_DIR = join(HOME, '.mipham', 'sessions')

function ensureDir(): void {
  mkdirSync(SESSIONS_DIR, { recursive: true })
}

function filePath(name: string): string {
  // Sanitize name for filesystem
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)
  return join(SESSIONS_DIR, `${safe}.jsonl`)
}

export class SessionStore {
  /**
   * Save a session as JSONL (one JSON object per line).
   */
  static save(
    name: string,
    messages: Message[],
    metadata?: { provider?: string; model?: string },
  ): void {
    ensureDir()
    const path = filePath(name)

    const session: StoredSession = {
      metadata: {
        name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        provider: metadata?.provider || 'unknown',
        model: metadata?.model || 'unknown',
        messageCount: messages.length,
      },
      messages,
    }

    writeFileSync(path, JSON.stringify(session) + '\n', 'utf-8')
  }

  /**
   * Load a saved session. Returns null if not found or unparseable.
   */
  static load(name: string): StoredSession | null {
    const path = filePath(name)
    if (!existsSync(path)) return null

    try {
      const raw = readFileSync(path, 'utf-8')
      const session = JSON.parse(raw) as StoredSession
      // Validate structure
      if (!session.metadata || !Array.isArray(session.messages)) {
        return null
      }
      return session
    } catch {
      return null
    }
  }

  /**
   * List all saved sessions, most recent first.
   */
  static list(): SessionMetadata[] {
    ensureDir()
    try {
      const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.jsonl'))

      const sessions: SessionMetadata[] = []
      for (const file of files) {
        try {
          const raw = readFileSync(join(SESSIONS_DIR, file), 'utf-8')
          const session = JSON.parse(raw) as StoredSession
          if (session.metadata) {
            sessions.push(session.metadata)
          }
        } catch {
          // Skip corrupt files
        }
      }

      sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
      return sessions
    } catch {
      return []
    }
  }

  /**
   * Delete a saved session.
   */
  static delete(name: string): boolean {
    const path = filePath(name)
    if (!existsSync(path)) return false
    try {
      unlinkSync(path)
      return true
    } catch {
      return false
    }
  }

  /**
   * Auto-save with timestamp-based name.
   */
  static autoSave(messages: Message[], metadata?: { provider?: string; model?: string }): string {
    const name = `session-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
    SessionStore.save(name, messages, metadata)
    return name
  }
}
