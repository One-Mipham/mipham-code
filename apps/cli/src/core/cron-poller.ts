// Cron poller — makes the CLI's durable CronCreate jobs actually fire.
//
// Every minute it reads ~/.mipham/cron/*.json and, for each job whose
// nextFire has passed, enqueues the prompt into the engine's cron queue
// (which re-invokes it into the current session) and then advances the job
// (recurring → next fire; one-shot → deleted).

import { computeNextFire } from './cron'
import type { CronJob } from '../tools/scheduling/cron'
import { readAllJobs, writeJob, deleteJobFile } from '../tools/scheduling/cron'

/**
 * Whether a job belongs to `cwd`.
 *
 * A job with no `cwd` is from a file written before jobs carried one; it matches
 * anywhere so an existing user's schedule keeps firing instead of going silent.
 * `cwd === undefined` means the caller did not ask for scoping at all (the pure
 * helpers' existing callers), so nothing is filtered.
 */
function matchesCwd(job: CronJob, cwd?: string): boolean {
  if (job.cwd === undefined || cwd === undefined) return true
  return job.cwd === cwd
}

/** Jobs whose nextFire is at or before `now` — and which belong to `cwd`. */
export function findDueJobs(jobs: CronJob[], now: Date, cwd?: string): CronJob[] {
  return jobs.filter((j) => new Date(j.nextFire).getTime() <= now.getTime() && matchesCwd(j, cwd))
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

/**
 * Read due jobs, enqueue their prompts, and advance/delete. Returns fired count.
 *
 * `cwd` defaults to the process's working directory — the same source
 * `ToolContext.cwd` comes from — because the enqueued prompt lands in *this*
 * session and is executed here. Without the filter, a schedule created in one
 * project would be run by whatever session happened to be open in another.
 */
export function checkCronJobs(
  enqueue: (prompt: string) => void,
  now = new Date(),
  cwd = process.cwd(),
): number {
  const due = findDueJobs(readAllJobs(), now, cwd)
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
