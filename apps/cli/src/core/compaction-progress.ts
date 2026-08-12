/**
 * P1.1: Compaction Progress Tracker
 *
 * Provides user-visible progress feedback during context compaction:
 *   - Phase indicator (which compaction layer is active)
 *   - Message count (how many messages being processed)
 *   - Retry countdown for API-based summarization
 *   - Stuck detection hints
 *
 * Designed as an event emitter that the UI layer subscribes to.
 * Falls back to stderr output when no UI subscriber is registered.
 */

// ── Types ──

export type CompactionPhase =
  'microcompact' | 'snip' | 'reactive-compact' | 'emergency-drain' | 'complete'

export interface CompactionStatus {
  phase: CompactionPhase
  /** Human-readable description of current action */
  message: string
  /** 0-100 percentage, or -1 if indeterminate */
  percent: number
  /** Total messages before compaction */
  messagesBefore: number
  /** Messages remaining after compaction */
  messagesAfter: number
  /** Tokens before compaction */
  tokensBefore: number
  /** Tokens after compaction */
  tokensAfter: number
  /** Elapsed ms since compaction started */
  elapsedMs: number
  /** Retry count for summarization API calls */
  retryCount: number
  /** Whether a retry is in progress */
  retrying: boolean
  /** Whether the compaction appears stuck (no progress for >30s) */
  stuck: boolean
}

export type ProgressCallback = (status: CompactionStatus) => void

// ── Constants ──

/** Timeout in ms after which we consider compaction "stuck" */
const STUCK_TIMEOUT_MS = 30_000

/** Max retries for summarizer API calls */
const MAX_SUMMARIZER_RETRIES = 3

/** Retry delay in ms between summarizer attempts */
const RETRY_DELAY_MS = 2_000

// ── Tracker ──

export class CompactionProgressTracker {
  private callback: ProgressCallback | null = null
  private status: CompactionStatus
  private startTime = 0
  private lastProgressTime = 0

  constructor(messagesBefore: number, tokensBefore: number) {
    this.status = {
      phase: 'microcompact',
      message: 'Starting compaction...',
      percent: 0,
      messagesBefore,
      messagesAfter: messagesBefore,
      tokensBefore,
      tokensAfter: tokensBefore,
      elapsedMs: 0,
      retryCount: 0,
      retrying: false,
      stuck: false,
    }
    this.startTime = Date.now()
    this.lastProgressTime = Date.now()
  }

  /** Register a UI callback for progress updates. */
  onProgress(cb: ProgressCallback): void {
    this.callback = cb
  }

  /** Update phase with new values. */
  update(partial: {
    phase?: CompactionPhase
    message?: string
    percent?: number
    messagesAfter?: number
    tokensAfter?: number
    retrying?: boolean
  }): void {
    if (partial.phase !== undefined) this.status.phase = partial.phase
    if (partial.message !== undefined) this.status.message = partial.message
    if (partial.percent !== undefined) this.status.percent = partial.percent
    if (partial.messagesAfter !== undefined) this.status.messagesAfter = partial.messagesAfter
    if (partial.tokensAfter !== undefined) this.status.tokensAfter = partial.tokensAfter
    if (partial.retrying !== undefined) this.status.retrying = partial.retrying

    this.status.elapsedMs = Date.now() - this.startTime

    // Check for stuck detection
    if (this.status.phase !== 'complete') {
      const timeSinceProgress = Date.now() - this.lastProgressTime
      this.status.stuck = timeSinceProgress > STUCK_TIMEOUT_MS
    }

    this.emit()
  }

  /** Mark current retry attempt. */
  onRetry(attempt: number): void {
    this.status.retryCount = attempt
    this.status.retrying = true
    this.emit()
  }

  /** Mark retry as complete (success or giving up). */
  onRetryComplete(): void {
    this.status.retrying = false
    this.lastProgressTime = Date.now()
    this.status.stuck = false
    this.emit()
  }

  /** Mark compaction as complete. */
  complete(messagesAfter: number, tokensAfter: number): void {
    this.status.phase = 'complete'
    this.status.percent = 100
    this.status.messagesAfter = messagesAfter
    this.status.tokensAfter = tokensAfter
    this.status.message = `Compaction complete: ${this.status.messagesBefore} → ${messagesAfter} messages`
    this.status.elapsedMs = Date.now() - this.startTime
    this.emit()
  }

  /** Get current status. */
  getStatus(): CompactionStatus {
    return { ...this.status }
  }

  /** Generate a compact summary string for CLI display. */
  getSummary(): string {
    const s = this.status
    const elapsed = (s.elapsedMs / 1000).toFixed(1)
    const stuckHint = s.stuck ? ' (stalled — press Esc to cancel)' : ''
    const retryHint = s.retrying ? ` [retry ${s.retryCount}/${MAX_SUMMARIZER_RETRIES}...]` : ''
    const pct = s.percent >= 0 ? ` ${s.percent}%` : ''
    return `🔄 [${s.phase}]${pct} ${s.message}${retryHint}${stuckHint} (${elapsed}s)`
  }

  private emit(): void {
    if (this.callback) {
      try {
        this.callback(this.getStatus())
      } catch {
        // UI callback failure shouldn't block compaction
      }
    }
  }

  // ── Static helpers ──

  /** Retry a summarizer call with backoff and progress tracking. */
  static async retrySummarizer(
    summarizer: () => Promise<string>,
    tracker: CompactionProgressTracker,
    messagesToSummarize: number,
  ): Promise<string> {
    let lastError: Error | undefined

    for (let attempt = 1; attempt <= MAX_SUMMARIZER_RETRIES; attempt++) {
      try {
        tracker.update({
          message: `Summarizing ${messagesToSummarize} messages${attempt > 1 ? ` (attempt ${attempt}/${MAX_SUMMARIZER_RETRIES})` : ''}...`,
          percent: 30 + attempt * 20,
          retrying: attempt > 1,
        })

        const result = await summarizer()
        tracker.onRetryComplete()
        return result
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err))

        if (attempt < MAX_SUMMARIZER_RETRIES) {
          tracker.onRetry(attempt)
          // Wait before retry
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
          tracker.onRetryComplete()
        }
      }
    }

    tracker.update({
      message: `Summarization failed after ${MAX_SUMMARIZER_RETRIES} attempts — falling back to truncation`,
      percent: 60,
    })

    throw lastError ?? new Error('Summarization failed')
  }
}
