/**
 * BackgroundAgentRegistry — lifecycle manager for background agent tasks.
 *
 * Each background task runs as a detached Promise with an AbortController
 * for cancellation. The registry tracks status and stores results, which
 * can be queried via the Task tool (output/stop actions) or the Agent View.
 */

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed'

export interface BackgroundTask {
  id: string
  description: string
  agentType: string
  status: BackgroundTaskStatus
  startedAt: Date
  completedAt?: Date
  result?: string
  error?: string
  abortController: AbortController
}

type CompleteCallback = (task: BackgroundTask) => void

export class BackgroundAgentRegistry {
  private tasks: Map<string, BackgroundTask> = new Map()
  private completeCallbacks: Map<string, CompleteCallback[]> = new Map()
  private idCounter = 0

  /**
   * Spawn a background task. Returns the task ID immediately.
   * The executor function runs asynchronously; its result is stored in the task.
   *
   * @param description - Human-readable description
   * @param agentType - Sub-agent type (general, explore, plan, code-review)
   * @param executor - Async function that performs the work
   */
  spawn(
    description: string,
    agentType: string,
    executor: (signal: AbortSignal) => Promise<string>,
  ): string {
    const id = `bg-${++this.idCounter}-${Date.now().toString(36)}`

    const task: BackgroundTask = {
      id,
      description,
      agentType,
      status: 'running',
      startedAt: new Date(),
      abortController: new AbortController(),
    }

    this.tasks.set(id, task)

    // Execute in background — do NOT await
    executor(task.abortController.signal)
      .then((result) => {
        task.status = 'completed'
        task.completedAt = new Date()
        task.result = result
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
