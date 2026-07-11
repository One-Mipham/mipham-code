/**
 * AgentViewManager — multi-session lifecycle manager for background agent sessions.
 *
 * Each session represents a background sub-agent task. The manager tracks
 * status transitions, elapsed time, and provides grouping/peek/attach/kill
 * operations used by the Agent View Dashboard TUI.
 */

export type SessionStatus = 'needs-input' | 'working' | 'completed' | 'failed'

export interface SessionMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
}

export interface AgentSession {
  id: string
  title: string
  status: SessionStatus
  provider: string
  model: string
  task: string
  createdAt: Date
  startedAt?: Date
  completedAt?: Date
  elapsedMs: number
  messages: SessionMessage[]
}

export interface CreateSessionOptions {
  provider?: string
  model?: string
}

export interface SessionPeek {
  session: AgentSession
  recentMessages: SessionMessage[]
}

export type StatusGroups = Record<SessionStatus, AgentSession[]>

export class AgentViewManager {
  private sessions: Map<string, AgentSession> = new Map()
  private sessionOrder: string[] = []
  private idCounter = 0

  /**
   * Create a new background agent session.
   */
  create(title: string, task: string, options: CreateSessionOptions = {}): AgentSession {
    const id = `agent-${++this.idCounter}-${Date.now()}`
    const session: AgentSession = {
      id,
      title,
      status: 'needs-input',
      provider: options.provider ?? 'unknown',
      model: options.model ?? 'unknown',
      task,
      createdAt: new Date(),
      elapsedMs: 0,
      messages: [],
    }

    this.sessions.set(id, session)
    this.sessionOrder.push(id)

    return session
  }

  /**
   * List all sessions in creation order (newest first).
   */
  list(): AgentSession[] {
    return [...this.sessionOrder]
      .reverse()
      .map((id) => this.sessions.get(id)!)
      .filter(Boolean)
  }

  /**
   * Group all sessions by their current status.
   * Returns a record with keys for all four statuses (empty arrays if none).
   */
  groupByStatus(): StatusGroups {
    const groups: StatusGroups = {
      'needs-input': [],
      working: [],
      completed: [],
      failed: [],
    }

    for (const id of this.sessionOrder) {
      const session = this.sessions.get(id)
      if (session) {
        groups[session.status].push(session)
      }
    }

    return groups
  }

  /**
   * Get a session by ID.
   */
  get(id: string): AgentSession | undefined {
    return this.sessions.get(id)
  }

  /**
   * Peek at a session — returns the session metadata and up to 5 recent messages.
   */
  peek(id: string): SessionPeek | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined

    const recentMessages = session.messages.slice(-5)
    return { session, recentMessages }
  }

  /**
   * Attach to a session — marks the session as working (if needs-input) and
   * returns it so the caller can switch the main UI to this session.
   */
  attach(id: string): AgentSession | undefined {
    const session = this.sessions.get(id)
    if (!session) return undefined

    // If the session was waiting for input, transition to working
    if (session.status === 'needs-input') {
      session.status = 'working'
      session.startedAt = new Date()
    }

    return session
  }

  /**
   * Kill (terminate) a session. Only kills sessions that are not already completed/failed.
   * Returns true if the session was found and killed, false otherwise.
   */
  kill(id: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false

    // Don't re-kill already terminal sessions
    if (session.status === 'completed' || session.status === 'failed') {
      return false
    }

    session.status = 'failed'
    session.completedAt = new Date()
    return true
  }

  /**
   * Update a session's status and optionally add a message.
   */
  updateStatus(id: string, status: SessionStatus): boolean {
    const session = this.sessions.get(id)
    if (!session) return false

    session.status = status

    if (status === 'working' && !session.startedAt) {
      session.startedAt = new Date()
    }
    if ((status === 'completed' || status === 'failed') && !session.completedAt) {
      session.completedAt = new Date()
    }

    return true
  }

  /**
   * Add a message to a session's message history.
   */
  addMessage(id: string, message: SessionMessage): boolean {
    const session = this.sessions.get(id)
    if (!session) return false

    session.messages.push(message)
    return true
  }

  /**
   * Count sessions by status.
   */
  countByStatus(): Record<SessionStatus, number> {
    const counts: Record<SessionStatus, number> = {
      'needs-input': 0,
      working: 0,
      completed: 0,
      failed: 0,
    }

    for (const [, session] of this.sessions) {
      counts[session.status]++
    }

    return counts
  }

  /**
   * Remove all completed and failed sessions (cleanup).
   */
  prune(): number {
    let removed = 0
    for (const [id, session] of this.sessions) {
      if (session.status === 'completed' || session.status === 'failed') {
        this.sessions.delete(id)
        this.sessionOrder = this.sessionOrder.filter((oid) => oid !== id)
        removed++
      }
    }
    return removed
  }
}
