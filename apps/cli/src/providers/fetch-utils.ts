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

// 529 is Anthropic's non-standard "overloaded" status: the request is rejected
// *before* the stream starts, on exactly the same terms as a 503 — transient,
// retryable, and already bounded by the `Retry-After` clamp below. Without it
// here, a 529 answers `!response.ok` and the whole turn dies at the first byte.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529])

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
 * Provider error types that are decided, not transient. A content filter or a
 * malformed request answers the same way on every attempt, so re-sending it only
 * makes the user wait for an error that was final the first time.
 */
const NON_RETRYABLE_ERROR_TYPES = new Set([
  'invalid_request_error',
  'authentication_error',
  'permission_error',
  'not_found_error',
  'request_too_large',
  'content_filter',
  'content_policy_violation',
])

/**
 * Should the engine re-send a turn the provider reported as failed?
 *
 * Two call shapes: an HTTP status, or a provider error object's `type`/`code`.
 * Statuses follow the same rule as `fetchWithRetry` (429 and 5xx are transient).
 * For an error type, only the *known* deterministic ones say no — an unrecognised
 * type stays retryable, because guessing "final" would lose a recoverable turn.
 */
export function isRetryableFailure(status: number | undefined, errorType?: string): boolean {
  if (status !== undefined) return RETRYABLE_STATUSES.has(status) || status >= 500
  if (errorType === undefined) return true
  return !NON_RETRYABLE_ERROR_TYPES.has(errorType)
}

/** Base backoff between retry attempts, in ms. */
export const DEFAULT_RETRY_BASE_DELAY_MS = 1_000

/**
 * The default backoff, overridable from the environment.
 *
 * One second suits an interactive turn, but a caller pointed at a known-overloaded
 * endpoint (a self-hosted gateway, a batch run) wants longer gaps between attempts
 * — and cannot pass `baseDelay` through the SDK paths that build their own
 * `fetchWithRetry` call. `MIPHAM_OVERLOADED_RETRY_BASE_DELAY_MS` is that knob.
 *
 * A malformed value (non-numeric, negative) is a typo, not an instruction: fall
 * back to the built-in rather than let `sleep(NaN)` become a zero-delay retry
 * loop. Read per call so a test can set it without re-importing the module.
 */
function resolveBaseDelayMs(): number {
  const raw = process.env.MIPHAM_OVERLOADED_RETRY_BASE_DELAY_MS
  if (raw === undefined || raw.trim() === '') return DEFAULT_RETRY_BASE_DELAY_MS
  const ms = Number(raw)
  if (!Number.isFinite(ms) || ms < 0) return DEFAULT_RETRY_BASE_DELAY_MS
  return ms
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
  const { timeout = 60_000, maxRetries = 2, baseDelay = resolveBaseDelayMs() } = options

  let lastErr: unknown

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController()
    let timedOut = false
    // Awake-time, not wall-clock: a machine that slept through the window has
    // not actually waited `timeout` ms for a first byte (see `createAwakeTimer`).
    const cancelTimer = createAwakeTimer(timeout, () => {
      timedOut = true
      controller.abort()
    })
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
      cancelTimer()
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

/**
 * A timeout that measures *awake* time, and so survives the machine sleeping.
 *
 * `setTimeout` runs on the wall clock. A laptop suspended for an hour fires every
 * pending timer the instant it wakes, so a 90-second idle budget is reported the
 * moment the user opens the lid — the stream is declared stalled and the turn is
 * killed, even though the connection sat idle for zero seconds of real time.
 *
 * `performance.now()` is monotonic and does not advance while the host is
 * suspended, so the difference it reports is time the machine was actually awake.
 * When the timer fires with less than `budgetMs` of awake time behind it, the
 * shortfall was a sleep: re-arm for the remainder instead of firing.
 *
 * Returns a cancel function.
 */
export function createAwakeTimer(budgetMs: number, onExpire: () => void): () => void {
  // The epoch the budget is measured from. Kept across a re-arm so the next
  // check compares against the total awake time, not just the last slice.
  const start = performance.now()
  let handle: ReturnType<typeof setTimeout> | undefined
  let cancelled = false

  const arm = (remainingMs: number): void => {
    handle = setTimeout(() => {
      if (cancelled) return
      const elapsed = performance.now() - start
      if (elapsed < budgetMs) {
        // Woke from sleep: only part of the budget was really spent. Keep the
        // epoch and re-arm for what is left.
        arm(Math.max(0, budgetMs - elapsed))
        return
      }
      onExpire()
    }, remainingMs)
  }
  arm(budgetMs)

  return () => {
    cancelled = true
    if (handle !== undefined) clearTimeout(handle)
  }
}
