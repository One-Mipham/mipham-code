import type { Message, ToolResultContent } from '@mipham/shared'
import type { CacheTracker } from './context-token'
import { estimateMessageTokens } from './context-token'

const PLACEHOLDER = '[earlier result omitted]'

interface MicrocompactOptions {
  keepRecent: number // number of recent tool-call pairs to keep intact
}

interface MicrocompactResult {
  messages: Message[]
  tokensSaved: number
}

/**
 * Layer 2: Cache-aware micro-compression.
 *
 * Replaces old tool_result content with a placeholder, preserving message
 * structure. Only compresses messages NOT in the prompt cache to avoid
 * cache invalidation costs.
 */
export function microcompact(
  messages: Message[],
  cacheTracker: CacheTracker,
  options: MicrocompactOptions = { keepRecent: 3 },
): MicrocompactResult {
  const result: Message[] = []
  let tokensSaved = 0

  // Identify tool-call pairs (user query -> assistant tool_use -> user tool_result)
  // Count from the end to keep the most recent ones intact
  const pairCount = countToolPairs(messages)
  const compressBeforePair = Math.max(0, pairCount - options.keepRecent)

  let pairIndex = 0
  let i = 0

  while (i < messages.length) {
    const msg = messages[i]!

    // Check if this starts a tool-call pair
    if (isToolResultUserMessage(msg) && pairIndex < compressBeforePair) {
      // Don't compress if it's in the prompt cache
      if (!cacheTracker.isInCache(msg)) {
        const compressed = compressToolResult(msg)
        result.push(compressed)
        tokensSaved += estimateMessageTokens(msg) - estimateMessageTokens(compressed)
        i++
        pairIndex++
        continue
      }
    }

    // Count pairs as we go
    if (isToolResultUserMessage(msg)) {
      pairIndex++
    }

    result.push(msg)
    i++
  }

  return { messages: result, tokensSaved }
}

function countToolPairs(messages: Message[]): number {
  let count = 0
  for (const msg of messages) {
    if (isToolResultUserMessage(msg)) count++
  }
  return count
}

function isToolResultUserMessage(msg: Message): boolean {
  if (msg.role !== 'user') return false
  if (!Array.isArray(msg.content)) return false
  return msg.content.some(
    (block: unknown) =>
      block !== null &&
      typeof block === 'object' &&
      (block as unknown as Record<string, unknown>).type === 'tool_result',
  )
}

function compressToolResult(msg: Message): Message {
  if (!Array.isArray(msg.content)) return msg

  const compressed = msg.content.map((block: unknown) => {
    if (
      block !== null &&
      typeof block === 'object' &&
      (block as unknown as Record<string, unknown>).type === 'tool_result'
    ) {
      return {
        ...(block as object),
        content: PLACEHOLDER,
      } as ToolResultContent
    }
    return block as ToolResultContent
  })

  return { ...msg, content: compressed }
}

/**
 * Decide whether microcompaction is worth it.
 *
 * Only compress when tokens saved > tokens lost from cache invalidation.
 * The multiplier of 1.5 provides a safety margin.
 */
export function shouldMicrocompact(
  messages: Message[],
  cacheTracker: CacheTracker,
  _threshold: number,
): boolean {
  let savingsTokens = 0
  let cacheLossTokens = 0

  for (const msg of messages) {
    if (isToolResultUserMessage(msg)) {
      const tokens = estimateMessageTokens(msg)
      if (cacheTracker.isInCache(msg)) {
        cacheLossTokens += tokens
      } else {
        savingsTokens += tokens * 0.5 // we save ~50% by replacing content
      }
    }
  }

  return savingsTokens > cacheLossTokens * 1.5
}
