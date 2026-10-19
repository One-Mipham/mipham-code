// Cron poller — makes the CLI's durable CronCreate jobs actually fire.
//
// Every minute it reads ~/.mipham/cron/*.json and, for each job whose
// nextFire has passed, enqueues the prompt into the engine's cron queue
// (which re-invokes it into the current session) and then advances the job
// (recurring → next fire; one-shot → deleted).

import { mkdirSync, rmSync, statSync } from 'node:fs'
import { computeNextFire } from './cron'
import type { CronJob } from '../tools/scheduling/cron'
import { readAllJobs, writeJob, deleteJobFile, jobPath } from '../tools/scheduling/cron'

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
 * A claim older than this belonged to a poller that died mid-fire. Firing a job
 * twice is recoverable; never firing it again is not, so stale claims are
 * reclaimed rather than trusted forever.
 */
export const CLAIM_STALE_MS = 5 * 60_000

function claimPath(id: string): string {
  return `${jobPath(id)}.lock`
}

/** Atomic across processes: `mkdir` fails with EEXIST for every loser. */
function makeClaim(path: string): boolean {
  try {
    mkdirSync(path)
    return true
  } catch {
    return false
  }
}

/** Take one job's claim. False = another poller is (or was) on it. */
function tryClaim(id: string): boolean {
  const path = claimPath(id)
  if (makeClaim(path)) return true
  try {
    if (Date.now() - statSync(path).mtimeMs < CLAIM_STALE_MS) return false
    rmSync(path, { recursive: true, force: true })
  } catch {
    // It vanished between the two calls (the holder released or another poller
    // reclaimed it) — that poller fires this tick. Skip rather than risk a
    // second one firing too.
    return false
  }
  return makeClaim(path)
}

function releaseClaim(id: string): void {
  try {
    rmSync(claimPath(id), { recursive: true, force: true })
  } catch {
    /* Best effort — a leftover claim goes stale and is reclaimed. */
  }
}

/**
 * Read due jobs, enqueue their prompts, and advance/delete. Returns fired count.
 *
 * `cwd` defaults to the process's working directory — the same source
 * `ToolContext.cwd` comes from — because the enqueued prompt lands in *this*
 * session and is executed here. Without the filter, a schedule created in one
 * project would be run by whatever session happened to be open in another.
 *
 * The store is global and every open CLI in the same directory runs its own
 * poller, so two of them can read the same due job before either writes it
 * back — the prompt would run twice. Each job is claimed with an exclusive
 * directory before firing, and the file is re-read under that claim: a poller
 * whose snapshot has gone stale (the job was advanced or deleted meanwhile)
 * skips it.
 *
 * Delivery is at-least-once, not exactly-once: a process killed between
 * `enqueue` and `writeJob` leaves the claim behind, and once it goes stale the
 * job fires again. Two pollers reclaiming the same stale claim can likewise
 * both proceed. The claim closes the concurrent-poller window, not the crash
 * window — the prompt has already been handed to the session by then.
 */
export function checkCronJobs(
  enqueue: (prompt: string) => void,
  now = new Date(),
  cwd = process.cwd(),
): number {
  const due = findDueJobs(readAllJobs(), now, cwd)
  let fired = 0
  for (const job of due) {
    if (!tryClaim(job.id)) continue
    try {
      const current = readAllJobs().find((j) => j.id === job.id)
      if (!current || findDueJobs([current], now, cwd).length === 0) continue
      enqueue(current.prompt)
      const next = advanceJob(current, now)
      if (next) writeJob(next)
      else deleteJobFile(current.id)
      fired++
    } finally {
      releaseClaim(job.id)
    }
  }
  return fired
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
