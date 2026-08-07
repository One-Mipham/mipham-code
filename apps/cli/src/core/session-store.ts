import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
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
  cwd?: string
}

export interface StoredSession {
  metadata: SessionMetadata
  messages: Message[]
}

const HOME = process.env.HOME || '~'
const SESSIONS_DIR = join(HOME, '.mipham', 'sessions')
const INDEX_FILE = join(SESSIONS_DIR, '.index.json')
const SUMMARIES_DIR = join(SESSIONS_DIR, '.summaries')

export interface SessionIndexEntry {
  name: string
  createdAt: string
  updatedAt: string
  provider: string
  model: string
  messageCount: number
  tokenCount: number
  cwd?: string
  summary?: string
  tags?: string[]
}

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
    metadata?: { provider?: string; model?: string; cwd?: string },
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
        cwd: metadata?.cwd,
      },
      messages,
    }

    // Atomic write: write to temp file, then rename (same-fs rename is atomic)
    const tmp = path + '.tmp'
    writeFileSync(tmp, JSON.stringify(session) + '\n', 'utf-8')
    renameSync(tmp, path)

    // Incremental index update — only touch this session's entry
    SessionStore.updateIndexEntry(name, session.metadata)
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
  static autoSave(
    messages: Message[],
    metadata?: { provider?: string; model?: string; cwd?: string },
  ): string {
    const name = `session-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`
    SessionStore.save(name, messages, metadata)
    return name
  }

  /**
   * Write .index.json with all session metadata, merging existing summary/tags.
   */
  static updateIndex(): void {
    ensureDir()
    const sessions = SessionStore.list()
    const index: SessionIndexEntry[] = sessions.map((s) => ({
      name: s.name,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
      provider: s.provider,
      model: s.model,
      messageCount: s.messageCount,
      tokenCount: 0,
      cwd: s.cwd,
    }))

    // Merge with existing summaries and tags from prior index
    const existing = SessionStore.loadIndexRaw()
    for (const entry of index) {
      const prev = existing.find((e) => e.name === entry.name)
      if (prev) {
        entry.summary = prev.summary
        entry.tags = prev.tags
        entry.tokenCount = prev.tokenCount || 0
      }
    }

    writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8')
  }

  /**
   * Incrementally update a single session's entry in the index.
   * Only modifies one entry — faster than full rebuild. Used by save().
   */
  static updateIndexEntry(name: string, metadata: SessionMetadata): void {
    ensureDir()
    const index = SessionStore.loadIndexRaw()
    const existing = index.find((e) => e.name === name)
    const entry: SessionIndexEntry = {
      name,
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      provider: metadata.provider,
      model: metadata.model,
      messageCount: metadata.messageCount,
      tokenCount: existing?.tokenCount || 0,
      cwd: metadata.cwd,
      summary: existing?.summary,
      tags: existing?.tags,
    }
    if (existing) {
      Object.assign(existing, entry)
    } else {
      index.push(entry)
    }
    writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8')
  }

  /**
   * Persist an LLM-generated summary for a session.
   * Writes a markdown file to .summaries/ and updates the index entry.
   */
  static saveSummary(name: string, summary: string, tags: string[]): void {
    ensureDir()
    mkdirSync(SUMMARIES_DIR, { recursive: true })

    const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)
    const summaryPath = join(SUMMARIES_DIR, `${safe}.md`)
    writeFileSync(summaryPath, `# ${name}\n\n${summary}\n\nTags: ${tags.join(', ')}\n`, 'utf-8')

    // Update index entry — create minimal one if not present
    const index = SessionStore.loadIndexRaw()
    const entry = index.find((e) => e.name === name)
    if (entry) {
      entry.summary = summary
      entry.tags = tags
    } else {
      index.push({
        name,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        provider: 'unknown',
        model: 'unknown',
        messageCount: 0,
        tokenCount: 0,
        summary,
        tags,
      })
    }
    writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2), 'utf-8')
  }

  /**
   * Return the most recent session from the index, or null if none exist.
   */
  static getLatest(): SessionIndexEntry | null {
    const index = SessionStore.loadIndexRaw()
    if (index.length === 0) return null
    index.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    return index[0]!
  }

  /**
   * Read the raw index file, returning empty array if missing or corrupt.
   */
  private static loadIndexRaw(): SessionIndexEntry[] {
    if (!existsSync(INDEX_FILE)) return []
    try {
      return JSON.parse(readFileSync(INDEX_FILE, 'utf-8'))
    } catch {
      return []
    }
  }
}
