// apps/cli/src/daemon/schedule-manager.ts — Phase 4: Schedule service layer
// Manages cron-based scheduled prompts: create, list, delete, and automatic firing.
// Delegates persistence to DaemonDatabase; uses WorkerPool for prompt execution.

import type { DaemonDatabase } from './database'
import type { WorkerPool } from './worker-pool'
import type { DaemonSchedule } from './types'
import { logger } from './logger'
import { computeNextFire } from '../core/cron'

export class ScheduleManager {
  private db: DaemonDatabase
  private pool: WorkerPool
  private intervalId: Timer | null = null

  constructor(db: DaemonDatabase, pool: WorkerPool) {
    this.db = db
    this.pool = pool
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
   * 1. Look up the session worker — skip if none is active
   * 2. Send the prompt to the worker (fire-and-forget)
   * 3. Update lastFired and compute the next fire time
   */
  checkAndFire(): void {
    const due = this.db.getDueSchedules()
    for (const schedule of due) {
      const worker = this.pool.getWorker(schedule.sessionId)
      if (!worker) continue

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
