import type { ToolDefinition, ToolPermission, PermissionLevel } from './shared/index.ts'

export class PermissionSystem {
  private rules = new Map<string, PermissionLevel>()

  constructor(private defaultLevel: ToolPermission = 'auto') {}

  setRule(toolName: string, level: PermissionLevel): void {
    this.rules.set(toolName, level)
  }

  removeRule(toolName: string): void {
    this.rules.delete(toolName)
  }

  check(tool: ToolDefinition, _input: Record<string, unknown>): PermissionLevel {
    const ruleLevel = this.rules.get(tool.name)
    if (ruleLevel) return ruleLevel
    return tool.permission
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
