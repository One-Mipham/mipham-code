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

export type SessionKind = 'interactive' | 'forked' | 'attached' | 'unattended'

export interface AgentSession {
  id: string
  title: string
  status: SessionStatus
  kind: SessionKind
  provider: string
  model: string
  task: string
  createdAt: Date
  startedAt?: Date
  completedAt?: Date
  elapsedMs: number
  messages: SessionMessage[]
  /** Git worktree path (forked sessions) */
  worktree?: string
  /** Git branch name (forked sessions) */
  branch?: string
  /** Created PR URL (if requested) */
  prUrl?: string
  /**
   * Id of the `BackgroundAgentRegistry` task actually doing the work, when this
   * session was spawned by `/bg` or `/fork`.
   *
   * The two id spaces are minted separately (`agent-…` here, `bg-…` there), so
   * without this the dashboard holds a row it cannot act on: its own `kill()`
   * only flips the row's status and leaves the real task running with no handle
   * left in the UI. This field is that handle.
   */
  taskId?: string
  /** Working directory the session was spawned from (used for directory grouping). */
  directory: string
}

export interface CreateSessionOptions {
  provider?: string
  model?: string
  directory?: string
}

export interface SessionPeek {
  session: AgentSession
  recentMessages: SessionMessage[]
}

export type StatusGroups = Record<SessionStatus, AgentSession[]>

export interface DirectoryGroup {
  directory: string
  sessions: AgentSession[]
}

export class AgentViewManager {
  private sessions: Map<string, AgentSession> = new Map()
  private sessionOrder: string[] = []
  private idCounter = 0
  private listeners: Set<() => void> = new Set()

  /**
   * Subscribe to any mutation of the session set. Returns an unsubscribe fn.
   *
   * The dashboard renders from this object, but the changes originate elsewhere
   * (`/bg` and `/fork` mutate it from their executors, which resolve long after
   * the keystroke that spawned them). Without a subscription the view is a
   * snapshot painted once at mount: `setVersion` had exactly one caller
   * (Ctrl+X), so a row that finished while the panel was open stayed `working`
   * on screen forever.
   */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** One listener throwing must not stop the others, nor the mutation itself. */
  private notify(): void {
    for (const listener of this.listeners) {
      try {
        listener()
      } catch {
        // A broken view must never break the state transition that triggered it.
      }
    }
  }

  /**
   * Create a new background agent session.
   */
  create(title: string, task: string, options: CreateSessionOptions = {}): AgentSession {
    const id = `agent-${++this.idCounter}-${Date.now()}`
    const session: AgentSession = {
      id,
      title,
      status: 'needs-input',
      kind: 'interactive',
      provider: options.provider ?? 'unknown',
      model: options.model ?? 'unknown',
      task,
      directory: options.directory ?? process.cwd(),
      createdAt: new Date(),
      elapsedMs: 0,
      messages: [],
    }

    this.sessions.set(id, session)
    this.sessionOrder.push(id)
    this.notify()

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
   * Group all sessions by their working directory (v2.1.229 session-grouping alignment).
   * Returns groups sorted alphabetically by directory path.
   */
  groupByDirectory(): DirectoryGroup[] {
    const groups = new Map<string, AgentSession[]>()

    for (const id of this.sessionOrder) {
      const session = this.sessions.get(id)
      if (!session) continue
      const dir = session.directory || '(unknown)'
      const existing = groups.get(dir)
      if (existing) existing.push(session)
      else groups.set(dir, [session])
    }

    return Array.from(groups.entries())
      .map(([directory, sessions]) => ({ directory, sessions }))
      .sort((a, b) => a.directory.localeCompare(b.directory))
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

    this.notify()
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
    this.notify()
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

    this.notify()
    return true
  }

  /**
   * Add a message to a session's message history.
   */
  addMessage(id: string, message: SessionMessage): boolean {
    const session = this.sessions.get(id)
    if (!session) return false

    session.messages.push(message)
    this.notify()
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
   * Rename a session's title. Returns true if found and renamed.
   */
  rename(id: string, newTitle: string): boolean {
    const session = this.sessions.get(id)
    if (!session) return false
    session.title = newTitle
    this.notify()
    return true
  }

  /**
   * Permanently remove a single session (any status). Returns true if found.
   */
  remove(id: string): boolean {
    if (!this.sessions.has(id)) return false
    this.sessions.delete(id)
    this.sessionOrder = this.sessionOrder.filter((oid) => oid !== id)
    this.notify()
    return true
  }

  /**
   * Remove all completed and failed sessions (cleanup).
   */
  prune(): number {
    const terminalIds = Array.from(this.sessions.entries())
      .filter(([, session]) => session.status === 'completed' || session.status === 'failed')
      .map(([id]) => id)
    let removed = 0
    for (const id of terminalIds) {
      if (this.remove(id)) removed++
    }
    return removed
  }
}
