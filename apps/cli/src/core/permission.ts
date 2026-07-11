import type {
  ToolDefinition,
  PermissionMode,
  PermissionLevel,
  PermissionRule,
} from '../shared/index.ts'
import type { PermissionRuleEntry } from '../shared/index.ts'
import { matchBashRule, compileRule } from './permission-rules'
import { loadPermissionConfig, nextMode, MODE_CYCLE } from './permission-config'

const VALID_MODES: Set<string> = new Set<string>(MODE_CYCLE)

export class PermissionSystem {
  private allowRules: PermissionRuleEntry[] = []
  private denyRules: PermissionRuleEntry[] = []
  private askRules: PermissionRuleEntry[] = []
  /** Legacy exact-name rules for backward compat (set via setRule with 'auto' level). */
  private legacyRules = new Map<string, PermissionLevel>()
  /** Legacy default level from constructor when passed non-mode values like 'ask' or 'bypass'. */
  private legacyDefaultFallback: PermissionLevel | null = null
  private mode: PermissionMode = 'default'

  constructor(modeOrLevel: PermissionLevel = 'default') {
    if (VALID_MODES.has(modeOrLevel)) {
      this.mode = modeOrLevel as PermissionMode
    } else {
      // Legacy values ('ask', 'bypass') → store as fallback, use 'default' mode
      this.mode = 'default'
      this.legacyDefaultFallback = modeOrLevel
    }
  }

  // ── Mode management ──

  setMode(mode: PermissionMode): void {
    this.mode = mode
  }

  getMode(): PermissionMode {
    return this.mode
  }

  cycleMode(): PermissionMode {
    this.mode = nextMode(this.mode)
    return this.mode
  }

  // ── Rule management ──

  allow(rule: string): void {
    this.allowRules.push(compileRule(rule, 'allow'))
  }

  deny(rule: string): void {
    this.denyRules.push(compileRule(rule, 'deny'))
  }

  ask(rule: string): void {
    this.askRules.push(compileRule(rule, 'ask'))
  }

  loadConfig(raw: { mode?: string; allow?: string[]; deny?: string[] }): void {
    const config = loadPermissionConfig(
      raw as Partial<{ mode: PermissionMode; allow: string[]; deny: string[] }>,
    )
    this.mode = config.mode

    this.allowRules = []
    this.denyRules = []
    this.askRules = []

    for (const rule of config.allow) {
      this.allowRules.push(compileRule(rule, 'allow'))
    }
    for (const rule of config.deny) {
      this.denyRules.push(compileRule(rule, 'deny'))
    }
  }

  // ── Permission check ──

  /**
   * Resolution chain (first match wins):
   * 1. Deny rules → block
   * 2. Ask rules → require approval
   * 3. Allow rules → permit
   * 4. Legacy exact-name rules (backward compat — e.g. setRule('tool', 'auto'))
   * 5. Mode baseline → mode-specific default (overrides tool.permission for explicit modes)
   * 6. Tool's own permission → tool-specific default (backward compat)
   * 7. Legacy constructor fallback (when constructed with 'ask'/'bypass')
   * 8. System default → 'ask'
   */
  check(tool: ToolDefinition, input: Record<string, unknown>): PermissionLevel {
    // 1. Check deny rules (always win)
    for (const rule of this.denyRules) {
      if (this.ruleMatches(rule, tool, input)) return 'ask'
    }

    // 2. Check ask rules
    for (const rule of this.askRules) {
      if (this.ruleMatches(rule, tool, input)) return 'ask'
    }

    // 3. Check allow rules
    for (const rule of this.allowRules) {
      if (this.ruleMatches(rule, tool, input)) return 'bypass'
    }

    // 4. Legacy exact-name rules (backward compat)
    const legacyLevel = this.legacyRules.get(tool.name)
    if (legacyLevel !== undefined) return legacyLevel

    // 5. Mode baseline
    const baseline = this.modeBaseline(tool)
    if (baseline !== 'mode-baseline') return baseline

    // 6. Tool's own permission level (backward compat fallback)
    if (tool.permission) return tool.permission

    // 7. Legacy constructor fallback
    if (this.legacyDefaultFallback) return this.legacyDefaultFallback

    // 8. System default
    return 'ask'
  }

  needsApproval(tool: ToolDefinition, input: Record<string, unknown>): boolean {
    return this.check(tool, input) === 'ask'
  }

  isBypassed(tool: ToolDefinition, input: Record<string, unknown>): boolean {
    return this.check(tool, input) === 'bypass'
  }

  // ── Helpers ──

  private ruleMatches(
    rule: PermissionRuleEntry,
    tool: ToolDefinition,
    input: Record<string, unknown>,
  ): boolean {
    // Try Bash-style matching first
    if (rule.pattern.includes('(')) {
      return matchBashRule(rule.pattern, tool.name, input)
    }
    // Simple tool name match
    return rule.pattern === tool.name || rule.compiled.test(tool.name)
  }

  private modeBaseline(tool: ToolDefinition): PermissionLevel | 'mode-baseline' {
    switch (this.mode) {
      case 'default':
        // Delegate to tool.permission (backward compat)
        return 'mode-baseline'

      case 'acceptEdits':
        // Reads + file edits free; Bash requires approval
        return tool.category === 'file'
          ? ['Bash'].includes(tool.name)
            ? 'ask'
            : 'bypass'
          : tool.name === 'Bash'
            ? 'ask'
            : 'ask'

      case 'plan':
        // Only reads, no writes or executes
        return tool.category === 'file' && ['Read', 'Grep', 'Glob'].includes(tool.name)
          ? 'bypass'
          : 'ask'

      case 'auto':
        // Respect tool-level permissions; safety checks handled by hook layer
        return 'mode-baseline'

      case 'dontAsk':
        // Only allowlisted tools free (already handled above); everything else requires approval
        return 'ask'

      case 'bypassPermissions':
        return 'bypass'

      default:
        return 'mode-baseline'
    }
  }

  // ── Legacy compatibility ──

  setDefaultLevel(level: PermissionLevel): void {
    // Map legacy 3-level to new mode
    if (level === 'auto') this.mode = 'auto'
    else if (level === 'bypass') this.mode = 'bypassPermissions'
    else this.mode = 'default'
  }

  getDefaultLevel(): PermissionLevel {
    // Legacy constructor fallback takes priority
    if (this.legacyDefaultFallback) return this.legacyDefaultFallback
    if (this.mode === 'auto' || this.mode === 'bypassPermissions' || this.mode === 'dontAsk')
      return 'bypass'
    if (this.mode === 'plan') return 'ask'
    return 'auto'
  }

  setRule(toolNameOrRule: string | PermissionRule, level?: PermissionLevel): void {
    if (typeof toolNameOrRule === 'string') {
      const toolName = toolNameOrRule
      // Remove old entries for this tool
      this.removeRuleFromArrays(toolName)
      if (level !== undefined) {
        this.legacyRules.set(toolName, level)
        // Also sync to new-style arrays for listRules / new API consistency
        if (level === 'bypass') this.allow(toolName)
        else if (level === 'ask') this.ask(toolName)
        // 'auto' is stored only in legacyRules (returns 'auto', not 'bypass')
      }
    } else {
      const rule = toolNameOrRule
      if (rule.pattern) {
        const entry = compileRule(rule.pattern, rule.level === 'bypass' ? 'allow' : 'ask')
        if (rule.level === 'bypass') this.allowRules.push(entry)
        else this.askRules.push(entry)
      } else {
        this.removeRuleFromArrays(rule.toolName)
        this.legacyRules.set(rule.toolName, rule.level)
        if (rule.level === 'bypass') this.allow(rule.toolName)
        else if (rule.level === 'ask') this.ask(rule.toolName)
      }
    }
  }

  removeRule(toolName: string): void {
    this.legacyRules.delete(toolName)
    this.removeRuleFromArrays(toolName)
  }

  private removeRuleFromArrays(toolName: string): void {
    this.allowRules = this.allowRules.filter((r) => r.pattern !== toolName)
    this.denyRules = this.denyRules.filter((r) => r.pattern !== toolName)
    this.askRules = this.askRules.filter((r) => r.pattern !== toolName)
  }

  listRules(): Map<string, PermissionLevel> {
    const map = new Map<string, PermissionLevel>(this.legacyRules)
    for (const r of this.allowRules) {
      if (!map.has(r.pattern)) map.set(r.pattern, 'bypass')
    }
    for (const r of this.denyRules) {
      if (!map.has(r.pattern)) map.set(r.pattern, 'ask')
    }
    for (const r of this.askRules) {
      if (!map.has(r.pattern)) map.set(r.pattern, 'ask')
    }
    return map
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
