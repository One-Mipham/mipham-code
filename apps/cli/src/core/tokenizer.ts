import type { Tiktoken } from 'js-tiktoken'
import type { Message } from '../shared/types'

let encoder: Tiktoken | null = null
let initPromise: Promise<void> | null = null

async function getEncoder(): Promise<Tiktoken> {
  if (encoder) return encoder
  if (!initPromise) {
    initPromise = (async () => {
      const { getEncoding } = await import('js-tiktoken')
      encoder = getEncoding('cl100k_base')
    })()
  }
  await initPromise
  return encoder!
}

export class TokenCounter {
  private cache = new Map<string, number>()
  private initialized = false

  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await getEncoder()
      this.initialized = true
    }
  }

  async count(text: string): Promise<number> {
    if (!text) return 0
    const cached = this.cache.get(text)
    if (cached !== undefined) return cached
    await this.ensureInit()
    const tokens = encoder!.encode(text).length
    this.cache.set(text, tokens)
    return tokens
  }

  /** Synchronous fallback — chars/4 heuristic when WASM not loaded. */
  countSync(text: string): number {
    if (!text) return 0
    const cached = this.cache.get(text)
    if (cached !== undefined) return cached
    return Math.ceil(text.length / 4)
  }

  async countMessages(messages: Message[]): Promise<number> {
    let total = 0
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        total += await this.count(msg.content)
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text' && block.text) {
            total += await this.count(block.text)
          }
        }
      }
      total += 4 // per-message format overhead
    }
    return total
  }

  async truncateToTokens(text: string, maxTokens: number): Promise<string> {
    await this.ensureInit()
    const tokens = encoder!.encode(text)
    if (tokens.length <= maxTokens) return text
    return text.slice(0, Math.floor(text.length * (maxTokens / tokens.length)))
  }

  invalidateCache(): void {
    this.cache.clear()
  }

  static reset(): void {
    encoder = null
    initPromise = null
  }
}
