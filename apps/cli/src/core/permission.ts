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

/**
 * Check if a Bash command is a "verification-only" command that should be
 * auto-approved in acceptEdits mode. These are non-destructive read/check
 * operations that form the core of the vibe coding edit→test→fix loop.
 */
function isVerificationCommand(input: Record<string, unknown>): boolean {
  const cmd = (input.command as string) || ''
  // A verification command must be a single simple command — any shell
  // metacharacter (&&, ;, |, >, <, backtick, $) means it can chain a destructive
  // action (e.g. `cat x && rm -rf ~`), so never auto-approve it.
  if (/[;&|><`$]/.test(cmd)) return false
  // Patterns for verification-only commands (no side effects on codebase)
  const verifyPatterns = [
    /\bpnpm\s+test\b/, // test runner
    /\bpnpm\s+t\b/, // shorthand test
    /\bpnpm\s+typecheck\b/, // type checking
    /\bpnpm\s+lint\b/, // linting
    /\bpnpm\s+format:check\b/, // format check
    /\bnpm\s+test\b/, // npm test
    /\bnpm\s+run\s+test\b/, // npm run test
    /\bvitest\b/, // vitest runner
    /\bjest\b/, // jest runner
    /\btsc\s+(?!init)/, // TypeScript compiler (not tsc init)
    /\btsc\s+--noEmit\b/, // type check only
    /\beslint\b/, // eslint
    /\bprettier\s+--check\b/, // prettier check
    /\bpytest\b/, // python test runner
    /\bruff\s+check\b/, // python linter
    /\bcargo\s+test\b/, // rust test
    /\bcargo\s+check\b/, // rust check
    /\bgo\s+test\b/, // go test
    /\bgo\s+vet\b/, // go vet
    /\bmake\s+test\b/, // make test
    /\bgit\s+status\b/, // git status (read-only)
    /\bgit\s+diff\b/, // git diff (read-only)
    /\bgit\s+log\b/, // git log (read-only)
    /\bgit\s+branch\b/, // git branch (read-only)
    /\bls\b/, // list files
    /\bcat\b/, // read file
    /\bhead\b/, // read file start
    /\btail\b/, // read file end
    /\bwhich\b/, // find binary
    /\becho\b/, // print text
    /\bnode\s+-v\b/, // node version
    /\bpython\s+--version\b/, // python version
    /\bwhoami\b/, // current user
    /\bpwd\b/, // current directory
  ]
  return verifyPatterns.some((p) => p.test(cmd))
}

const VALID_MODES: Set<string> = new Set<string>(MODE_CYCLE)

/**
 * Why a tool resolved to 'ask' — for rich denial errors (#52).
 * Mirrors the resolution chain order in `check()` (first match wins).
 */
export type PermissionDenialReason =
  | 'deny-rule' // org deny rule — overrides mode, cannot be switched away
  | 'ask-rule' // explicit ask rule — still requires approval under any mode
  | 'legacy-rule' // legacy exact-name rule (setRule)
  | 'mode-baseline' // mode-specific default (acceptEdits/plan) → ask
  | 'tool-default' // tool.permission === 'ask'
  | 'system-default' // no rule, no tool permission → fallback ask

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
    const normalized = agentMode === 'bypass' ? 'bypassPermissions' : agentMode

    const modeMap: Record<string, PermissionMode> = {
      bypassPermissions: 'bypassPermissions',
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
    const baseline = this.modeBaseline(tool, input)
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

  /**
   * Explain WHY a tool resolves to 'ask' (rich denial errors — #52).
   *
   * Only call after `check()` returns 'ask'; mirrors its resolution order
   * (deny → ask → legacy → mode → tool → system). Returns the matched
   * rule pattern when the denial came from a deny/ask rule.
   */
  explainDenial(
    tool: ToolDefinition,
    input: Record<string, unknown>,
  ): { reason: PermissionDenialReason; rulePattern?: string } {
    for (const rule of this.denyRules) {
      if (this.ruleMatches(rule, tool, input)) {
        return { reason: 'deny-rule', rulePattern: rule.pattern }
      }
    }
    for (const rule of this.askRules) {
      if (this.ruleMatches(rule, tool, input)) {
        return { reason: 'ask-rule', rulePattern: rule.pattern }
      }
    }
    if (this.legacyRules.has(tool.name)) {
      return { reason: 'legacy-rule' }
    }
    if (this.modeBaseline(tool, input) !== 'mode-baseline') {
      return { reason: 'mode-baseline' }
    }
    if (tool.permission) {
      return { reason: 'tool-default' }
    }
    return { reason: 'system-default' }
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

  private modeBaseline(
    tool: ToolDefinition,
    input?: Record<string, unknown>,
  ): PermissionLevel | 'mode-baseline' {
    switch (this.mode) {
      case 'default':
        // Delegate to tool.permission (backward compat)
        return 'mode-baseline'

      case 'acceptEdits':
        // Reads + file edits free; Bash auto-approved for verification commands
        if (tool.category === 'file' && tool.name !== 'Bash') {
          return 'bypass'
        }
        if (tool.name === 'Bash') {
          // Vibe coding fix: auto-approve verification commands
          // so the edit→test→fix loop isn't interrupted by permission prompts
          if (input && isVerificationCommand(input)) {
            return 'bypass'
          }
          return 'ask'
        }
        return 'ask'

      case 'plan':
        // Only reads, no writes or executes
        return tool.category === 'file' && ['Read', 'Grep', 'Glob'].includes(tool.name)
          ? 'bypass'
          : 'ask'

      case 'bypassPermissions':
        return 'bypass'

      default:
        return 'mode-baseline'
    }
  }

  // ── Legacy compatibility ──

  setDefaultLevel(level: PermissionLevel): void {
    // Map legacy 3-level (auto/ask/bypass) to new 4-level mode.
    // Legacy 'auto'/'ask' = "let each tool self-decide" → 'default'.
    // Legacy 'bypass' → 'bypassPermissions'.
    const newMode: PermissionMode = level === 'bypass' ? 'bypassPermissions' : 'default'
    this.mode = clampMode(newMode, this.restrictions)
    this.invalidateCache()
  }

  getDefaultLevel(): PermissionLevel {
    // Legacy constructor fallback takes priority
    if (this.legacyDefaultFallback) return this.legacyDefaultFallback
    if (this.mode === 'bypassPermissions') return 'bypass'
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

  /**
   * Report any rule whose pattern is structurally invalid and can therefore
   * never match (e.g. `Bash(ls) x`, `Read(foo`, `Bash()`). These are silently
   * dead today — callers should surface them as invalid settings rather than
   * let a deny rule fail closed without the user noticing.
   */
  getInvalidRules(): string[] {
    const invalid: string[] = []
    for (const entry of [...this.allowRules, ...this.denyRules, ...this.askRules]) {
      if (entry.invalid) {
        invalid.push(
          `permission rule "${entry.pattern}" is invalid (${entry.invalid}) and will never match`,
        )
      }
    }
    return invalid
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
