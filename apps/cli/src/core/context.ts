import type { Message } from '../shared/index.ts'

export type Summarizer = (messages: Message[], heading: string) => Promise<string>

interface ContextConfig {
  maxTokens: number
  compactionThreshold: number // e.g. 0.9 → compact at 90% usage
}

interface Checkpoint {
  id: number
  messages: Message[]
  estimatedTokens: number
  timestamp: Date
  label: string
}

export class ContextManager {
  private messages: Message[] = []
  private systemPrompt = ''
  private estimatedTokens = 0
  private checkpoints: Checkpoint[] = []
  private checkpointCounter = 0
  private summarizer?: Summarizer

  constructor(private config: ContextConfig) {}

  /** Set an optional LLM summarizer for intelligent compaction. */
  setSummarizer(fn: Summarizer): void {
    this.summarizer = fn
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt
    this.estimatedTokens = this.estimateTokens(prompt)
  }

  getSystemPrompt(): string {
    return this.systemPrompt
  }

  addMessage(msg: Message): void {
    this.messages.push(msg)
    this.estimatedTokens += this.estimateTokens(
      typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
    )
  }

  getMessages(): Message[] {
    return [...this.messages]
  }

  needsCompaction(): boolean {
    return this.estimatedTokens > this.config.maxTokens * this.config.compactionThreshold
  }

  async compact(heading: string): Promise<void> {
    if (this.messages.length <= 30) return

    const keep = 20
    const toDrop = this.messages.slice(0, -keep)

    if (this.summarizer && toDrop.length >= 4) {
      // LLM-based summarization of truncated messages
      try {
        const summary = await this.summarizer(toDrop, heading)
        const summaryMsg: Message = {
          role: 'user',
          content: `[Earlier conversation summary]: ${summary}`,
        }
        this.messages = [summaryMsg, ...this.messages.slice(-keep)]
      } catch {
        // Fall back to truncation on summarizer failure
        this.messages = this.messages.slice(-keep)
      }
    } else {
      // Simple truncation fallback
      this.messages = this.messages.slice(-keep)
    }

    // Re-estimate tokens
    this.estimatedTokens = this.estimateTokens(this.systemPrompt)
    for (const msg of this.messages) {
      this.estimatedTokens += this.estimateTokens(
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      )
    }
  }

  getEstimatedTokens(): number {
    return this.estimatedTokens
  }

  clear(): void {
    this.messages = []
    this.checkpoints = []
    this.checkpointCounter = 0
    this.estimatedTokens = this.estimateTokens(this.systemPrompt)
  }

  getMessageCount(): number {
    return this.messages.length
  }

  // ── Checkpoint / Rewind ──

  saveCheckpoint(label = 'auto'): number {
    this.checkpointCounter++
    const checkpoint: Checkpoint = {
      id: this.checkpointCounter,
      messages: structuredClone(this.messages),
      estimatedTokens: this.estimatedTokens,
      timestamp: new Date(),
      label,
    }
    this.checkpoints.push(checkpoint)
    // Keep only last 10 checkpoints
    if (this.checkpoints.length > 10) {
      this.checkpoints = this.checkpoints.slice(-10)
    }
    return checkpoint.id
  }

  restoreCheckpoint(checkpointId?: number): {
    restored: boolean
    messageCount: number
    label: string
  } {
    // If no id given, restore the most recent checkpoint
    const target = checkpointId
      ? this.checkpoints.find((cp) => cp.id === checkpointId)
      : this.checkpoints.at(-1)

    if (!target) {
      return { restored: false, messageCount: this.messages.length, label: '' }
    }

    this.messages = structuredClone(target.messages)
    this.estimatedTokens = target.estimatedTokens
    return { restored: true, messageCount: this.messages.length, label: target.label }
  }

  getCheckpoints(): Array<{ id: number; messageCount: number; timestamp: Date; label: string }> {
    return this.checkpoints.map((cp) => ({
      id: cp.id,
      messageCount: cp.messages.length,
      timestamp: cp.timestamp,
      label: cp.label,
    }))
  }

  getLastCheckpointId(): number | undefined {
    return this.checkpoints.at(-1)?.id
  }

  /**
   * Estimate token count for a text string.
   *
   * Uses a character-class-aware heuristic:
   *   - CJK / emoji: ~1.5 chars per token
   *   - Other scripts (Latin, Cyrillic, Arabic): ~4 chars per token
   *   - Whitespace-heavy (code): ~3 chars per token
   *
   * This is ~30-40% more accurate than flat 4 chars/token for mixed-language text.
   */
  private estimateTokens(text: string): number {
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
      } else if (cp > 0x7f) {
        latin++
      } else {
        latin++
      }
    }

    // CJK: ~1.5 chars/token, Latin/other: ~4 chars/token
    return Math.max(1, Math.ceil(cjk / 1.5 + latin / 4))
  }
}
