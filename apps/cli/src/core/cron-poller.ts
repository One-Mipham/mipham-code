// Cron poller — makes the CLI's durable CronCreate jobs actually fire.
//
// Every minute it reads ~/.mipham/cron/*.json and, for each job whose
// nextFire has passed, enqueues the prompt into the engine's cron queue
// (which re-invokes it into the current session) and then advances the job
// (recurring → next fire; one-shot → deleted).

import { computeNextFire } from './cron'
import type { CronJob } from '../tools/scheduling/cron'
import { readAllJobs, writeJob, deleteJobFile } from '../tools/scheduling/cron'

/** Jobs whose nextFire is at or before `now`. Pure — separated for tests. */
export function findDueJobs(jobs: CronJob[], now: Date): CronJob[] {
  return jobs.filter((j) => new Date(j.nextFire).getTime() <= now.getTime())
}

/** Next state after firing a due job: recurring advances; one-shot → null (delete). */
export function advanceJob(job: CronJob, now: Date): CronJob | null {
  if (!job.recurring) return null
  return {
    ...job,
    lastFired: now.toISOString(),
    nextFire: computeNextFire(job.cron, now),
  }
}

/** Read due jobs, enqueue their prompts, and advance/delete. Returns fired count. */
export function checkCronJobs(enqueue: (prompt: string) => void, now = new Date()): number {
  const due = findDueJobs(readAllJobs(), now)
  for (const job of due) {
    enqueue(job.prompt)
    const next = advanceJob(job, now)
    if (next) writeJob(next)
    else deleteJobFile(job.id)
  }
  return due.length
}

/**
 * Start the cron poller. Returns a stop function. The interval is unref'd so
 * it never keeps the process alive on its own.
 */
export function startCronPoller(
  enqueue: (prompt: string) => void,
  intervalMs = 60_000,
): () => void {
  const timer = setInterval(() => {
    checkCronJobs(enqueue)
  }, intervalMs)
  timer.unref()
  return () => clearInterval(timer)
}
