// apps/cli/src/daemon/worker-pool.ts — Phase 2: Worker Pool Management
//
// WorkerPool manages the lifecycle of SessionWorker instances across all
// active sessions in the daemon. It provides lazy creation, idle timeout
// (auto-stop inactive workers), and graceful shutdown.
//
// Architecture:
//   WorkerPool
//     owns Map<string, SessionWorker>  (active workers)
//     owns Map<string, Timer>          (idle timeouts)
//     references DaemonDatabase        (session metadata + persistence)
//
// Lifecycle:
//   1. createWorker() — creates or returns cached SessionWorker, starts idle timer
//   2. getWorker()    — lookup by sessionId
//   3. resetIdleTimeout() — called on each prompt to keep worker alive
//   4. stopWorker()   — interrupt, save, remove, mark idle, callback
//   5. stopAll()      — graceful shutdown of all workers

import { SessionWorker } from './session-worker'
import type { DaemonDatabase } from './database'
import type { QueryEngine } from '../core/engine'
import type { ContextManager } from '../core/context'
import type { ProviderRegistry } from '../providers/registry'
import { logger } from './logger'

export class WorkerPool {
  private workers: Map<string, SessionWorker>
  private db: DaemonDatabase
  private idleTimeouts: Map<string, Timer>
  private readonly idleTimeoutMs: number

  /** Called when a worker is stopped (either explicitly or by idle timeout). */
  onSessionClosed?: (sessionId: string) => void

  constructor(db: DaemonDatabase, idleTimeoutMs: number = 30 * 60 * 1000) {
    this.workers = new Map()
    this.db = db
    this.idleTimeouts = new Map()
    this.idleTimeoutMs = idleTimeoutMs
  }

  /**
   * Create a SessionWorker for the given session, or return an existing one.
   *
   * The engine, context, and registry are accepted for validation and
   * extensibility; the SessionWorker itself is constructed from engine + db
   * + DaemonSession (fetched from the database by sessionId).
   *
   * Starts the idle timeout on creation. Callers should invoke
   * {@link resetIdleTimeout} on each prompt to keep the worker alive.
   */
  createWorker(
    sessionId: string,
    engine: QueryEngine,
    _context: ContextManager,
    _registry: ProviderRegistry,
  ): SessionWorker {
    // Return cached worker if it exists
    const existing = this.workers.get(sessionId)
    if (existing) {
      return existing
    }

    // Look up session metadata from the database
    const session = this.db.getSession(sessionId)
    if (!session) {
      throw new Error(
        `WorkerPool: cannot create worker for session ${sessionId} — not found in database`,
      )
    }

    const worker = new SessionWorker(engine, this.db, session)
    this.workers.set(sessionId, worker)
    this.resetIdleTimeout(sessionId)
    return worker
  }

  /** Get the SessionWorker for a session, or undefined if not active. */
  getWorker(sessionId: string): SessionWorker | undefined {
    return this.workers.get(sessionId)
  }

  /** Check whether a worker is active for the given session. */
  hasWorker(sessionId: string): boolean {
    return this.workers.has(sessionId)
  }

  /** List all currently active session IDs. */
  getActiveSessions(): string[] {
    return Array.from(this.workers.keys())
  }

  /** Number of currently active workers. */
  get size(): number {
    return this.workers.size
  }

  /**
   * Stop a worker: interrupt any in-progress generation, persist state,
   * mark the session as idle in the database, remove from pool, clear
   * the idle timeout, and fire the onSessionClosed callback.
   */
  async stopWorker(sessionId: string): Promise<void> {
    const worker = this.workers.get(sessionId)
    if (!worker) return

    // Interrupt any in-progress prompt processing
    worker.interrupt()

    // Persist the full conversation state to the database
    worker.saveToDatabase()

    // Mark the session as idle (not closed) — the session record
    // remains available for future re-attach or resume
    this.db.updateSessionStatus(sessionId, 'idle')

    // Remove from the active worker map
    this.workers.delete(sessionId)

    // Clear the idle timeout
    const timeout = this.idleTimeouts.get(sessionId)
    if (timeout) {
      clearTimeout(timeout)
      this.idleTimeouts.delete(sessionId)
    }

    // Fire the lifecycle callback
    if (this.onSessionClosed) {
      this.onSessionClosed(sessionId)
    }
  }

  /**
   * Reset the idle timeout for a session.
   *
   * Call this on every user prompt so the worker stays alive as long as
   * the user is actively interacting. If no prompt arrives within
   * `idleTimeoutMs`, the worker is automatically stopped to free resources.
   */
  resetIdleTimeout(sessionId: string): void {
    // Clear the existing timeout if there is one
    const existing = this.idleTimeouts.get(sessionId)
    if (existing) {
      clearTimeout(existing)
    }

    // Set a new timeout — when it fires, auto-stop the worker
    const timeout = setTimeout(() => {
      this.stopWorker(sessionId).catch((err) => {
        // Log but never crash — this runs in a Timer callback outside
        // any request context
        logger.error('error auto-stopping idle worker', { sessionId, error: err })
      })
    }, this.idleTimeoutMs)

    // unref so the timer does not prevent the Node/Bun process from
    // exiting when all other work is complete
    timeout.unref()

    this.idleTimeouts.set(sessionId, timeout)
  }

  /**
   * Gracefully stop all workers.
   *
   * Iterates over all active workers, interrupts them, persists their
   * state, and cleans up. Runs all stops in parallel since workers
   * are independent.
   */
  async stopAll(): Promise<void> {
    const sessionIds = Array.from(this.workers.keys())
    await Promise.all(sessionIds.map((id) => this.stopWorker(id)))
  }
}
