/**
 * BackgroundAgentRegistry — lifecycle manager for background agent tasks.
 *
 * Each background task runs as a detached Promise with an AbortController
 * for cancellation. The registry tracks status and stores results, which
 * can be queried via the Task tool (output/stop actions) or the Agent View.
 *
 * When a database is provided via setDatabase(), agent records are persisted
 * to the daemon's SQLite database for cross-session visibility.
 */

export type BackgroundTaskKind = 'interactive' | 'forked' | 'attached' | 'unattended'

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed'

export interface BackgroundTask {
  id: string
  description: string
  agentType: string
  status: BackgroundTaskStatus
  kind: BackgroundTaskKind
  startedAt: Date
  /** Cumulative token usage (input + output) reported by the running task. */
  tokensUsed: number
  completedAt?: Date
  result?: string
  error?: string
  /** Git worktree path (forked tasks) */
  worktree?: string
  /** Git branch name (forked tasks) */
  branch?: string
  /** Created PR URL (if requested) */
  prUrl?: string
  abortController: AbortController
}

/** Minimal database interface for agent persistence — avoids circular imports
 *  on the DaemonDatabase class. */
interface AgentDatabase {
  createAgent(agent: {
    id: string
    sessionId: string
    parentId: string | null
    agentType: string
    description: string
    status: string
    kind: string
    worktree: string | null
    branch: string | null
    prUrl: string | null
    createdAt: string
    completedAt: string | null
    result: string | null
    error: string | null
  }): unknown
  updateAgentStatus(id: string, status: string, result?: string, error?: string): void
}

type CompleteCallback = (task: BackgroundTask) => void

export class BackgroundAgentRegistry {
  private tasks: Map<string, BackgroundTask> = new Map()
  private completeCallbacks: Map<string, CompleteCallback[]> = new Map()
  private idCounter = 0
  private db: AgentDatabase | null = null

  /**
   * Set the daemon database for optional SQLite persistence.
   * When set, spawned agents are persisted to the database and their
   * status updates are kept in sync.
   *
   * Uses a structural interface to avoid circular imports on DaemonDatabase.
   */
  setDatabase(db: AgentDatabase): void {
    this.db = db
  }

  /**
   * Spawn a background task. Returns the task ID immediately.
   * The executor function runs asynchronously; its result is stored in the task.
   *
   * If a database is configured, the agent record is also persisted to SQLite.
   *
   * @param description - Human-readable description
   * @param agentType - Sub-agent type (general, explore, plan, code-review)
   * @param executor - Async function that performs the work
   */
  spawn(
    description: string,
    agentType: string,
    executor: (signal: AbortSignal) => Promise<string>,
    kind: BackgroundTaskKind = 'interactive',
  ): string {
    const id = `bg-${++this.idCounter}-${Date.now().toString(36)}`
    const now = new Date()

    const task: BackgroundTask = {
      id,
      description,
      agentType,
      status: 'running',
      kind,
      startedAt: now,
      tokensUsed: 0,
      abortController: new AbortController(),
    }

    this.tasks.set(id, task)

    // Persist to SQLite when database is available
    if (this.db) {
      try {
        this.db.createAgent({
          id,
          sessionId: 'background',
          parentId: null,
          agentType,
          description,
          status: 'running',
          kind,
          worktree: task.worktree ?? null,
          branch: task.branch ?? null,
          prUrl: task.prUrl ?? null,
          createdAt: now.toISOString(),
          completedAt: null,
          result: null,
          error: null,
        })
      } catch {
        // Database persistence is best-effort — don't fail the task
      }
    }

    // Execute in background — do NOT await
    executor(task.abortController.signal)
      .then((result) => {
        task.status = 'completed'
        task.completedAt = new Date()
        task.result = result
        this.syncDbStatus(id, 'completed', result)
        this.fireComplete(id)
      })
      .catch((err) => {
        // Don't mark as failed if it was intentionally aborted
        if (err instanceof Error && err.name === 'AbortError') {
          task.status = 'failed'
          task.error = 'Task was cancelled.'
        } else {
          task.status = 'failed'
          task.error = String(err)
        }
        task.completedAt = new Date()
        this.syncDbStatus(id, task.status, undefined, task.error)
        this.fireComplete(id)
      })

    return id
  }

  /**
   * Get a task by ID. Returns undefined if not found.
   */
  get(id: string): BackgroundTask | undefined {
    return this.tasks.get(id)
  }

  /**
   * List all background tasks, newest first.
   */
  list(): BackgroundTask[] {
    return Array.from(this.tasks.values()).sort(
      (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
    )
  }

  /**
   * List only running tasks.
   */
  listRunning(): BackgroundTask[] {
    return this.list().filter((t) => t.status === 'running')
  }

  /**
   * Update the cumulative token usage reported by a running task.
   * No-op if the task no longer exists.
   */
  updateTokenUsage(id: string, tokensUsed: number): void {
    const task = this.tasks.get(id)
    if (task) task.tokensUsed = tokensUsed
  }

  /**
   * Stop a running task by aborting its controller.
   * Returns true if the task was running and was stopped.
   */
  stop(id: string): boolean {
    const task = this.tasks.get(id)
    if (!task) return false
    if (task.status !== 'running') return false

    task.abortController.abort()
    return true
  }

  /**
   * Register a callback that fires when a task completes (success or failure).
   * The callback is called once and then automatically removed.
   */
  onComplete(id: string, callback: CompleteCallback): void {
    // If already complete, call immediately
    const task = this.tasks.get(id)
    if (task && task.status !== 'running') {
      callback(task)
      return
    }

    const cbs = this.completeCallbacks.get(id) || []
    cbs.push(callback)
    this.completeCallbacks.set(id, cbs)
  }

  /**
   * Remove completed/failed tasks older than `maxAgeMs`.
   * Returns the number of tasks pruned.
   */
  prune(maxAgeMs: number = 30 * 60 * 1000): number {
    const now = Date.now()
    let removed = 0
    for (const [id, task] of this.tasks) {
      if (task.status === 'running') continue
      if (task.completedAt && now - task.completedAt.getTime() > maxAgeMs) {
        this.tasks.delete(id)
        this.completeCallbacks.delete(id)
        removed++
      }
    }
    return removed
  }

  /**
   * Count tasks by status.
   */
  countByStatus(): Record<BackgroundTaskStatus, number> {
    const counts: Record<BackgroundTaskStatus, number> = {
      running: 0,
      completed: 0,
      failed: 0,
    }
    for (const [, task] of this.tasks) {
      counts[task.status]++
    }
    return counts
  }

  /**
   * Sync task completion/failure status to the daemon database.
   * Best-effort — errors are silently ignored.
   */
  private syncDbStatus(id: string, status: string, result?: string, error?: string): void {
    if (!this.db) return
    try {
      this.db.updateAgentStatus(id, status, result, error)
    } catch {
      // Database sync is best-effort
    }
  }

  private fireComplete(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return

    const cbs = this.completeCallbacks.get(id)
    if (cbs) {
      for (const cb of cbs) {
        try {
          cb(task)
        } catch {
          // Callback errors should not propagate
        }
      }
      this.completeCallbacks.delete(id)
    }
  }
}

/** Singleton instance for the CLI process. */
let _instance: BackgroundAgentRegistry | null = null

export function getBackgroundAgentRegistry(): BackgroundAgentRegistry {
  if (!_instance) {
    _instance = new BackgroundAgentRegistry()
  }
  return _instance
}
