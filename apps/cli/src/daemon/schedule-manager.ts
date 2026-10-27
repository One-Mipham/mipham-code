// apps/cli/src/daemon/schedule-manager.ts — Phase 4: Schedule service layer
// Manages cron-based scheduled prompts: create, list, delete, and automatic firing.
// Delegates persistence to DaemonDatabase; uses WorkerPool for prompt execution.

import type { DaemonDatabase } from './database'
import type { WorkerPool } from './worker-pool'
import type { SessionWorker } from './session-worker'
import type { DaemonSchedule } from './types'
import { logger } from './logger'
import { computeNextFire } from '../core/cron'

export class ScheduleManager {
  private db: DaemonDatabase
  private pool: WorkerPool
  private intervalId: Timer | null = null
  private spawnWorker: ((sessionId: string) => SessionWorker | null) | null = null

  constructor(db: DaemonDatabase, pool: WorkerPool) {
    this.db = db
    this.pool = pool
  }

  /**
   * Register the daemon's "bring this session's worker back" hook.
   *
   * Workers are otherwise created lazily, on an inbound prompt — so a session
   * whose worker was never started, or was recycled by the idle timeout, has
   * nobody to deliver a due schedule to, and the cron entry silently never runs.
   * The daemon wires this once its own engine factory exists (it is created after
   * this manager), which is why it is a setter and not a constructor argument.
   */
  setWorkerSpawner(fn: (sessionId: string) => SessionWorker | null): void {
    this.spawnWorker = fn
  }

  createSchedule(sessionId: string, cronExpr: string, prompt: string): number {
    const now = new Date()
    const nextFire = computeNextFire(cronExpr, now)
    return this.db.createSchedule({
      sessionId,
      cronExpr,
      prompt,
      enabled: true,
      lastFired: null,
      nextFire,
    })
  }

  getSchedules(sessionId: string): DaemonSchedule[] {
    return this.db.getSchedules(sessionId)
  }

  deleteSchedule(id: number): void {
    this.db.deleteSchedule(id)
  }

  /**
   * Check for due schedules and fire them.
   *
   * For each schedule whose nextFire has passed:
   * 1. Look up the session worker — start one if none is active and the daemon
   *    supplied a spawner (a recycled or never-started session must still get its
   *    scheduled prompt; skipping it means the cron entry never runs at all)
   * 2. Send the prompt to the worker (fire-and-forget)
   * 3. Update lastFired and compute the next fire time
   *
   * A schedule that still has no worker is left alone — `nextFire` stays in the
   * past, so the next tick tries again rather than dropping the run.
   */
  checkAndFire(): void {
    const due = this.db.getDueSchedules()
    for (const schedule of due) {
      const worker =
        this.pool.getWorker(schedule.sessionId) ??
        this.spawnWorker?.(schedule.sessionId) ??
        undefined
      if (!worker) {
        logger.warn('scheduled prompt skipped: no worker for session', {
          scheduleId: schedule.id,
          sessionId: schedule.sessionId,
        })
        continue
      }

      worker.processPrompt(schedule.prompt).catch((err: unknown) => {
        logger.error('error firing schedule', { scheduleId: schedule.id, error: err })
      })

      const now = new Date()
      const nextFire = computeNextFire(schedule.cronExpr, now)
      this.db.updateScheduleFireTimes(schedule.id, now.toISOString(), nextFire)
    }
  }

  /**
   * Start the schedule-checking interval.
   * Checks every 60 seconds. Timer is unref'd so it does not prevent
   * the process from exiting when all other work is done.
   */
  start(): void {
    if (this.intervalId) return
    this.intervalId = setInterval(() => {
      this.checkAndFire()
    }, 60_000)
    this.intervalId.unref()
  }

  /**
   * Stop the schedule-checking interval.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId)
      this.intervalId = null
    }
  }
}
