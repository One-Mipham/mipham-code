import type { DaemonDatabase } from './database'
import type { DaemonSession, SessionStatus } from './types'

type SessionCloseCallback = (sessionId: string) => void

export class SessionManager {
  private db: DaemonDatabase
  private closeCallbacks: SessionCloseCallback[] = []

  constructor(db: DaemonDatabase) {
    this.db = db
  }

  createSession(name: string, cwd: string, provider: string, model: string): DaemonSession {
    return this.db.createSession({ name, cwd, provider, model })
  }

  getSession(id: string): DaemonSession | null {
    return this.db.getSession(id)
  }

  listSessions(status?: string): DaemonSession[] {
    return this.db.listSessions(status)
  }

  getOrCreateByFeishuOpenId(
    openId: string,
    cwd: string,
    provider: string,
    model: string,
  ): DaemonSession {
    const name = `feishu-${openId}`
    const existing = this.db.listSessions().find((s) => s.name === name && s.status !== 'closed')
    if (existing) return existing
    return this.db.createSession({ name, cwd, provider, model })
  }

  closeSession(id: string): void {
    this.db.closeSession(id)
    for (const cb of this.closeCallbacks) {
      try {
        cb(id)
      } catch {
        /* callback errors should not propagate */
      }
    }
  }

  getActiveCount(): number {
    const stats = this.db.getStats()
    return stats.activeSessions
  }

  onSessionClosed(callback: SessionCloseCallback): void {
    this.closeCallbacks.push(callback)
  }
}
