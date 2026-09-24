import type { Message, ToolResult } from '../shared/index.ts'
import { snipMessages } from './context-snip'
import { microcompact } from './context-microcompact'
import { NoopCacheTracker, type CacheTracker, type CacheStatus } from './context-token'
import {
  SessionLog,
  messageToEvents,
  deriveMessages,
  assertModelVisible,
  isAssertModelVisibleDebug,
} from './session-log'

export type Summarizer = (messages: Message[], heading: string) => Promise<string>

interface ContextConfig {
  maxTokens: number
  compactionThreshold: number // e.g. 0.9 → compact at 90% usage
  contextWindow?: number // model's declared context window (for adaptive thresholds)
}

export interface CompactionStats {
  snipCount: number
  snipMessagesRemoved: number
  microcompactCount: number
  microcompactTokensSaved: number
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
  /**
   * 系统提示里的**权限段**是读时派生的，不是组装时烘进 `systemPrompt` 的一份拷贝。
   *
   * 烘进去的那份拷贝会与执行分叉：Shift+Tab 之后闸门与页脚都变了，模型手里还是旧指令
   * —— 往窄切是自纠正的（模型比闸门更保守），**往宽切**则让模型拒绝做它已经被允许做的事。
   * `index.tsx` 把它接到 live `PermissionSystem.getMode()` 上，于是切一次档，下一次请求就变。
   */
  private permissionContextSource: (() => string) | null = null
  /**
   * 系统提示里的 **MCP instructions 段**同样是读时派生的，理由比权限段更硬：
   * MCP server 是**启动后异步连上**的，而提示在 `setSystemPrompt()` 那一刻就建好了。
   * 组装时烘进去的话，本次会话里后连上的 server 永远进不了提示 —— 用户只能重启。
   */
  private mcpInstructionsSource: (() => string) | null = null
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
    lastCompaction: null,
  }
  private compressionPending = false

  constructor(private config: ContextConfig) {
    this.calculateThresholds()
  }

  private log?: SessionLog

  /** 附加一个 append-only 会话日志；addMessage/seedMessages 将写通镜像到日志。 */
  setLog(log?: SessionLog): void {
    this.log = log
  }

  getLog(): SessionLog | undefined {
    return this.log
  }

  /** 从已持久化的日志恢复：设 log 为源，messages 为投影（不重复写通）。 */
  restoreLog(log: SessionLog): void {
    this.log = log
    this.messages = deriveMessages(log.events())
    this.reEstimateTokens()
  }

  /**
   * Calculate adaptive compaction thresholds based on the model's context window.
   *
   * compaction:  200K→0.75(→clamped 0.90), 500K→0.90, 1M→0.95
   * microcompact: 200K→0.70(→clamped 0.70), 500K→0.80, 1M→0.85
   */
  calculateThresholds(): void {
    const w = this.config.contextWindow
    if (!w) return

    // compaction: window越大越晚compact，floor at 0.90
    this.config.compactionThreshold = Math.max(0.9, 1 - 50000 / w)

    // microcompact threshold is computed inline in checkCompression()
    // using this.config.contextWindow directly
  }

  getCompactionThreshold(): number {
    return this.config.compactionThreshold
  }

  /** Dynamically update the max token limit (e.g., when switching models). */
  updateMaxTokens(maxTokens: number, contextWindow?: number): void {
    this.config.maxTokens = maxTokens
    if (contextWindow) {
      this.config.contextWindow = contextWindow
    }
    this.calculateThresholds()
  }

  getMaxTokens(): number {
    return this.config.maxTokens
  }

  /** Set an optional LLM summarizer for intelligent compaction. */
  setSummarizer(fn: Summarizer): void {
    this.summarizer = fn
  }

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt
    this.estimatedTokens = this.estimateTokens(this.composedSystemPrompt())
  }

  /**
   * 接线点（`index.tsx`）：把权限段接到 live `PermissionSystem.getMode()` 上。
   *
   * 传 `null` 撤销。**不接**时系统提示里没有权限段（这里是唯一的施加点，故
   * `test/integrity/permission-status-parity.test.ts` 从源码侧断这一行在场）。
   */
  setPermissionContextSource(fn: (() => string) | null): void {
    this.permissionContextSource = fn
  }

  /**
   * 接线点（`index.tsx`）：把已连 MCP server 自带的 `instructions` 接到提示上。
   *
   * 传 `null` 撤销。空串（无 server / 都没写 instructions）不产生空段。
   */
  setMcpInstructionsSource(fn: (() => string) | null): void {
    this.mcpInstructionsSource = fn
  }

  /**
   * 存储的提示 + 读时派生的段（权限 / MCP instructions）。
   *
   * 段尾追加（而非插回原来的中段位置）是刻意的：只切档、只连一个新 server 时
   * **前缀保持不变**，提供方的 prefix cache 仍能命中到这些段之前的部分。
   */
  private composedSystemPrompt(): string {
    const blocks = [
      this.permissionContextSource?.() ?? '',
      this.mcpInstructionsSource?.() ?? '',
    ].filter((b) => b !== '')
    return blocks.length > 0
      ? [this.systemPrompt, ...blocks].join('\n\n---\n\n')
      : this.systemPrompt
  }

  getSystemPrompt(): string {
    return this.composedSystemPrompt()
  }

  addMessage(msg: Message): void {
    this.messages.push(msg)
    this.estimatedTokens += this.estimateTokens(
      typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
    )

    if (this.log) {
      for (const e of messageToEvents(msg, Date.now())) this.log.append(e)
    }

    if (this.log && isAssertModelVisibleDebug()) {
      assertModelVisible(this.log.events(), this.messages)
    }

    // Auto-trigger compression checks (fire-and-forget, don't await)
    this.checkCompression()
  }

  /**
   * 注入一段**模型可见的上下文**（规则块 / compact 前后的 hook 提示 / stop hook 交回的话 /
   * 后台 agent 的来件）。
   *
   * 为什么不复用 addMessage：那会把注入记成 `user/message`，在日志里与**用户真说过的话**
   * 完全同形 —— 事后翻 session log 分不出哪一句是用户敲的、哪一句是我们塞进去的。记成
   * `context/inject`（带 `source`）就带得出来源；而 `deriveMessages` 仍把它还原成同一个
   * user 消息，所以**投影逐字节不变**，「model-visible means logged」照样成立。
   */
  injectContext(source: string, text: string): void {
    this.messages.push({ role: 'user', content: text })
    this.estimatedTokens += this.estimateTokens(text)

    if (this.log) {
      this.log.append({ type: 'context/inject', at: Date.now(), source, text })
    }

    if (this.log && isAssertModelVisibleDebug()) {
      assertModelVisible(this.log.events(), this.messages)
    }

    this.checkCompression()
  }

  /** 记录工具执行结果（全量 ToolResult 含 success/error）到日志，并写投影消息（不重复走 messageToEvents 拆分）。 */
  addToolResult(toolUseId: string, result: ToolResult): void {
    const content = result.success ? result.content : result.error || result.content
    const msg: Message = {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolUseId,
          content,
          // 成功不写该键 —— 与 session-log.deriveMessages 的展平式对称（保字节级互逆）
          ...(result.success ? {} : { is_error: true }),
        },
      ],
    }
    this.messages.push(msg)
    this.estimatedTokens += this.estimateTokens(JSON.stringify(msg.content))
    if (this.log) this.log.append({ type: 'tool/result', at: Date.now(), id: toolUseId, result })
    this.checkCompression()
  }

  /** 记录原始 assistant 流块（保 replay 保真）；不写入投影 messages。 */
  recordChunk(chunk: string): void {
    if (this.log) this.log.append({ type: 'assistant/chunk', at: Date.now(), chunk })
  }

  /**
   * Seed a batch of pre-existing messages (e.g., an inherited parent
   * conversation). Unlike addMessage, this does not trigger compaction so the
   * byte-identical prefix is preserved for prompt-cache hits.
   */
  seedMessages(messages: Message[]): void {
    if (messages.length === 0) return
    this.messages.push(...messages)
    if (this.log) {
      for (const m of messages) for (const e of messageToEvents(m, Date.now())) this.log.append(e)
    }
    this.reEstimateTokens()

    if (this.log && isAssertModelVisibleDebug()) {
      assertModelVisible(this.log.events(), this.messages)
    }
  }

  getMessages(): Message[] {
    return [...this.messages]
  }

  needsCompaction(): boolean {
    return this.estimatedTokens > this.config.maxTokens * this.config.compactionThreshold
  }

  async compact(heading: string): Promise<{ before: number; after: number }> {
    const beforeTokens = this.estimatedTokens

    if (this.messages.length <= 30) {
      return { before: beforeTokens, after: beforeTokens }
    }

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
        if (this.log) {
          const derivedCount = deriveMessages(this.log.events()).length
          const replacedCount = Math.max(0, derivedCount - keep)
          this.log.append({ type: 'compaction/summary', at: Date.now(), summary, replacedCount })
        }
      } catch {
        // Fall back to truncation on summarizer failure
        const kept = this.messages.slice(-keep)
        if (this.log) {
          this.log.append({ type: 'compaction/rewrite', at: Date.now(), messages: kept })
          this.messages = deriveMessages(this.log.events())
        } else {
          this.messages = kept
        }
      }
    } else {
      // Simple truncation fallback
      const kept = this.messages.slice(-keep)
      if (this.log) {
        this.log.append({ type: 'compaction/rewrite', at: Date.now(), messages: kept })
        this.messages = deriveMessages(this.log.events())
      } else {
        this.messages = kept
      }
    }

    // Re-estimate tokens
    this.estimatedTokens = this.estimateTokens(this.composedSystemPrompt())
    for (const msg of this.messages) {
      this.estimatedTokens += this.estimateTokens(
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
      )
    }

    return { before: beforeTokens, after: this.estimatedTokens }
  }

  getEstimatedTokens(): number {
    return this.estimatedTokens
  }

  clear(): void {
    this.messages = []
    this.checkpoints = []
    this.checkpointCounter = 0
    this.estimatedTokens = this.estimateTokens(this.composedSystemPrompt())
  }

  getMessageCount(): number {
    return this.messages.length
  }

  /**
   * Replace all messages atomically, bypassing the session log.
   * Kept as a drift seam for the session-log invariant tests (the
   * "model-visible means logged" assertion) — no production caller.
   * Preserves system prompt. Does NOT trigger compaction checks.
   */
  replaceMessages(messages: Message[]): void {
    this.messages = messages
    // Re-estimate tokens
    this.estimatedTokens = this.estimateTokens(this.composedSystemPrompt())
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

  /** Mark a set of messages as cached by the provider (called after a request). */
  markCached(messages: Message[]): void {
    this.cacheTracker.markCached?.(messages)
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

    // Adaptive microcompact threshold: 200K→0.70, 500K→0.80, 1M→0.85
    const microThreshold = this.config.contextWindow
      ? Math.max(0.7, 1 - 150000 / this.config.contextWindow)
      : 0.7

    if (usage > microThreshold) {
      this.compressionPending = true
      // Schedule microcompact asynchronously (fire-and-forget)
      void Promise.resolve().then(() => {
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

    // 仅当内容真变时写日志并重建投影（model-visible means logged 不变量）。
    // 用 deriveMessages(log) 而非直接赋值 compacted，避免与日志事件共享 messages 引用被 addMessage.push 污染。
    if (this.log && (removed > 0 || tokensSaved > 0)) {
      this.log.append({ type: 'compaction/rewrite', at: Date.now(), messages: compacted })
      this.messages = deriveMessages(this.log.events())
    } else {
      this.messages = compacted
    }
    this.reEstimateTokens()
  }

  /** Re-estimate tokens from system prompt + current messages. */
  private reEstimateTokens(): void {
    this.estimatedTokens = this.estimateTokens(this.composedSystemPrompt())
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
