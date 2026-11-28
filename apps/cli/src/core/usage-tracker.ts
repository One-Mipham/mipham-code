/**
 * UsageTracker — per-session token usage tracking with per-tool attribution.
 *
 * Tracks actual API-reported token counts (when available) and falls back
 * to character-estimated counts. Token costs are attributed to the tool
 * invoked in each turn — MCP tools (prefixed `mcp__`) get correct
 * per-invocation attribution, not inflated cumulative costs.
 */

export interface ToolUsage {
  /** Total input tokens attributed to this tool. */
  inputTokens: number
  /** Total output tokens attributed to this tool. */
  outputTokens: number
  /** Number of times this tool was invoked. */
  calls: number
}

export interface UsageSummary {
  /** Uncached input tokens from API (0 if API data unavailable). */
  apiInputTokens: number
  /** Total output tokens from API (0 if API data unavailable). */
  apiOutputTokens: number
  /** Input tokens served from the provider's prompt cache (billed separately). */
  apiCacheReadTokens: number
  /** Input tokens written into the provider's prompt cache (billed separately). */
  apiCacheWriteTokens: number
  /** Estimated total tokens (chars/4 heuristic, always available). */
  estimatedTokens: number
  /** Per-tool breakdown, keyed by tool name. "chat" = text-only turns. */
  tools: Record<string, ToolUsage>
}

export class UsageTracker {
  private _apiInputTokens = 0
  private _apiOutputTokens = 0
  private _apiCacheReadTokens = 0
  private _apiCacheWriteTokens = 0
  private _estimatedTokens = 0
  private _toolUsage = new Map<string, ToolUsage>()

  /**
   * Record API-reported token usage for a turn, attributed to the given tool.
   *
   * The four buckets are disjoint: `inputTokens` is uncached prompt input only
   * (providers normalize cached tokens out of it). Per-tool attribution stays
   * on uncached input + output.
   */
  recordApiUsage(inputTokens: number, outputTokens: number, toolName?: string): void {
    this._apiInputTokens += inputTokens
    this._apiOutputTokens += outputTokens
    this._recordTool(toolName || 'chat', inputTokens, outputTokens)
  }

  /**
   * Record API-reported prompt-cache tokens for a turn.
   *
   * Session-level by design: a cached prefix is shared context, so attributing
   * it to whichever tool happened to run in that turn would invent a cost that
   * tool did not cause.
   */
  recordCacheUsage(cacheReadTokens: number, cacheWriteTokens: number): void {
    this._apiCacheReadTokens += cacheReadTokens
    this._apiCacheWriteTokens += cacheWriteTokens
  }

  /** Record character-estimated token usage for a turn. */
  recordEstimatedUsage(tokenCount: number, toolName?: string): void {
    this._estimatedTokens += tokenCount
    this._recordToolEstimated(toolName || 'chat', tokenCount)
  }

  /** Get a summary of all usage for the current session. */
  getSummary(): UsageSummary {
    const tools: Record<string, ToolUsage> = {}
    for (const [name, usage] of this._toolUsage) {
      tools[name] = { ...usage }
    }
    return {
      apiInputTokens: this._apiInputTokens,
      apiOutputTokens: this._apiOutputTokens,
      apiCacheReadTokens: this._apiCacheReadTokens,
      apiCacheWriteTokens: this._apiCacheWriteTokens,
      estimatedTokens: this._estimatedTokens,
      tools,
    }
  }

  /** Reset all counters for a new session. */
  reset(): void {
    this._apiInputTokens = 0
    this._apiOutputTokens = 0
    this._apiCacheReadTokens = 0
    this._apiCacheWriteTokens = 0
    this._estimatedTokens = 0
    this._toolUsage.clear()
  }

  /** Total billed API tokens (uncached input + output + cache reads + cache writes). */
  get totalApiTokens(): number {
    return (
      this._apiInputTokens +
      this._apiOutputTokens +
      this._apiCacheReadTokens +
      this._apiCacheWriteTokens
    )
  }

  /** Whether any real API usage data has been recorded. */
  get hasApiData(): boolean {
    return this.totalApiTokens > 0
  }

  // ── Private helpers ──

  private _recordTool(name: string, inputTokens: number, outputTokens: number): void {
    const existing = this._toolUsage.get(name)
    if (existing) {
      existing.inputTokens += inputTokens
      existing.outputTokens += outputTokens
      existing.calls++
    } else {
      this._toolUsage.set(name, { inputTokens, outputTokens, calls: 1 })
    }
  }

  private _recordToolEstimated(name: string, tokenCount: number): void {
    const existing = this._toolUsage.get(name)
    if (existing) {
      existing.inputTokens += tokenCount
      existing.calls++
    } else {
      this._toolUsage.set(name, { inputTokens: tokenCount, outputTokens: 0, calls: 1 })
    }
  }
}
