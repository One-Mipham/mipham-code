/**
 * Shared fetch utilities — retry, timeout, backoff.
 *
 * Both AnthropicProvider and OpenAICompatProvider use these for
 * resilient API communication.
 */

export interface FetchWithRetryOptions {
  /** Request timeout in ms (applied via AbortController). */
  timeout?: number
  /** Maximum retry attempts (default 0 = no retry). */
  maxRetries?: number
  /** Base delay for exponential backoff in ms (default 1000). */
  baseDelay?: number
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504])

/**
 * Upper bound on a server-supplied `Retry-After`, in ms.
 *
 * The header is a *request*, not a contract: a 5xx answering `Retry-After: 3600`
 * used to park the CLI in `sleep` for a full hour with nothing on screen. The
 * user cannot cancel what they cannot see, so the wait is capped and the reason
 * is left in the comment rather than the terminal.
 */
export const RETRY_AFTER_MAX_MS = 60_000

/**
 * Lower bound on a server-supplied `Retry-After`, in ms.
 *
 * `Retry-After: 0` is a real thing servers send, and honouring it literally
 * means retrying the instant the previous attempt failed — a hammering loop
 * dressed up as politeness. Any present-but-tiny value lands here instead.
 */
const RETRY_AFTER_MIN_MS = 1_000

/**
 * Delay before the next retry attempt.
 *
 * `Retry-After` is honoured when it is parseable, clamped to
 * `[RETRY_AFTER_MIN_MS, RETRY_AFTER_MAX_MS]`, and **ignored in favour of
 * exponential backoff when it is not** — an unparseable header must not become
 * `sleep(NaN)`, which `setTimeout` reads as 0 (the same back-to-back retry as
 * `Retry-After: 0`, but silent).
 *
 * Accepts both RFC 9110 forms: delta-seconds and an HTTP-date.
 */
export function retryDelayMs(
  retryAfter: string | null,
  attempt: number,
  baseDelay: number,
): number {
  const backoff = baseDelay * Math.pow(2, attempt)
  if (retryAfter === null) return backoff

  const header = retryAfter.trim()
  const seconds = parseInt(header, 10)
  let requested: number
  if (!Number.isNaN(seconds)) {
    requested = seconds * 1000
  } else {
    const at = Date.parse(header)
    if (Number.isNaN(at)) return backoff // unparseable → backoff, never a zero sleep
    requested = at - Date.now()
  }

  return Math.min(Math.max(requested, RETRY_AFTER_MIN_MS), RETRY_AFTER_MAX_MS)
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return false
  return true
}

/**
 * Fetch with optional timeout and retry with exponential backoff.
 *
 * Retries on: network errors, 5xx, 429, and the internal timeout firing
 *   (first-byte never arrived) — retried once as a transient network issue.
 * Does NOT retry on: caller-initiated abort (init.signal), 4xx (except 429).
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: FetchWithRetryOptions = {},
): Promise<Response> {
  const { timeout = 60_000, maxRetries = 2, baseDelay = 1000 } = options

  let lastErr: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeout)
    // `AbortSignal.any` (node ≥22 / bun ≥1.2, both in `engines`) instead of a
    // hand-rolled combiner: it keeps a *weak* reference to the source signals, so
    // the combination stays live for the reader without pinning the caller's
    // signal — which is what the hand-rolled version had to trade away.
    const signal = init.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal

    try {
      const response = await fetch(url, { ...init, signal })

      // 429 / 5xx → retry
      if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
        await sleep(retryDelayMs(response.headers.get('Retry-After'), attempt, baseDelay))
        continue
      }

      return response
    } catch (err) {
      lastErr = err
      // First-byte timeout is transient → retry once. Caller abort is not.
      const retryable = timedOut || isRetryableError(err)
      if (!retryable || attempt >= maxRetries) {
        if (timedOut) {
          throw new Error(
            `API Error: No response from API (timed out after ${Math.round(timeout / 1000)}s)`,
          )
        }
        throw err
      }
      await sleep(baseDelay * Math.pow(2, attempt))
    } finally {
      clearTimeout(timer)
      // Nothing to release: the combination is natively managed. Do NOT abort
      // anything here — `fetch` holds that signal and the caller reads the body
      // *after* we return, so aborting it at this point errored every response at
      // the headers (measured on Node: the next read throws AbortError; Bun
      // happens to tolerate it, which is why a Bun-only run never showed this).
    }
  }

  throw lastErr
}

/** Simple promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ── Streaming idle-timeout (stall guard) with effort multiplier ──────────
//
// Reasoning models think silently for long stretches. The idle timeout between
// stream chunks is scaled by reasoning effort so a long thinking pass isn't
// mistaken for a stalled connection (jcode stall-guard alignment).

/** Base idle timeout between stream chunks, in ms. */
export const STREAM_IDLE_TIMEOUT_BASE_MS = 90_000

/** Effort level → idle-timeout multiplier. Unknown/absent effort → 1× (base). */
const EFFORT_TIMEOUT_MULTIPLIER: Record<string, number> = {
  high: 2,
  xhigh: 3,
  max: 4,
}

/** Compute the streaming idle timeout for a given reasoning-effort level. */
export function streamIdleTimeoutMs(effort?: string): number {
  const multiplier = effort ? (EFFORT_TIMEOUT_MULTIPLIER[effort] ?? 1) : 1
  return STREAM_IDLE_TIMEOUT_BASE_MS * multiplier
}
