// apps/cli/src/daemon/schedule-manager.ts — Phase 4: Schedule service layer
// Manages cron-based scheduled prompts: create, list, delete, and automatic firing.
// Delegates persistence to DaemonDatabase; uses WorkerPool for prompt execution.

import type { DaemonDatabase } from './database'
import type { WorkerPool } from './worker-pool'
import type { DaemonSchedule } from './types'

// Simple minute-granularity cron expression parser.
//
// Supports the standard 5-field cron format:
//   minute hour day-of-month month day-of-week
//
// Handles: * (wildcard), star/N (step), N (exact), N-M (range), N,M,O (list).
// Falls back to +1 minute if the expression is invalid or no match is found
// within 366 days.
function computeNextFire(cronExpr: string, from: Date): string {
  const fields = cronExpr.trim().split(/\s+/)
  if (fields.length !== 5) {
    return new Date(from.getTime() + 60_000).toISOString()
  }

  const minField = fields[0]!
  const hourField = fields[1]!
  const domField = fields[2]!
  const monthField = fields[3]!
  const dowField = fields[4]!

  function matches(value: number, field: string): boolean {
    if (field === '*') return true
    // */N step
    const stepMatch = field.match(/^\*\/(\d+)$/)
    if (stepMatch) {
      return value % parseInt(stepMatch[1]!, 10) === 0
    }
    // Comma-separated list
    if (field.includes(',')) {
      return field.split(',').some((f) => matches(value, f))
    }
    // Range
    const rangeMatch = field.match(/^(\d+)-(\d+)$/)
    if (rangeMatch) {
      const low = parseInt(rangeMatch[1]!, 10)
      const high = parseInt(rangeMatch[2]!, 10)
      return value >= low && value <= high
    }
    // Exact value
    return value === parseInt(field, 10)
  }

  const date = new Date(from)
  date.setSeconds(0, 0)
  // Start from the next minute to avoid matching the current minute
  date.setMinutes(date.getMinutes() + 1)

  // Try up to 366 days forward (safety limit — ~527k iterations)
  const maxIterations = 366 * 24 * 60
  for (let i = 0; i < maxIterations; i++) {
    const minute = date.getMinutes()
    const hour = date.getHours()
    const dom = date.getDate()
    const month = date.getMonth() + 1 // JS months are 0-indexed
    const dow = date.getDay() // 0 = Sunday

    if (
      matches(minute, minField) &&
      matches(hour, hourField) &&
      matches(dom, domField) &&
      matches(month, monthField) &&
      matches(dow, dowField)
    ) {
      return date.toISOString()
    }

    date.setMinutes(date.getMinutes() + 1)
  }

  // Fallback: 1 minute from now
  return new Date(from.getTime() + 60_000).toISOString()
}

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
        console.error(`ScheduleManager: error firing schedule ${schedule.id}:`, err)
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
