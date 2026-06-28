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

function isRetryableError(err: unknown): boolean {
  if (err instanceof DOMException && err.name === 'AbortError') return false
  return true
}

/**
 * Fetch with optional timeout and retry with exponential backoff.
 *
 * Retries on: network errors, 5xx, 429.
 * Does NOT retry on: timeout (AbortError), 4xx (except 429).
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
    const timer = setTimeout(() => controller.abort(), timeout)
    const signal = init.signal
      ? anySignal([init.signal, controller.signal])
      : controller.signal

    try {
      const response = await fetch(url, { ...init, signal })

      // 429 / 5xx → retry
      if (RETRYABLE_STATUSES.has(response.status) && attempt < maxRetries) {
        const retryAfter = response.headers.get('Retry-After')
        const delay = retryAfter
          ? parseInt(retryAfter, 10) * 1000
          : baseDelay * Math.pow(2, attempt)
        await sleep(delay)
        continue
      }

      return response
    } catch (err) {
      lastErr = err
      if (!isRetryableError(err) || attempt >= maxRetries) throw err
      await sleep(baseDelay * Math.pow(2, attempt))
    } finally {
      clearTimeout(timer)
      // Clean up combined signal if we created one
      if (init.signal) {
        try {
          controller.abort()
        } catch {
          /* best effort */
        }
      }
    }
  }

  throw lastErr
}

/** Simple promise-based sleep. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Combine multiple AbortSignals into one — any signal aborting
 * triggers the combined signal.
 */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController()
  const onAbort = () => {
    controller.abort()
    for (const s of signals) s.removeEventListener('abort', onAbort)
  }
  for (const s of signals) {
    if (s.aborted) {
      controller.abort()
      return controller.signal
    }
    s.addEventListener('abort', onAbort)
  }
  return controller.signal
}
