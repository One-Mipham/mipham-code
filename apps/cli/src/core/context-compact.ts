import type { ContextManager, Summarizer } from './context'
import { snipMessages } from './context-snip'
import { CompactionProgressTracker } from './compaction-progress'

/**
 * Layer 3: Reactive Compact — API-based summarization.
 *
 * When the context exceeds the compaction threshold, uses an LLM summarizer
 * to condense the conversation history, keeping recent messages intact.
 *
 * After compaction, the context contains:
 * 1. A summary message of the truncated history
 * 2. The most recent N messages (kept intact)
 * 3. The system prompt (unchanged)
 */
/**
 * Adaptive keep-recent count: scales with context window size.
 * 128K → 20, 200K → 20, 500K → 40, 1M → 80
 */
function getKeepRecent(contextWindow: number): number {
  return Math.max(20, Math.floor(contextWindow / 12500))
}

export interface CompactResult {
  /** Messages before compaction */
  beforeCount: number
  /** Messages after compaction */
  afterCount: number
  /** Whether compaction was actually performed */
  compacted: boolean
  /** Progress summary for display */
  summary: string
}

export async function reactiveCompact(
  context: ContextManager,
  summarizer: Summarizer,
  heading: string,
  keepRecent?: number,
): Promise<CompactResult> {
  // Use explicit override, or adaptive default based on context window
  const effectiveKeepRecent = keepRecent ?? getKeepRecent(context.getMaxTokens())
  const messages = context.getMessages()
  const tokensBefore = context.getEstimatedTokens()

  if (messages.length <= effectiveKeepRecent + 4) {
    return {
      beforeCount: messages.length,
      afterCount: messages.length,
      compacted: false,
      summary: `Context has ${messages.length} messages — no compaction needed (threshold: ${effectiveKeepRecent + 4}).`,
    }
  }

  // ── Progress tracker ──
  const tracker = new CompactionProgressTracker(messages.length, tokensBefore)
  tracker.update({ phase: 'snip', message: 'Snipping empty pairs...', percent: 5 })

  // First, run snip to remove empty pairs
  const { messages: snipped } = snipMessages(messages)
  tracker.update({
    phase: 'snip',
    message: `Snipped ${messages.length - snipped.length} empty pairs`,
    percent: 15,
    messagesAfter: snipped.length,
  })

  if (snipped.length <= effectiveKeepRecent + 4) {
    const afterCount = snipped.length
    tracker.complete(afterCount, tokensBefore)
    return {
      beforeCount: messages.length,
      afterCount,
      compacted: true,
      summary: `Snip-only: ${messages.length} → ${afterCount} messages (removed ${messages.length - afterCount} empty pairs).`,
    }
  }

  // Split: old messages to summarize, recent messages to keep
  const toSummarize = snipped.slice(0, -effectiveKeepRecent)
  const toKeep = snipped.slice(-effectiveKeepRecent)

  tracker.update({
    phase: 'reactive-compact',
    message: `Summarizing ${toSummarize.length} messages...`,
    percent: 20,
  })

  // Generate summary with retry logic
  let summary: string
  try {
    summary = await CompactionProgressTracker.retrySummarizer(
      () => summarizer(toSummarize, heading),
      tracker,
      toSummarize.length,
    )
  } catch {
    // On summarizer failure, do a simple truncation
    tracker.update({
      message: `Summarizer unavailable — truncating to last ${effectiveKeepRecent} messages.`,
      percent: 80,
    })
    summary = `Earlier conversation (${toSummarize.length} messages) omitted due to context limits.`
  }

  // Rebuild messages: summary + recent
  const summaryMsg = {
    role: 'user' as const,
    content: `[Earlier conversation summary — ${heading}]: ${summary.slice(0, 8000)}`,
  }

  const newMessages = [summaryMsg, ...toKeep]
  context.replaceMessages(newMessages)

  const tokensAfter = context.getEstimatedTokens()
  tracker.complete(newMessages.length, tokensAfter)

  return {
    beforeCount: messages.length,
    afterCount: newMessages.length,
    compacted: true,
    summary: tracker.getSummary(),
  }
}
