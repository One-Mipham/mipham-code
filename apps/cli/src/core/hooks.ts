import type {
  HookDefinition,
  HookEvent,
  HookContext,
  HookResult,
  ToolResult,
} from '../shared/index.ts'

// ── Hook resilience types ──

interface HookHealth {
  /** Consecutive failure count */
  failures: number
  /** Timestamp of last failure (ms since epoch) */
  lastFailureTime: number
  /** Whether the hook is currently disabled due to repeated failures */
  disabled: boolean
  /** Timestamp when disabled (ms since epoch) */
  disabledAt: number
  /** Total failure count (lifetime) */
  totalFailures: number
}

/** Max consecutive failures before auto-disabling a hook */
const MAX_CONSECUTIVE_FAILURES = 5

/** Cooldown period in ms before a disabled hook is re-tried (5 minutes) */
const COOLDOWN_MS = 5 * 60 * 1000

// ── Helpers ──

/**
 * Merge two permission decisions, keeping the more restrictive one.
 * Priority: deny > defer > ask > allow
 */
export function mergePermissionDecision(
  current: HookResult['permissionDecision'],
  incoming: NonNullable<HookResult['permissionDecision']>,
): HookResult['permissionDecision'] {
  const priority: Record<string, number> = { deny: 3, defer: 2, ask: 1, allow: 0 }
  const currScore = current ? (priority[current] ?? 0) : -1
  const incScore = priority[incoming] ?? 0
  return incScore > currScore ? incoming : current
}

export class HookEngine {
  private hooks: HookDefinition[] = []
  /** Health tracking per hook key (event[:toolName]) */
  private health = new Map<string, HookHealth>()

  /**
   * The workspace this engine's hooks run *for*.
   *
   * Settled at construction because one engine belongs to one session, not to one
   * hook. The default is exactly right for the one-shot CLI, whose process cwd
   * *is* the session cwd — but the daemon serves many sessions from one process,
   * so it must pass the session's cwd. Left to the executor's own
   * `process.cwd()`, every daemon hook would run in — and be told it is in — the
   * directory the daemon happened to be started from.
   */
  constructor(private readonly cwd: string = process.cwd()) {}

  register(hook: HookDefinition): void {
    this.hooks.push(hook)
  }

  unregister(event: HookEvent, toolName?: string): void {
    this.hooks = this.hooks.filter(
      (h) => !(h.event === event && (!toolName || h.toolName === toolName)),
    )
  }

  // ── Existing event executors ──

  async executePreToolUse(
    toolName: string,
    toolInput: Record<string, unknown>,
    sessionId: string,
  ): Promise<HookResult> {
    const ctx: HookContext = { event: 'PreToolUse', toolName, toolInput, sessionId }
    return this.runHooks('PreToolUse', toolName, ctx)
  }

  async executePostToolUse(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResult: ToolResult,
    sessionId: string,
  ): Promise<HookResult> {
    const ctx: HookContext = { event: 'PostToolUse', toolName, toolInput, toolResult, sessionId }
    return this.runHooks('PostToolUse', toolName, ctx)
  }

  async executeSessionStart(sessionId: string): Promise<HookResult> {
    const ctx: HookContext = { event: 'SessionStart', sessionId }
    return this.runHooks('SessionStart', undefined, ctx)
  }

  async executeSessionEnd(sessionId: string): Promise<HookResult> {
    const ctx: HookContext = { event: 'SessionEnd', sessionId }
    return this.runHooks('SessionEnd', undefined, ctx)
  }

  async executeNotification(message: string, sessionId: string): Promise<HookResult> {
    const ctx: HookContext = { event: 'Notification', sessionId, toolInput: { message } }
    return this.runHooks('Notification', undefined, ctx)
  }

  // ── NEW event executors ──

  async executeStop(sessionId: string): Promise<HookResult> {
    const ctx: HookContext = { event: 'Stop', sessionId }
    const result = await this.runHooks('Stop', undefined, ctx)

    // A blocking Stop hook arrives as a deny (exit code 2, `decision: block`, or
    // `continue: false`), but the engine's Stop path reads `decision`. Derive it
    // here rather than at each producer so every form reaches "do not stop yet".
    return result.allowed ? result : { ...result, decision: 'block' }
  }

  async executeUserPromptSubmit(prompt: string, sessionId: string): Promise<HookResult> {
    const ctx: HookContext = { event: 'UserPromptSubmit', sessionId, userPrompt: prompt }
    return this.runHooks('UserPromptSubmit', undefined, ctx)
  }

  async executePreCompact(sessionId: string): Promise<HookResult> {
    const ctx: HookContext = { event: 'PreCompact', sessionId }
    return this.runHooks('PreCompact', undefined, ctx)
  }

  async executePostCompact(sessionId: string): Promise<HookResult> {
    const ctx: HookContext = { event: 'PostCompact', sessionId }
    return this.runHooks('PostCompact', undefined, ctx)
  }

  async executeConfigChange(key: string, value: unknown, sessionId: string): Promise<HookResult> {
    const ctx: HookContext = {
      event: 'ConfigChange',
      sessionId,
      configKey: key,
      configValue: value,
    }
    return this.runHooks('ConfigChange', undefined, ctx)
  }

  async executeSubagentStart(
    agentType: string,
    description: string,
    sessionId: string,
  ): Promise<HookResult> {
    const ctx: HookContext = {
      event: 'SubagentStart',
      sessionId,
      // The agent type plays the role a tool name plays for PreToolUse: it is
      // what a settings.json `matcher` selects on.
      toolName: agentType,
      toolInput: { agentType, description },
    }
    return this.runHooks('SubagentStart', agentType, ctx)
  }

  async executeSubagentStop(
    agentType: string,
    description: string,
    sessionId: string,
    success: boolean,
    result?: string,
  ): Promise<HookResult> {
    const ctx: HookContext = {
      event: 'SubagentStop',
      sessionId,
      // Matcher target — see executeSubagentStart.
      toolName: agentType,
      toolInput: { agentType, description, success },
      toolResult: result ? { success, content: result.slice(0, 2000) } : undefined,
    }
    return this.runHooks('SubagentStop', agentType, ctx)
  }

  async executePostToolUseFailure(
    toolName: string,
    toolInput: Record<string, unknown>,
    error: string,
    sessionId: string,
  ): Promise<HookResult> {
    const ctx: HookContext = {
      event: 'PostToolUseFailure',
      toolName,
      toolInput,
      toolResult: { success: false, content: '', error },
      sessionId,
    }
    return this.runHooks('PostToolUseFailure', toolName, ctx)
  }

  async executePreInference(
    messages: Array<{ role: string; content: string }>,
    toolCalls: Array<{
      name: string
      input: Record<string, unknown>
      resultPreview: string
    }>,
    sessionId: string,
    provider: string,
    model: string,
  ): Promise<HookResult> {
    const ctx: HookContext = {
      event: 'PreInference',
      sessionId,
      messages,
      toolCalls,
      provider,
      model,
    }
    return this.runHooks('PreInference', undefined, ctx)
  }

  // ── Health & Resilience ──

  /** Get a hook health key for tracking. */
  private healthKey(hook: HookDefinition): string {
    return hook.toolName ? `${hook.event}:${hook.toolName}` : hook.event
  }

  /** Check if a hook should be skipped due to repeated failures. */
  private shouldSkip(key: string): boolean {
    const h = this.health.get(key)
    if (!h) return false

    // If disabled, check cooldown
    if (h.disabled) {
      const elapsed = Date.now() - h.disabledAt
      if (elapsed < COOLDOWN_MS) {
        return true // still in cooldown
      }
      // Cooldown expired — re-enable for a trial
      h.disabled = false
      h.failures = 0
      process.stderr.write(`🔄 Hook "${key}" cooldown expired — re-enabled for trial.\n`)
      return false
    }

    return false
  }

  /** Record a hook success — resets failure counter. */
  private recordSuccess(key: string): void {
    const h = this.health.get(key)
    if (h) {
      h.failures = 0
      h.disabled = false
    }
  }

  /** Record a hook failure — may trigger auto-disable. */
  private recordFailure(key: string): void {
    let h = this.health.get(key)
    if (!h) {
      h = { failures: 0, lastFailureTime: 0, disabled: false, disabledAt: 0, totalFailures: 0 }
      this.health.set(key, h)
    }

    h.failures++
    h.totalFailures++
    h.lastFailureTime = Date.now()

    if (h.failures >= MAX_CONSECUTIVE_FAILURES && !h.disabled) {
      h.disabled = true
      h.disabledAt = Date.now()
      process.stderr.write(
        `⚠️  Hook "${key}" failed ${MAX_CONSECUTIVE_FAILURES} consecutive times — auto-disabled for ${COOLDOWN_MS / 60_000} minutes.\n` +
          `   Use /hooks enable "${key}" to re-enable manually.\n`,
      )
    }
  }

  /** Get the health status of all hooks. */
  getHookHealth(): Array<{ key: string; health: HookHealth }> {
    return Array.from(this.health.entries()).map(([key, health]) => ({ key, health }))
  }

  /** Manually re-enable a disabled hook. */
  reEnableHook(key: string): boolean {
    const h = this.health.get(key)
    if (!h || !h.disabled) return false
    h.disabled = false
    h.failures = 0
    return true
  }

  // ── Core execution ──

  /**
   * Does a hook's `matcher` select this invocation?
   *
   * No matcher means every invocation of the event. Otherwise the stored matcher
   * is a regex — `loadHookConfigs` compiles it as one — tested against the name
   * this event filters on: the tool name for tool events, the agent type for the
   * subagent events. Events that carry no such name (Stop, SessionStart, …) are
   * not filtered here.
   */
  private matchesMatcher(matcher: string | undefined, name: string | undefined): boolean {
    if (!matcher || !name) return true
    try {
      return new RegExp(matcher).test(name)
    } catch {
      // An uncompilable pattern cannot get this far through loadHookConfigs,
      // which compiles every matcher when it loads. Keep such a hook running
      // rather than dropping it silently.
      return true
    }
  }

  private async runHooks(
    event: HookEvent,
    toolName: string | undefined,
    ctx: HookContext,
  ): Promise<HookResult> {
    const matching = this.hooks.filter(
      (h) => h.event === event && this.matchesMatcher(h.toolName, toolName),
    )

    // Stamped here rather than at each `executeX`: the cwd is a property of the
    // engine, and every context this engine hands out needs it.
    ctx.cwd = this.cwd

    const result: HookResult = { allowed: true }

    for (const hook of matching) {
      const key = this.healthKey(hook)

      // ── Resilience: skip disabled hooks ──
      if (this.shouldSkip(key)) {
        result.additionalContext = result.additionalContext
          ? result.additionalContext +
            `\n[Hook "${key}" skipped — temporarily disabled after repeated failures]`
          : `[Hook "${key}" skipped — temporarily disabled after repeated failures]`
        continue
      }

      try {
        const hookResult = await hook.handler(ctx)

        // Record success
        this.recordSuccess(key)

        // Block on first deny — stops further hook execution
        if (!hookResult.allowed) {
          return { ...hookResult }
        }

        // Merge permission decisions (deny > defer > ask > allow)
        if (hookResult.permissionDecision) {
          result.permissionDecision = mergePermissionDecision(
            result.permissionDecision,
            hookResult.permissionDecision,
          )
        }

        // Stop hook: block decision takes precedence
        if (hookResult.decision === 'block') {
          result.decision = 'block'
          result.reason = hookResult.reason || result.reason
        }

        // Merge modified inputs
        if (hookResult.modifiedInput) {
          result.modifiedInput = {
            ...(result.modifiedInput || {}),
            ...hookResult.modifiedInput,
          }
        }

        // Collect additional context from multiple hooks
        if (hookResult.additionalContext) {
          result.additionalContext = result.additionalContext
            ? result.additionalContext + '\n' + hookResult.additionalContext
            : hookResult.additionalContext
        }

        // PostToolUse: replace output if provided
        if (hookResult.updatedOutput) {
          result.updatedOutput = hookResult.updatedOutput
        }
      } catch {
        // Record failure — may trigger auto-disable
        this.recordFailure(key)
        // Hook failures do not block execution
      }
    }

    return result
  }

  listHooks(): HookDefinition[] {
    return [...this.hooks]
  }
}
