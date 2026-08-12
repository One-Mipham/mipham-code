import {
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  existsSync,
  renameSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { CrossSessionTransport } from './transport'
import type { AgentMessage } from '../message-bus'
import type { SessionInfo } from '../../shared/types'

const MIPHAM_HOME = join(homedir(), '.mipham')
const INBOX_DIR = join(MIPHAM_HOME, 'inbox')

/**
 * Filesystem-based cross-session transport.
 *
 * Messages are stored as JSON files in ~/.mipham/inbox/<session-id>/.
 * Each message file is named: <ISO-timestamp>-<msg-id>.json
 */
export class FileInboxTransport implements CrossSessionTransport {
  private initialized = false

  private ensureDir(dir: string): void {
    mkdirSync(dir, { recursive: true })
  }

  /** Ensure the inbox root directory exists (call on first use). */
  private ensureInboxRoot(): void {
    if (!this.initialized) {
      this.ensureDir(INBOX_DIR)
      this.initialized = true
    }
  }

  async send(from: SessionInfo, toSessionId: string, msg: AgentMessage): Promise<boolean> {
    try {
      this.ensureInboxRoot()
      const inboxDir = join(INBOX_DIR, toSessionId)
      this.ensureDir(inboxDir)

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      const filename = `${timestamp}-${msg.id}.json`
      const filePath = join(inboxDir, filename)

      // Serialize with structured sender fields
      const envelope = {
        ...msg,
        senderName: from.id,
        senderMachine: from.machine,
        senderSession: from.id,
      }

      // Atomic write: temp file then rename
      const tmpPath = filePath + '.tmp'
      writeFileSync(tmpPath, JSON.stringify(envelope, null, 2), 'utf-8')
      renameSync(tmpPath, filePath)

      return true
    } catch {
      return false
    }
  }

  async poll(sessionId: string): Promise<AgentMessage[]> {
    // Fix 6: Ensure inbox root exists before checking subdirectory
    this.ensureInboxRoot()
    const inboxDir = join(INBOX_DIR, sessionId)
    if (!existsSync(inboxDir)) return []

    try {
      const files = readdirSync(inboxDir)
        .filter((f) => f.endsWith('.json') && !f.endsWith('.tmp'))
        .sort() // chronological by timestamp prefix

      const messages: AgentMessage[] = []
      for (const file of files) {
        try {
          const raw = readFileSync(join(inboxDir, file), 'utf-8')
          const parsed = JSON.parse(raw) as AgentMessage & {
            senderName?: string
            senderMachine?: string
            senderSession?: string
          }

          // Fix 5: Structured sender display — separate From: line before body
          const senderName = parsed.senderName || parsed.from || 'unknown'
          const senderMachine = parsed.senderMachine || ''
          const originLine = `[From: ${senderName}${senderMachine ? ` @ ${senderMachine}` : ''}]`

          messages.push({
            id: parsed.id,
            from: parsed.from,
            to: parsed.to,
            summary: parsed.summary,
            message: `${originLine}\n${parsed.message}`,
            timestamp: new Date(parsed.timestamp),
            read: parsed.read,
            type: parsed.type,
          })

          // Mark as read by deleting the file (read-once)
          unlinkSync(join(inboxDir, file))
        } catch {
          // Skip corrupt files
        }
      }

      return messages
    } catch {
      return []
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    return discoverSessions()
  }
}

// Import discoverSessions lazily to avoid circular dependency
import { discoverSessions } from './discovery'

// ── Singleton ──

let _transport: FileInboxTransport | null = null

export function getFileInboxTransport(): FileInboxTransport {
  if (!_transport) {
    _transport = new FileInboxTransport()
  }
  return _transport
}
