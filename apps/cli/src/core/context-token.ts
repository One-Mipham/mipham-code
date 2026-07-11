import type { Message } from '@mipham/shared'

export interface CacheStatus {
  totalMessages: number
  cachedMessages: number
  cachedTokens: number
  uncachedTokens: number
}

export interface CacheTracker {
  /** Returns true if the message is currently held in the provider's prompt cache. */
  isInCache(msg: Message): boolean
  /** Returns a snapshot of the cache state for metrics / logging. */
  getStatus(): CacheStatus
  /** Clear the tracker state (does NOT evict from provider cache). */
  invalidate(): void
}

/**
 * A no-op cache tracker for use when prompt caching is unavailable or disabled.
 * Every message reports as uncached, so microcompaction always considers savings.
 */
export class NoopCacheTracker implements CacheTracker {
  private messageCount = 0

  isInCache(_msg: Message): boolean {
    return false
  }

  getStatus(): CacheStatus {
    return {
      totalMessages: this.messageCount,
      cachedMessages: 0,
      cachedTokens: 0,
      uncachedTokens: 0,
    }
  }

  /** Register a batch of messages for status tracking. */
  track(messages: Message[]): void {
    this.messageCount = messages.length
  }

  invalidate(): void {
    this.messageCount = 0
  }
}

/**
 * Estimate the token count for a single message.
 *
 * Uses the same character-class-aware heuristic as ContextManager.estimateTokens():
 *   - CJK / emoji: ~1.5 chars per token
 *   - Other scripts: ~4 chars per token
 */
export function estimateMessageTokens(msg: Message): number {
  const text = extractMessageText(msg)
  return estimateStringTokens(text)
}

function extractMessageText(msg: Message): string {
  if (typeof msg.content === 'string') {
    return msg.content
  }
  if (Array.isArray(msg.content)) {
    return msg.content
      .map((block) => {
        if (block && typeof block === 'object') {
          const b = block as unknown as Record<string, unknown>
          if (b.type === 'text') return String(b.text ?? '')
          if (b.type === 'tool_use') return JSON.stringify(b.input ?? {})
          if (b.type === 'tool_result') return String(b.content ?? '')
          if (b.type === 'image_url') return '[image]'
        }
        return ''
      })
      .join(' ')
  }
  return ''
}

function estimateStringTokens(text: string): number {
  if (!text) return 0

  let cjk = 0
  let latin = 0

  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    // CJK Unified Ideographs, Hangul, Kana, CJK Extensions, fullwidth forms
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext-A
      (cp >= 0x20000 && cp <= 0x2a6df) || // CJK Ext-B
      (cp >= 0xac00 && cp <= 0xd7af) || // Hangul
      (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
      (cp >= 0xff01 && cp <= 0xff60) || // Fullwidth
      (cp >= 0x1f300 && cp <= 0x1f9ff) // Emoji / pictographs
    ) {
      cjk++
    } else {
      latin++
    }
  }

  // CJK: ~1.5 chars/token, Latin/other: ~4 chars/token
  return Math.max(1, Math.ceil(cjk / 1.5 + latin / 4))
}
