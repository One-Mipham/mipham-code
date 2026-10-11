import type { Message } from '../shared/index.ts'

/**
 * Ratio of the declared window at which a sub-agent shrinks its context.
 * Kept in step with `ContextManager`'s default `compactionThreshold` so an agent
 * that opted into `autoCompactWindow` compacts at the same fill the main session
 * would.
 */
const SHRINK_THRESHOLD = 0.85

/**
 * Tail sizes tried, largest first. Mirrors `COMPACTION_PASSES`' shrink-to-fit:
 * keep as much recent context as fits, and only take a shorter tail if the first
 * candidate is still over budget. Bounded so a shrink always terminates.
 */
const KEEP_CANDIDATES = [10, 4] as const

/**
 * True iff `msg` is a `user` turn carrying one or more `tool_result` blocks.
 *
 * Such a turn is meaningless without the `tool_use` it answers, and providers
 * reject an orphaned `tool_result` — so truncation must never leave one at the
 * head of what it keeps.
 */
export function isToolResultMessage(msg: Message): boolean {
  return (
    msg.role === 'user' &&
    Array.isArray(msg.content) &&
    msg.content.some((b) => b.type === 'tool_result')
  )
}

/**
 * Shrink a sub-agent's message list, preserving its task.
 *
 * Unlike `ContextManager.compact` (keep the last N; let a summarizer condense the
 * front), a sub-agent has **no summarizer** and **no persistent goal-bearing
 * system prompt** — `messages[0]` *is* the task. Keeping only a tail would strand
 * the agent with nothing to do, so the opening message is pinned and the middle is
 * dropped instead.
 *
 * Opt-in: the loop only calls this when the agent declared `autoCompactWindow`;
 * without the field the run is byte-identical to before. No-op until the estimate
 * exceeds `window * SHRINK_THRESHOLD`.
 *
 * `estimate` is threaded in rather than reimplemented, so the caller gates on the
 * very number `ContextManager` would report — never a second, divergent estimate.
 * Returns the input array unchanged when no shrink is needed.
 */
export function shrinkAgentMessages(
  messages: Message[],
  window: number,
  estimate: (m: Message[]) => number,
): Message[] {
  if (messages.length < 3) return messages
  if (estimate(messages) <= window * SHRINK_THRESHOLD) return messages

  const task = messages[0]!
  const rest = messages.slice(1)

  for (let i = 0; i < KEEP_CANDIDATES.length; i++) {
    let tail = rest.slice(-KEEP_CANDIDATES[i]!)
    // Drop orphaned tool_results at the head (their tool_use was cut away).
    while (tail.length > 0 && isToolResultMessage(tail[0]!)) tail = tail.slice(1)
    const candidate = [task, ...tail]
    if (estimate(candidate) <= window * SHRINK_THRESHOLD || i === KEEP_CANDIDATES.length - 1) {
      return candidate
    }
  }

  return messages
}
