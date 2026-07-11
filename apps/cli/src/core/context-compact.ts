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
export async function reactiveCompact(
  context: ContextManager,
  summarizer: Summarizer,
  heading: string,
  keepRecent: number = 20,
): Promise<void> {
  const messages = context.getMessages()

  if (messages.length <= keepRecent + 4) return

  // First, run snip to remove empty pairs
  const { messages: snipped } = snipMessages(messages)

  if (snipped.length <= keepRecent + 4) return

  // Split: old messages to summarize, recent messages to keep
  const toSummarize = snipped.slice(0, -keepRecent)
  const toKeep = snipped.slice(-keepRecent)

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
    content: `[Earlier conversation summary — ${heading}]: ${summary.slice(0, 2000)}`,
  }

  context.replaceMessages([summaryMsg, ...toKeep])
}
