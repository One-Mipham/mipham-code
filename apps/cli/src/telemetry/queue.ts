import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../shared/atomic-write'
import { telemetryDir } from './consent'

/**
 * Local queue of telemetry events awaiting upload.
 *
 * Every operation here is **synchronous**, and that is a requirement, not a
 * convenience: the session payload is written from inside
 * `process.on('exit')`, which cannot await async work. Every other exit-path
 * write in the repo is synchronous for the same reason (`persistSession` in
 * `index.tsx`, `EffectivenessTracker.persist()`).
 *
 * Sending is therefore decoupled from collecting: events are queued at exit and
 * uploaded on the *next* startup, where async is allowed.
 */

/** Entries kept before the oldest are dropped. Bounds disk use on a machine that can never reach an endpoint. */
export const QUEUE_MAX_ENTRIES = 100

export interface QueuedEvent {
  /** Stable per-event id, used to acknowledge a successful upload. */
  id: string
  kind: 'session' | 'crash'
  payload: Record<string, unknown>
}

export function queuePath(): string {
  return join(telemetryDir(), 'queue.jsonl')
}

/**
 * Read the queue. A missing file is an empty queue; an unparsable *line* is
 * skipped rather than thrown, so one truncated write can never wedge every
 * future session.
 */
export function readQueue(): QueuedEvent[] {
  const path = queuePath()
  if (!existsSync(path)) return []

  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    return []
  }

  const events: QueuedEvent[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as QueuedEvent
      if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') events.push(parsed)
    } catch {
      /* skip the damaged line, keep the rest */
    }
  }
  return events
}

/**
 * Replace the queue wholesale, atomically.
 *
 * Capacity is enforced by dropping the *oldest* entries — the newest events
 * describe the current version, which is the version worth hearing about.
 * Silent: a queue write must never surface as a user-visible error, and must
 * never take down an exit path.
 */
export function writeQueue(events: QueuedEvent[]): void {
  try {
    const kept = events.length > QUEUE_MAX_ENTRIES ? events.slice(-QUEUE_MAX_ENTRIES) : events
    const body = kept.map((e) => JSON.stringify(e)).join('\n')
    // atomicWriteFileSync does not create parents (same as the settings writer,
    // which mkdirs first) — without this the queue silently never materialises
    // on a fresh machine, where ~/.mipham/telemetry/ does not exist yet.
    mkdirSync(telemetryDir(), { recursive: true })
    atomicWriteFileSync(queuePath(), body.length > 0 ? body + '\n' : '', { mode: 0o600 })
  } catch {
    /* best-effort by design */
  }
}

/** Append one event, dropping the oldest if the queue is at capacity. */
export function enqueueSync(event: QueuedEvent): void {
  writeQueue([...readQueue(), event])
}

/** Drop events whose ids are no longer wanted (i.e. they uploaded successfully). */
export function ackQueue(ids: Iterable<string>): void {
  const done = new Set(ids)
  if (done.size === 0) return
  writeQueue(readQueue().filter((e) => !done.has(e.id)))
}
