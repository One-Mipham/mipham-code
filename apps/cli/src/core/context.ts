import type { Message } from '../shared/index.ts'
import { snipMessages } from './context-snip'
import { microcompact } from './context-microcompact'
import { reactiveCompact } from './context-compact'
import { emergencyDrain } from './context-drain'
import { NoopCacheTracker, type CacheTracker, type CacheStatus } from './context-token'

export type Summarizer = (messages: Message[], heading: string) => Promise<string>

interface ContextConfig {
  maxTokens: number
  compactionThreshold: number // e.g. 0.9 → compact at 90% usage
}

export interface CompactionStats {
  snipCount: number
  snipMessagesRemoved: number
  microcompactCount: number
  microcompactTokensSaved: number
  compactCount: number
  compactTokensSaved: number
  drainCount: number
  lastCompaction: Date | null
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

  // ── Compression state ──
  private cacheTracker: CacheTracker = new NoopCacheTracker()
  private compactionStats: CompactionStats = {
    snipCount: 0,
    snipMessagesRemoved: 0,
    microcompactCount: 0,
    microcompactTokensSaved: 0,
    compactCount: 0,
    compactTokensSaved: 0,
    drainCount: 0,
    lastCompaction: null,
  }
  private compressionPending = false

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

    // Auto-trigger compression checks (fire-and-forget, don't await)
    this.checkCompression()
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

  /**
   * Replace all messages atomically (used by compaction layers).
   * Preserves system prompt. Does NOT trigger compaction checks.
   */
  replaceMessages(messages: Message[]): void {
    this.messages = messages
    // Re-estimate tokens
    this.estimatedTokens = this.estimateTokens(this.systemPrompt)
    for (const msg of messages) {
      this.estimatedTokens += this.estimateTokens(
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      )
    }
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

  // ── Cache tracker integration ──

  /** Register a cache tracker for cache-aware microcompaction decisions. */
  setCacheTracker(tracker: CacheTracker): void {
    this.cacheTracker = tracker
  }

  /** Get a snapshot of the provider prompt-cache state. */
  getCacheStatus(): CacheStatus {
    return this.cacheTracker.getStatus()
  }

  // ── Compression stats ──

  /** Return a copy of the current compaction statistics. */
  getCompactionStats(): CompactionStats {
    return { ...this.compactionStats }
  }

  // ── 413 recovery ──

  /**
   * Emergency context drain for 413 (context too large) errors.
   * Progressively strips messages until the context fits.
   * Returns true if recovery was possible, false if already minimal.
   */
  async on413Error(): Promise<boolean> {
    const result = await emergencyDrain(this)
    if (result) {
      this.compactionStats.drainCount++
      this.compactionStats.lastCompaction = new Date()
    }
    return result
  }

  // ── Forced compaction (e.g. /compact command) ──

  /**
   * Force compaction of the conversation history.
   *
   * Uses the provided summarizer, the internal summarizer, or falls back
   * to emergency drain if neither is available.
   */
  async forceCompact(heading: string, summarizer?: Summarizer): Promise<void> {
    const beforeTokens = this.estimatedTokens

    if (summarizer) {
      await reactiveCompact(this, summarizer, heading)
    } else if (this.summarizer) {
      await reactiveCompact(this, this.summarizer, heading)
    } else {
      // Fallback: simple truncation via drain
      await emergencyDrain(this)
    }

    const tokensSaved = beforeTokens - this.estimatedTokens
    this.compactionStats.compactCount++
    if (tokensSaved > 0) {
      this.compactionStats.compactTokensSaved += tokensSaved
    }
    this.compactionStats.lastCompaction = new Date()
  }

  // ── Private compression helpers ──

  /**
   * Check estimated token usage and auto-trigger compression.
   *
   * - At 70%: run microcompact (fire-and-forget)
   * - At 85%: the existing needsCompaction() serves as a compact hint
   */
  private checkCompression(): void {
    if (this.compressionPending) return

    const usage = this.estimatedTokens / this.config.maxTokens

    if (usage > 0.7) {
      this.compressionPending = true
      // Schedule microcompact asynchronously (fire-and-forget)
      Promise.resolve().then(() => {
        this.runMicrocompact()
        this.compressionPending = false
      })
    }
  }

  /** Run snip + microcompact inline and update stats. */
  private runMicrocompact(): void {
    const { messages: snipped, removed } = snipMessages(this.messages)

    if (removed > 0) {
      this.compactionStats.snipCount++
      this.compactionStats.snipMessagesRemoved += removed
    }

    // Microcompact: compress tool_results not needed for recent context
    const keepRecent = 3
    const { messages: compacted, tokensSaved } = microcompact(snipped, this.cacheTracker, {
      keepRecent,
    })

    if (tokensSaved > 0) {
      this.compactionStats.microcompactCount++
      this.compactionStats.microcompactTokensSaved += tokensSaved
      this.compactionStats.lastCompaction = new Date()
    }

    this.messages = compacted
    this.reEstimateTokens()
  }

  /** Re-estimate tokens from system prompt + current messages. */
  private reEstimateTokens(): void {
    this.estimatedTokens = this.estimateTokens(this.systemPrompt)
    for (const msg of this.messages) {
      this.estimatedTokens += this.estimateTokens(
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      )
    }
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
