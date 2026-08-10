import type {
  ToolDefinition,
  PermissionMode,
  PermissionLevel,
  PermissionRule,
  PermissionRestrictions,
} from '../shared/index.ts'
import type { PermissionRuleEntry } from '../shared/index.ts'
import { matchBashRule, compileRule } from './permission-rules'
import { loadPermissionConfig, nextMode, clampMode, MODE_CYCLE } from './permission-config'

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

  // ── Permission cache (P2) ──
  /** Short-lived cache: toolName+input → permissionLevel. Invalidated on rule/mode change. */
  private checkCache = new Map<string, PermissionLevel>()
  private cacheMode: PermissionMode | null = null

  // ── Org-level restrictions (P0 security) ──
  private restrictions: PermissionRestrictions | undefined = undefined

  // ── P0-5: Sub-agent mode (auto mode hardening for background tasks) ──
  private isSubAgent = false

  // ── P1-4: Consecutive block counter (prevents infinite retry loops) ──
  private consecutiveBlockCount = 0
  private static readonly MAX_CONSECUTIVE_BLOCKS = 3

  /** Invalidate the permission cache (called on any rule/mode change). */
  private invalidateCache(): void {
    this.checkCache.clear()
    this.cacheMode = null
  }

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
    this.mode = clampMode(mode, this.restrictions)
    this.invalidateCache()
  }

  getMode(): PermissionMode {
    return this.mode
  }

  cycleMode(): PermissionMode {
    this.mode = nextMode(this.mode, this.restrictions)
    return this.mode
  }

  // ── Restrictions (P0: org-level policy gap) ──

  /** Apply org-level permission restrictions. Overwrites any previous restrictions. */
  setRestrictions(restrictions: PermissionRestrictions | undefined): void {
    this.restrictions = restrictions
    // Re-clamp current mode against new restrictions
    if (restrictions) {
      this.mode = clampMode(this.mode, restrictions)
    }
    this.invalidateCache()
  }

  getRestrictions(): PermissionRestrictions | undefined {
    return this.restrictions
  }

  /**
   * P0-5 (v2.1.222 alignment): Enable sub-agent safety mode.
   * When true, auto mode returns 'ask' for Bash/Write/Edit tools instead of
   * 'bypass', ensuring PreToolUse hooks remain the safety gate in background agents.
   */
  setSubAgentMode(enabled: boolean): void {
    this.isSubAgent = enabled
    this.invalidateCache()
  }

  /**
   * P1-4 (v2.1.225 alignment): Increment the consecutive block counter
   * when a tool is denied. Safety-filter refusals should NOT count.
   * Returns true if the consecutive block limit has been exceeded.
   */
  incrementBlockCounter(): boolean {
    this.consecutiveBlockCount++
    return this.consecutiveBlockCount >= PermissionSystem.MAX_CONSECUTIVE_BLOCKS
  }

  /** Reset the block counter when a tool is successfully executed. */
  resetBlockCounter(): void {
    this.consecutiveBlockCount = 0
  }

  /** Get the current consecutive block count. */
  getBlockCount(): number {
    return this.consecutiveBlockCount
  }

  /**
   * P0-3 (v2.1.223 alignment): Create a permission context for a sub-agent.
   *
   * The sub-agent's requested permissionMode is clamped against the parent's
   * org restrictions (maxAllowedMode, forbiddenModes). Deny rules from the
   * parent are propagated so org safety policies always apply.
   *
   * Returns a new PermissionSystem instance — NOT shared with the parent.
   */
  createSubAgentPermission(agentPermissionMode: string): PermissionSystem {
    const resolvedMode = this.resolveAgentMode(agentPermissionMode)
    const subPerm = new PermissionSystem(resolvedMode)

    // Propagate org restrictions to sub-agent
    if (this.restrictions) {
      subPerm.setRestrictions(this.restrictions)
    }

    // Propagate deny rules (org safety policies must always apply)
    for (const denyEntry of this.denyRules) {
      subPerm.deny(denyEntry.pattern)
    }

    return subPerm
  }

  /**
   * Resolve an agent's permissionMode string to a clamped PermissionMode.
   * 'inherit' means "use the parent's current mode".
   * 'bypass' is treated as an alias for 'bypassPermissions'.
   */
  private resolveAgentMode(agentMode: string): PermissionMode {
    // Normalize aliases
    const normalized =
      agentMode === 'bypass' ? 'bypassPermissions' : agentMode

    const modeMap: Record<string, PermissionMode> = {
      bypassPermissions: 'bypassPermissions',
      dontAsk: 'dontAsk',
      auto: 'auto',
      plan: 'plan',
      acceptEdits: 'acceptEdits',
      default: 'default',
      inherit: this.mode,
    }

    const desired: PermissionMode = modeMap[normalized] || 'default'
    return clampMode(desired, this.restrictions)
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

  loadConfig(raw: {
    mode?: string
    allow?: string[]
    deny?: string[]
    restrictions?: PermissionRestrictions
  }): void {
    const config = loadPermissionConfig(
      raw as Partial<{
        mode: PermissionMode
        allow: string[]
        deny: string[]
        restrictions: PermissionRestrictions
      }>,
    )
    this.mode = clampMode(config.mode, config.restrictions ?? this.restrictions)

    this.allowRules = []
    this.denyRules = []
    this.askRules = []

    for (const rule of config.allow) {
      this.allowRules.push(compileRule(rule, 'allow'))
    }
    for (const rule of config.deny) {
      this.denyRules.push(compileRule(rule, 'deny'))
    }

    if (config.restrictions) {
      this.restrictions = config.restrictions
    }

    this.invalidateCache()
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
    // ── Guard: reject undefined/null tool (defense-in-depth) ──
    if (!tool) {
      return 'ask' // absent tool → safest default
    }

    // ── Cache lookup (P2): reuse decision for same tool+mode+input ──
    const cacheKey = tool.name + '|' + JSON.stringify(input, Object.keys(input).sort())
    if (this.cacheMode === this.mode) {
      const cached = this.checkCache.get(cacheKey)
      if (cached !== undefined) return cached
    } else {
      // Mode changed — invalidate entire cache
      this.checkCache.clear()
      this.cacheMode = this.mode
    }

    // 1. Check deny rules (always win)
    for (const rule of this.denyRules) {
      if (this.ruleMatches(rule, tool, input)) {
        const result: PermissionLevel = 'ask'
        this.checkCache.set(cacheKey, result)
        return result
      }
    }

    // 2. Check ask rules
    for (const rule of this.askRules) {
      if (this.ruleMatches(rule, tool, input)) {
        const result: PermissionLevel = 'ask'
        this.checkCache.set(cacheKey, result)
        return result
      }
    }

    // 3. Check allow rules
    for (const rule of this.allowRules) {
      if (this.ruleMatches(rule, tool, input)) {
        const result: PermissionLevel = 'bypass'
        this.checkCache.set(cacheKey, result)
        return result
      }
    }

    // 4. Legacy exact-name rules (backward compat)
    const legacyLevel = this.legacyRules.get(tool.name)
    if (legacyLevel !== undefined) {
      this.checkCache.set(cacheKey, legacyLevel)
      return legacyLevel
    }

    // 5. Mode baseline
    const baseline = this.modeBaseline(tool)
    if (baseline !== 'mode-baseline') {
      this.checkCache.set(cacheKey, baseline)
      return baseline
    }

    // 6. Tool's own permission level (backward compat fallback)
    if (tool.permission) {
      this.checkCache.set(cacheKey, tool.permission)
      return tool.permission
    }

    // 7. Legacy constructor fallback
    if (this.legacyDefaultFallback) {
      this.checkCache.set(cacheKey, this.legacyDefaultFallback)
      return this.legacyDefaultFallback
    }

    // 8. System default
    const result: PermissionLevel = 'ask'
    this.checkCache.set(cacheKey, result)
    return result
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
        // Safety checks handled by hook layer (PreToolUse hooks).
        // Bypass the static permission system so hooks are the sole gate.
        // Exception: SendMessage always goes through the permission classifier
        // so deny/allow rules are honored for cross-session messages.
        if (tool.name === 'SendMessage') {
          return 'mode-baseline'
        }
        // P0-5: In sub-agent context, enforce 'ask' for destructive tools
        // so hooks remain the sole safety gate. Without hooks, these tools
        // would otherwise run completely un-gated in auto mode.
        if (this.isSubAgent && ['Bash', 'Write', 'Edit'].includes(tool.name)) {
          return 'ask'
        }
        return 'bypass'

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
    let newMode: PermissionMode
    if (level === 'auto') newMode = 'auto'
    else if (level === 'bypass') newMode = 'bypassPermissions'
    else newMode = 'default'
    this.mode = clampMode(newMode, this.restrictions)
    this.invalidateCache()
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
    this.invalidateCache()
  }

  removeRule(toolName: string): void {
    this.legacyRules.delete(toolName)
    this.removeRuleFromArrays(toolName)
    this.invalidateCache()
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
