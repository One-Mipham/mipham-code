import { fetchWithRetry } from '../providers/fetch-utils'
import { ackQueue, readQueue, type QueuedEvent } from './queue'

/**
 * Upload queued events.
 *
 * Runs at *startup*, not at exit: `process.on('exit')` cannot await async work,
 * so collecting and sending are decoupled — the session queue is written
 * synchronously at exit and drained here on the next launch. Same shape as the
 * existing startup update check (`shared/update.ts`), which is likewise
 * fire-and-forget.
 *
 * Every failure is silent and leaves the event queued for the next attempt. A
 * telemetry endpoint being unreachable must never be visible to the user.
 */

/** Per-request budget. Short: this runs alongside startup, not during it. */
const REQUEST_TIMEOUT_MS = 10_000

export interface FlushResult {
  sent: number
  failed: number
}

/**
 * Drain the queue to `endpoint`.
 *
 * Returns without sending anything when the endpoint is empty — which is the
 * shipped default, so an unconfigured install performs **zero** network calls.
 */
export async function flushQueue(
  endpoint: string,
  opts: { fetchImpl?: typeof fetch; events?: QueuedEvent[] } = {},
): Promise<FlushResult> {
  if (!endpoint) return { sent: 0, failed: 0 }

  const events = opts.events ?? readQueue()
  if (events.length === 0) return { sent: 0, failed: 0 }

  const sent: string[] = []
  let failed = 0

  for (const event of events) {
    try {
      const response = await fetchWithRetry(
        endpoint,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(event),
        },
        { timeout: REQUEST_TIMEOUT_MS, maxRetries: 2, baseDelay: 1000 },
      )

      // 4xx means we are sending something the endpoint will never accept —
      // retrying forever would wedge the queue behind a permanently bad event.
      // Drop it on the floor rather than block every later event.
      if (response.ok || (response.status >= 400 && response.status < 500)) {
        sent.push(event.id)
      } else {
        failed++
      }
    } catch {
      failed++
    }
  }

  ackQueue(sent)
  return { sent: sent.length, failed }
}

/**
 * Fire-and-forget startup flush. Never rejects, never blocks the caller, and
 * never surfaces an error — the caller does not await it.
 */
export function flushQueueInBackground(endpoint: string): void {
  if (!endpoint) return
  void flushQueue(endpoint).catch(() => {
    /* best-effort by design */
  })
}
