import type { ToolDefinition, ToolPermission, PermissionLevel, PermissionRule } from '../shared/index.ts'

export class PermissionSystem {
  private rules = new Map<string, PermissionLevel>()
  private patternRules: Array<{ pattern: RegExp; level: PermissionLevel }> = []

  constructor(private defaultLevel: ToolPermission = 'auto') {}

  setDefaultLevel(level: PermissionLevel): void {
    this.defaultLevel = level
  }

  getDefaultLevel(): PermissionLevel {
    return this.defaultLevel
  }

  setRule(toolNameOrRule: string | PermissionRule, level?: PermissionLevel): void {
    if (typeof toolNameOrRule === 'string') {
      if (level) this.rules.set(toolNameOrRule, level)
    } else {
      const rule = toolNameOrRule
      if (rule.pattern) {
        this.patternRules.push({ pattern: new RegExp(rule.pattern), level: rule.level })
      } else {
        this.rules.set(rule.toolName, rule.level)
      }
    }
  }

  removeRule(toolName: string): void {
    this.rules.delete(toolName)
  }

  /**
   * Resolve permission level for a tool call.
   *
   * Fallback chain: exact rule → pattern rule → tool permission → system default
   */
  check(tool: ToolDefinition, input: Record<string, unknown>): PermissionLevel {
    // 1. Exact-name rule wins
    const ruleLevel = this.rules.get(tool.name)
    if (ruleLevel) return ruleLevel

    // 2. Pattern-based rules (e.g. "file_*" → bypass)
    for (const { pattern, level } of this.patternRules) {
      if (pattern.test(tool.name)) return level
    }

    // 3. Tool's own permission level
    if (tool.permission) return tool.permission

    // 4. System default
    return this.defaultLevel
  }

  needsApproval(tool: ToolDefinition, input: Record<string, unknown>): boolean {
    return this.check(tool, input) === 'ask'
  }

  isBypassed(tool: ToolDefinition, input: Record<string, unknown>): boolean {
    return this.check(tool, input) === 'bypass'
  }

  listRules(): Map<string, PermissionLevel> {
    return new Map(this.rules)
  }

  getByCategory(
    tools: Map<string, ToolDefinition>,
    category: string,
  ): Array<{ name: string; level: PermissionLevel }> {
    const result: Array<{ name: string; level: PermissionLevel }> = []
    for (const [name, tool] of tools) {
      if (tool.category === category) {
        result.push({ name, level: this.check(tool, {}) })
      }
    }
    return result
  }
}
