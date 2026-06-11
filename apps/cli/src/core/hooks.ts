import type {
  HookDefinition,
  HookEvent,
  HookContext,
  HookResult,
  ToolResult,
} from '../shared/index.ts'

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

  async executePreToolUse(
    toolName: string,
    toolInput: Record<string, unknown>,
    sessionId: string,
  ): Promise<HookResult> {
    const ctx: HookContext = {
      event: 'PreToolUse',
      toolName,
      toolInput,
      sessionId,
    }

    return this.runHooks('PreToolUse', toolName, ctx)
  }

  async executePostToolUse(
    toolName: string,
    toolInput: Record<string, unknown>,
    toolResult: ToolResult,
    sessionId: string,
  ): Promise<HookResult> {
    const ctx: HookContext = {
      event: 'PostToolUse',
      toolName,
      toolInput,
      toolResult,
      sessionId,
    }

    return this.runHooks('PostToolUse', toolName, ctx)
  }

  async executeSessionStart(sessionId: string): Promise<HookResult> {
    const ctx: HookContext = {
      event: 'SessionStart',
      sessionId,
    }

    return this.runHooks('SessionStart', undefined, ctx)
  }

  async executeSessionEnd(sessionId: string): Promise<HookResult> {
    const ctx: HookContext = {
      event: 'SessionEnd',
      sessionId,
    }

    return this.runHooks('SessionEnd', undefined, ctx)
  }

  async executeNotification(message: string, sessionId: string): Promise<HookResult> {
    const ctx: HookContext = {
      event: 'Notification',
      sessionId,
      toolInput: { message },
    }

    return this.runHooks('Notification', undefined, ctx)
  }

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
        if (!hookResult.allowed) {
          return hookResult // Block on first deny
        }
        if (hookResult.modifiedInput) {
          result.modifiedInput = {
            ...(result.modifiedInput || {}),
            ...hookResult.modifiedInput,
          }
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
