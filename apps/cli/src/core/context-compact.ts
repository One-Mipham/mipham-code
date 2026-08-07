import type { ContextManager, Summarizer } from './context'
import { snipMessages } from './context-snip'

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

export async function reactiveCompact(
  context: ContextManager,
  summarizer: Summarizer,
  heading: string,
  keepRecent?: number,
): Promise<void> {
  // Use explicit override, or adaptive default based on context window
  const effectiveKeepRecent =
    keepRecent ?? getKeepRecent(context.getMaxTokens())
  const messages = context.getMessages()

  if (messages.length <= effectiveKeepRecent + 4) return

  // First, run snip to remove empty pairs
  const { messages: snipped } = snipMessages(messages)

  if (snipped.length <= effectiveKeepRecent + 4) return

  // Split: old messages to summarize, recent messages to keep
  const toSummarize = snipped.slice(0, -effectiveKeepRecent)
  const toKeep = snipped.slice(-effectiveKeepRecent)

  // Generate summary
  let summary: string
  try {
    summary = await summarizer(toSummarize, heading)
  } catch {
    // On summarizer failure, do a simple truncation
    summary = `Earlier conversation (${toSummarize.length} messages) omitted due to context limits.`
  }

  // Rebuild messages: summary + recent
  const summaryMsg = {
    role: 'user' as const,
    content: `[Earlier conversation summary — ${heading}]: ${summary.slice(0, 8000)}`,
  }

  context.replaceMessages([summaryMsg, ...toKeep])
}
