import type { Message } from '../shared/index.js'

interface SnipResult {
  messages: Message[]
  removed: number
}

/**
 * Layer 1: Zero-cost pruning.
 *
 * Removes tool_use + empty tool_result message pairs that carry no
 * information value. This is a pure data transformation — no API calls.
 *
 * A pair is eligible for removal when:
 * - The assistant message contains only a tool_use block
 * - The immediately following user message contains only a tool_result
 *   with empty or whitespace-only content
 */
export function snipMessages(messages: Message[]): SnipResult {
  if (messages.length < 2) return { messages: [...messages], removed: 0 }

  const result: Message[] = []
  let removed = 0
  let i = 0

  while (i < messages.length) {
    // Look for a tool_use assistant message followed by empty tool_result
    if (
      i + 1 < messages.length &&
      messages[i]!.role === 'assistant' &&
      isOnlyToolUse(messages[i]!) &&
      messages[i + 1]!.role === 'user' &&
      isEmptyToolResult(messages[i + 1]!)
    ) {
      removed += 2
      i += 2
      continue
    }

    result.push(messages[i]!)
    i++
  }

  return { messages: result, removed }
}

function isOnlyToolUse(msg: Message): boolean {
  if (!Array.isArray(msg.content)) return false
  const nonToolUse = msg.content.filter(
    (block: unknown) =>
      !(
        block &&
        typeof block === 'object' &&
        (block as Record<string, unknown>).type === 'tool_use'
      ),
  )
  // Must have at least one tool_use and nothing else substantial
  const hasToolUse = msg.content.some(
    (block: unknown) =>
      block && typeof block === 'object' && (block as Record<string, unknown>).type === 'tool_use',
  )
  return hasToolUse && nonToolUse.length === 0
}

function isEmptyToolResult(msg: Message): boolean {
  if (!Array.isArray(msg.content)) return false
  return msg.content.every((block: unknown) => {
    if (!block || typeof block !== 'object') return false
    const b = block as Record<string, unknown>
    if (b.type !== 'tool_result') return true // non-tool_result blocks don't count
    const content = String(b.content || '')
    return content.trim().length === 0
  })
}
