import type {
  HookDefinition,
  HookEvent,
  HookContext,
  HookResult,
  ToolResult,
  HookConfig,
} from '../shared/index.ts'

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

  /** Stop hook: fires when AI completes a turn. Can block to force continuation. */
  async executeStop(sessionId: string): Promise<HookResult> {
    const ctx: HookContext = { event: 'Stop', sessionId }
    return this.runHooks('Stop', undefined, ctx)
  }

  /** UserPromptSubmit: fires when user submits input. Can block malicious input. */
  async executeUserPromptSubmit(prompt: string, sessionId: string): Promise<HookResult> {
    const ctx: HookContext = { event: 'UserPromptSubmit', sessionId, userPrompt: prompt }
    return this.runHooks('UserPromptSubmit', undefined, ctx)
  }

  /** PreCompact: fires before context compaction. */
  async executePreCompact(sessionId: string): Promise<HookResult> {
    const ctx: HookContext = { event: 'PreCompact', sessionId }
    return this.runHooks('PreCompact', undefined, ctx)
  }

  /** PostCompact: fires after context compaction. Can inject additional context. */
  async executePostCompact(sessionId: string): Promise<HookResult> {
    const ctx: HookContext = { event: 'PostCompact', sessionId }
    return this.runHooks('PostCompact', undefined, ctx)
  }

  /** ConfigChange: fires when configuration changes. */
  async executeConfigChange(key: string, value: unknown, sessionId: string): Promise<HookResult> {
    const ctx: HookContext = { event: 'ConfigChange', sessionId, configKey: key, configValue: value }
    return this.runHooks('ConfigChange', undefined, ctx)
  }

  // ── Core execution ──

  private async runHooks(
    event: HookEvent,
    toolName: string | undefined,
    ctx: HookContext,
  ): Promise<HookResult> {
    const matching = this.hooks.filter(
      (h) => h.event === event && (!toolName || !h.toolName || h.toolName === toolName),
    )

    const result: HookResult = { allowed: true }

    for (const hook of matching) {
      try {
        const hookResult = await hook.handler(ctx)

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
        // Hook failures do not block execution
      }
    }

    return result
  }

  listHooks(): HookDefinition[] {
    return [...this.hooks]
  }
}
