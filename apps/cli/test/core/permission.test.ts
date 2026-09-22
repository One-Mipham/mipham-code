import { describe, it, expect } from 'vitest'
import type { PermissionMode, PermissionRestrictions, ToolDefinition } from '../../src/shared'
import { PermissionSystem } from '../../src/core/permission'
import { PERMISSION_MODE_HIERARCHY } from '../../src/core/permission-config'

// ── Helpers ──

function makeTool(
  name: string,
  permission: ToolDefinition['permission'] = 'self',
  category: ToolDefinition['category'] = 'file',
): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    category,
    permission,
    parameters: { type: 'object', properties: {} },
    execute: async () => ({ success: true, content: '' }),
  }
}

// ── Tests ──

describe('PermissionSystem', () => {
  // ═══════════════════════════════════════════
  // Default behavior
  // ═══════════════════════════════════════════

  it('should return tool default permission when no rule set', () => {
    const ps = new PermissionSystem()
    const tool = makeTool('read', 'self')

    expect(ps.check(tool, {})).toBe('self')
  })

  it('should respect defaultLevel in constructor', () => {
    const ps = new PermissionSystem('ask')
    const tool = makeTool('read', 'self')

    // Tool default is 'self', but no rules → returns tool default (not constructor default)
    expect(ps.check(tool, {})).toBe('self')
  })

  it('should return ask for tools with ask permission', () => {
    const ps = new PermissionSystem()
    const tool = makeTool('write', 'ask')

    expect(ps.check(tool, {})).toBe('ask')
  })

  it('should return bypass for tools with bypass permission', () => {
    const ps = new PermissionSystem()
    const tool = makeTool('bash', 'bypass')

    expect(ps.check(tool, {})).toBe('bypass')
  })

  // ═══════════════════════════════════════════
  // Rule overrides
  // ═══════════════════════════════════════════

  it('should override tool permission with explicit rule', () => {
    const ps = new PermissionSystem()
    const tool = makeTool('read', 'self')

    ps.setRule('read', 'ask')
    expect(ps.check(tool, {})).toBe('ask')
  })

  it('should allow rule to escalate from auto to ask', () => {
    const ps = new PermissionSystem()
    const tool = makeTool('read', 'self')

    ps.setRule('read', 'ask')
    expect(ps.check(tool, {})).toBe('ask')
  })

  it('should allow rule to downgrade from ask to auto', () => {
    const ps = new PermissionSystem()
    const tool = makeTool('write', 'ask')

    ps.setRule('write', 'self')
    expect(ps.check(tool, {})).toBe('self')
  })

  it('should remove rule and fall back to tool default', () => {
    const ps = new PermissionSystem()
    const tool = makeTool('read', 'self')

    ps.setRule('read', 'ask')
    ps.removeRule('read')
    expect(ps.check(tool, {})).toBe('self')
  })

  it('should handle removing non-existent rule gracefully', () => {
    const ps = new PermissionSystem()
    expect(() => ps.removeRule('nonexistent')).not.toThrow()
  })

  // ═══════════════════════════════════════════
  // needsApproval
  // ═══════════════════════════════════════════

  it('should return true for ask-permission tools', () => {
    const ps = new PermissionSystem()
    const tool = makeTool('write', 'ask')

    expect(ps.needsApproval(tool, {})).toBe(true)
  })

  it('should return false for auto-permission tools', () => {
    const ps = new PermissionSystem()
    const tool = makeTool('read', 'self')

    expect(ps.needsApproval(tool, {})).toBe(false)
  })

  it('should reflect rule override in needsApproval', () => {
    const ps = new PermissionSystem()
    const tool = makeTool('read', 'self')

    ps.setRule('read', 'ask')
    expect(ps.needsApproval(tool, {})).toBe(true)
  })

  // ═══════════════════════════════════════════
  // isBypassed
  // ═══════════════════════════════════════════

  it('should return true for bypass-permission tools', () => {
    const ps = new PermissionSystem()
    const tool = makeTool('admin', 'bypass')

    expect(ps.isBypassed(tool, {})).toBe(true)
  })

  it('should return false for ask-permission tools', () => {
    const ps = new PermissionSystem()
    const tool = makeTool('write', 'ask')

    expect(ps.isBypassed(tool, {})).toBe(false)
  })

  it('should reflect rule override in isBypassed', () => {
    const ps = new PermissionSystem()
    const tool = makeTool('read', 'self')

    ps.setRule('read', 'bypass')
    expect(ps.isBypassed(tool, {})).toBe(true)
  })

  // ═══════════════════════════════════════════
  // listRules
  // ═══════════════════════════════════════════

  it('should return a copy of rules', () => {
    const ps = new PermissionSystem()
    ps.setRule('read', 'ask')

    const rules = ps.listRules()
    expect(rules.get('read')).toBe('ask')

    // Mutating the copy should not affect original
    rules.set('read', 'self')
    expect(ps.listRules().get('read')).toBe('ask')
  })

  it('should return empty map when no rules set', () => {
    const ps = new PermissionSystem()
    const rules = ps.listRules()
    expect(rules.size).toBe(0)
  })

  // ═══════════════════════════════════════════
  // getByCategory
  // ═══════════════════════════════════════════

  it('should filter tools by category', () => {
    const ps = new PermissionSystem()
    const tools = new Map<string, ToolDefinition>([
      ['read', makeTool('read', 'self', 'file')],
      ['write', makeTool('write', 'ask', 'file')],
      ['bash', makeTool('bash', 'ask', 'exec')],
      ['git', makeTool('git', 'self', 'exec')],
    ])

    const fileTools = ps.getByCategory(tools, 'file')
    expect(fileTools).toHaveLength(2)
    expect(fileTools.map((t) => t.name)).toContain('read')
    expect(fileTools.map((t) => t.name)).toContain('write')
  })

  it('should apply rule overrides in category results', () => {
    const ps = new PermissionSystem()
    ps.setRule('read', 'ask')
    const tools = new Map<string, ToolDefinition>([['read', makeTool('read', 'self', 'file')]])

    const results = ps.getByCategory(tools, 'file')
    expect(results[0]!.level).toBe('ask') // overridden
  })

  it('should return empty array for category with no matches', () => {
    const ps = new PermissionSystem()
    const tools = new Map<string, ToolDefinition>([['read', makeTool('read', 'self', 'file')]])

    expect(ps.getByCategory(tools, 'network')).toHaveLength(0)
  })

  // ═══════════════════════════════════════════
  // Tier 2: 4-mode refactored PermissionSystem
  // ═══════════════════════════════════════════

  it('cycles through all 4 modes', () => {
    const ps = new PermissionSystem('default')
    expect(ps.getMode()).toBe('default')
    ps.cycleMode()
    expect(ps.getMode()).toBe('acceptEdits')
    ps.cycleMode() // plan
    ps.cycleMode() // bypassPermissions
    ps.cycleMode() // back to default
    expect(ps.getMode()).toBe('default')
  })

  it('deny rule blocks even when mode is bypassPermissions', () => {
    const ps = new PermissionSystem('bypassPermissions')
    ps.deny('Bash(rm -rf *)')
    const tool = makeTool('Bash', 'self', 'exec')
    expect(ps.needsApproval(tool, { command: 'rm -rf /' })).toBe(true)
  })

  it('deny beats allow when both match the same command', () => {
    // flattenCommand feeds allow rules as well as deny rules, so teaching it to
    // see through shell `-c` payloads widens what gets auto-approved too. Deny
    // must still short-circuit first (check(): deny → ask → allow), otherwise
    // the fix would trade a bypass for an over-permissive allow.
    const ps = new PermissionSystem()
    ps.allow('Bash(cat:*)')
    ps.deny('Read(.git-credentials)')
    const tool = makeTool('Bash', 'self', 'exec')
    expect(ps.check(tool, { command: "bash -c 'cat .git-credentials'" })).toBe('ask')
  })

  it('an allow rule does not carry a compound command past its unmatched half', () => {
    // The mirror of the case above, in the other direction. `matchBashRule`
    // judged every compound command by "some segment matches": right for deny
    // (wide on purpose) and wrong for allow, which is a *grant*. `Bash(git:*)`
    // handed over `git status && rm -rf ./src` as `bypass` — no prompt at all —
    // and the hard gate does not catch it either, because a relative path is
    // absent from BLOCKED_PATTERNS (`rm -rf /` still is).
    //
    // `permission: 'ask'` matters: with the default `'self'` the tool is
    // already auto-approved, so a `bypass`/`ask` swap would change nothing.
    // `'ask'` is the real Bash tool's declared level (`tools/exec/bash.ts`).
    const ps = new PermissionSystem()
    ps.allow('Bash(git:*)')
    const tool = makeTool('Bash', 'ask', 'exec')

    // Baseline: with no rule at all, both halves are gated identically.
    expect(ps.needsApproval(tool, { command: 'git status && rm -rf ./src' })).toBe(true)
    expect(ps.check(tool, { command: 'git status && rm -rf ./src' })).toBe('ask')

    // The regression: the allowed half must not carry the other half through.
    // (Pre-fix this was `'bypass'` / `false` — no prompt.)
    expect(ps.check(tool, { command: 'git status && rm -rf ./src' })).toBe('ask')
    expect(ps.needsApproval(tool, { command: 'git status && rm -rf ./src' })).toBe(true)

    // Every segment matching still gets the grant — the rule is not dead.
    expect(ps.check(tool, { command: 'git status && git diff' })).toBe('bypass')
    expect(ps.needsApproval(tool, { command: 'git status && git diff' })).toBe(false)
  })

  it('plan mode allows reads only', () => {
    const ps = new PermissionSystem('plan')
    const readTool = makeTool('Read', 'self', 'file')
    const bashTool = makeTool('Bash', 'self', 'exec')
    expect(ps.isBypassed(readTool, {})).toBe(true)
    expect(ps.needsApproval(bashTool, {})).toBe(true)
  })

  it('loads config from settings JSON format', () => {
    const ps = new PermissionSystem()
    ps.loadConfig({
      mode: 'acceptEdits',
      allow: ['Read', 'Write', 'Bash(git:*)'],
      deny: ['Bash(rm *)'],
    })
    expect(ps.getMode()).toBe('acceptEdits')
    const gitTool = makeTool('Bash', 'self', 'exec')
    expect(ps.isBypassed(gitTool, { command: 'git status' })).toBe(true)
    expect(ps.needsApproval(gitTool, { command: 'rm -rf /' })).toBe(true)
  })

  // ── P1: SendMessage goes through the permission classifier ──
  it('routes SendMessage through permission classifier in default mode', () => {
    const ps = new PermissionSystem('default')
    const sendMsg = makeTool('SendMessage', 'self', 'agent')

    // SendMessage falls through mode baseline to tool.permission = 'self'
    expect(ps.check(sendMsg, { to: 'other', summary: 'test', message: 'hi' })).toBe('self')
    expect(ps.needsApproval(sendMsg, { to: 'other', summary: 'test', message: 'hi' })).toBe(false)
  })

  it('honors deny rules for SendMessage in default mode', () => {
    const ps = new PermissionSystem('default')
    ps.deny('SendMessage')
    const sendMsg = makeTool('SendMessage', 'self', 'agent')

    // Deny rule takes priority → blocked
    expect(ps.needsApproval(sendMsg, { to: 'other', summary: 'test', message: 'hi' })).toBe(true)
  })

  // ═══════════════════════════════════════════
  // P0: Permission restrictions (org-level policy)
  // ═══════════════════════════════════════════

  describe('restrictions — forbiddenModes', () => {
    it('cycles only through allowed modes when forbiddenModes is set', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions({ forbiddenModes: ['bypassPermissions'] })

      expect(ps.getMode()).toBe('default')
      ps.cycleMode()
      expect(ps.getMode()).toBe('acceptEdits')
      ps.cycleMode()
      expect(ps.getMode()).toBe('plan')
      ps.cycleMode()
      // Should skip bypassPermissions, wrap to default
      expect(ps.getMode()).toBe('default')
    })

    it('clamps setMode to allowed modes for forbidden modes', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions({ forbiddenModes: ['bypassPermissions'] })

      ps.setMode('bypassPermissions')
      // 次宽的允许模式是 acceptEdits，不是 plan —— plan 排在它下面（P4 修正了顺序；
      // 旧顺序让这条落到更严的 plan 上，那是顺序错的产物，不是有意的保守）。
      expect(ps.getMode()).toBe('acceptEdits')
    })

    it('allows modes not in forbidden list', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions({ forbiddenModes: ['bypassPermissions'] })

      ps.setMode('acceptEdits')
      expect(ps.getMode()).toBe('acceptEdits')
    })
  })

  describe('restrictions — maxAllowedMode', () => {
    it('caps mode at maxAllowedMode and skips higher modes in cycle', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions({ maxAllowedMode: 'plan' })

      // plan 是**最严**的一档（P4），所以 default 也在上限之上，一并被钳下来 ——
      // 上限之下只剩 plan 一个模式，循环因此是定点。
      expect(ps.getMode()).toBe('plan')
      ps.cycleMode()
      expect(ps.getMode()).toBe('plan')
    })

    it('downgrades mode when set above maxAllowedMode', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions({ maxAllowedMode: 'acceptEdits' })

      ps.setMode('bypassPermissions')
      expect(ps.getMode()).toBe('acceptEdits')
    })

    it('re-clamps current mode when restrictions are set', () => {
      const ps = new PermissionSystem('bypassPermissions')
      ps.setRestrictions({ maxAllowedMode: 'plan' })
      expect(ps.getMode()).toBe('plan')
    })

    it('maxAllowedMode=default 保留 default 与 plan（plan 更严，不算越上限）', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions({ maxAllowedMode: 'default' })

      ps.setMode('acceptEdits')
      expect(ps.getMode()).toBe('default')

      // 保留集是「按层级过滤后的循环」，只剩 default 与 plan ⇒ 在两者间交替
      ps.cycleMode()
      expect(ps.getMode()).toBe('plan')
    })
  })

  describe('restrictions — combined', () => {
    it('respects both forbiddenModes and maxAllowedMode', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions({
        maxAllowedMode: 'acceptEdits',
        forbiddenModes: ['plan'],
      })

      // allowed: default, acceptEdits (plan forbidden, bypassPermissions above cap)
      expect(ps.getMode()).toBe('default')
      ps.cycleMode()
      expect(ps.getMode()).toBe('acceptEdits')
      ps.cycleMode()
      expect(ps.getMode()).toBe('default')
    })
  })

  describe('restrictions — API surface', () => {
    it('getRestrictions returns current restrictions', () => {
      const ps = new PermissionSystem()
      expect(ps.getRestrictions()).toBeUndefined()

      ps.setRestrictions({ maxAllowedMode: 'plan' })
      expect(ps.getRestrictions()).toEqual({ maxAllowedMode: 'plan' })
    })

    it('setRestrictions(undefined) clears restrictions', () => {
      const ps = new PermissionSystem('bypassPermissions')
      ps.setRestrictions({ maxAllowedMode: 'plan' })
      expect(ps.getMode()).toBe('plan')

      ps.setRestrictions(undefined)
      expect(ps.getRestrictions()).toBeUndefined()
      // Current mode is not re-clamped when clearing restrictions
      expect(ps.getMode()).toBe('plan')
    })

    it('loadConfig applies restrictions', () => {
      const ps = new PermissionSystem()
      ps.loadConfig({
        mode: 'bypassPermissions',
        restrictions: { maxAllowedMode: 'acceptEdits', forbiddenModes: ['plan'] },
      })
      // bypassPermissions is above acceptEdits cap → clamped to acceptEdits
      expect(ps.getMode()).toBe('acceptEdits')
      expect(ps.getRestrictions()).toEqual({
        maxAllowedMode: 'acceptEdits',
        forbiddenModes: ['plan'],
      })
    })
  })

  describe('setDefaultLevel — legacy 3-level mapping', () => {
    it('maps legacy "self" (tool self-decide) to default mode, NOT a permissive one', () => {
      const ps = new PermissionSystem('default')
      ps.setDefaultLevel('self')
      // The legacy level means "let each tool decide", which is the 'default'
      // mode — not a permissive one. `fc5afd3a` (2026-08-25) was exactly this
      // collision: back when the level was *spelled* 'auto', a
      // `config.permission: auto` meaning "tool self-decides" was mapped onto the
      // then-current 'auto' mode and silently granted write/bash without approval
      // (the "scary autonomous edits" bug). The level was renamed to 'self' on
      // 2026-09-22 to retire that spelling before the classifier mode took the
      // name 'auto'; this test pins that the mapping still lands on 'default'.
      expect(ps.getMode()).toBe('default')
    })

    it('maps legacy "ask" to default mode', () => {
      const ps = new PermissionSystem('default')
      ps.setDefaultLevel('ask')
      expect(ps.getMode()).toBe('default')
    })

    it('maps legacy "bypass" to bypassPermissions mode', () => {
      const ps = new PermissionSystem('default')
      ps.setDefaultLevel('bypass')
      expect(ps.getMode()).toBe('bypassPermissions')
    })
  })

  // ═══════════════════════════════════════════
  // explainDenial — rich denial reason (#52)
  // ═══════════════════════════════════════════

  describe('explainDenial', () => {
    it('reports deny-rule with the matched pattern', () => {
      const ps = new PermissionSystem()
      ps.deny('Write')
      const tool = makeTool('Write', 'bypass')
      expect(ps.check(tool, {})).toBe('ask')
      expect(ps.explainDenial(tool, {})).toMatchObject({
        reason: 'deny-rule',
        rulePattern: 'Write',
      })
    })

    it('reports ask-rule with the matched pattern', () => {
      const ps = new PermissionSystem()
      ps.ask('Bash')
      const tool = makeTool('Bash', 'bypass')
      expect(ps.check(tool, {})).toBe('ask')
      expect(ps.explainDenial(tool, {})).toMatchObject({
        reason: 'ask-rule',
        rulePattern: 'Bash',
      })
    })

    it('reports mode-baseline under plan mode for a write tool', () => {
      const ps = new PermissionSystem()
      ps.setMode('plan')
      const tool = makeTool('Write', 'bypass')
      expect(ps.check(tool, {})).toBe('ask')
      expect(ps.explainDenial(tool, {})).toMatchObject({ reason: 'mode-baseline' })
    })

    it('reports tool-default for an ask-permission tool', () => {
      const ps = new PermissionSystem()
      const tool = makeTool('Write', 'ask')
      expect(ps.check(tool, {})).toBe('ask')
      expect(ps.explainDenial(tool, {})).toMatchObject({ reason: 'tool-default' })
    })
  })

  describe('getInvalidRules', () => {
    it('returns empty when all rules are well-formed', () => {
      const ps = new PermissionSystem()
      ps.deny('Read(**/.git-credentials)')
      ps.allow('Bash(git:*)')
      expect(ps.getInvalidRules()).toEqual([])
    })

    it('reports a malformed rule across allow/deny/ask', () => {
      const ps = new PermissionSystem()
      ps.deny('Bash(ls) x')
      ps.allow('Read(foo')
      ps.ask('Bash()')
      const invalid = ps.getInvalidRules()
      expect(invalid).toHaveLength(3)
      const joined = invalid.join('\n')
      expect(joined).toContain('"Bash(ls) x"')
      expect(joined).toContain('"Read(foo"')
      expect(joined).toContain('"Bash()"')
    })
  })

  // A rule added mid-session must take effect for a tool+input pair that was
  // already checked — otherwise `/permissions allow X` writes settings.json and
  // silently does nothing until restart.
  describe('rule mutation invalidates the decision cache', () => {
    it('allow() affects an already-checked tool', () => {
      const ps = new PermissionSystem('plan')
      const tool = makeTool('Write', 'ask', 'file')
      expect(ps.check(tool, {})).toBe('ask')
      ps.allow('Write')
      expect(ps.check(tool, {})).toBe('bypass')
    })

    it('deny() affects an already-checked tool', () => {
      const ps = new PermissionSystem('bypassPermissions')
      const tool = makeTool('Bash', 'self', 'exec')
      expect(ps.check(tool, {})).toBe('bypass')
      ps.deny('Bash')
      expect(ps.check(tool, {})).toBe('ask')
    })

    it('ask() affects an already-checked tool', () => {
      const ps = new PermissionSystem('bypassPermissions')
      const tool = makeTool('Read', 'self', 'file')
      expect(ps.check(tool, {})).toBe('bypass')
      ps.ask('Read')
      expect(ps.check(tool, {})).toBe('ask')
    })
  })

  // ═══════════════════════════════════════════
  // P4 — 层级顺序必须等于真实宽严（plan 才是最严的一档）
  // ═══════════════════════════════════════════

  describe('P4 — 层级顺序与真实宽严一致', () => {
    // 用 `needsApproval` **实测**每一档放行哪些工具。探针不读层级表，所以它给出的是
    // 测量值；下面那条断言把层级表钉在这个测量值上 —— 两者不一致就红。
    const PROBES: ToolDefinition[] = [
      makeTool('Read', 'self', 'file'),
      makeTool('Grep', 'self', 'file'),
      makeTool('Glob', 'self', 'file'),
      makeTool('Write', 'ask', 'file'),
      makeTool('Edit', 'ask', 'file'),
      makeTool('Bash', 'ask', 'exec'),
      makeTool('git', 'self', 'exec'),
      makeTool('task', 'self', 'exec'),
      makeTool('web-fetch', 'self', 'network'),
      makeTool('memory', 'self', 'agent'),
      makeTool('cron', 'self', 'scheduling'),
    ]
    const passesIn = (mode: PermissionMode, tool: ToolDefinition): boolean =>
      !new PermissionSystem(mode).needsApproval(tool, { command: 'pnpm test' })
    /** a 放行的每一样，b 也放行 —— 即 a 不比 b 宽。 */
    const notWiderThan = (a: PermissionMode, b: PermissionMode): boolean =>
      PROBES.every((t) => !passesIn(a, t) || passesIn(b, t))

    it('探针自检：plan 只放行只读三件套', () => {
      expect(PROBES.filter((t) => passesIn('plan', t)).map((t) => t.name)).toEqual([
        'Read',
        'Grep',
        'Glob',
      ])
    })

    it('层级表首位 = 实测最严的那一档（数组与测量同源，不是各说各话）', () => {
      const ALL: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions']
      const narrowest = ALL.filter((m) => ALL.every((o) => o === m || notWiderThan(m, o)))
      // 实测的唯一答案就是 plan：它同时严格窄于 default（后者放行 git / task /
      // web-fetch / memory / cron 这些 `permission: 'self'` 的非文件工具）与
      // acceptEdits（后者放行 Write/Edit）。层级表若把 default 排回首位，这里就红。
      expect(narrowest).toEqual(['plan'])
      expect(PERMISSION_MODE_HIERARCHY[0]).toBe(narrowest[0])
    })

    it('上限 plan 不再放行 acceptEdits 或 default（两者都比 plan 宽）', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions({ maxAllowedMode: 'plan' })

      ps.setMode('acceptEdits')
      expect(ps.getMode()).toBe('plan')
      ps.setMode('default')
      expect(ps.getMode()).toBe('plan')
    })

    it('上限 plan 的循环一档都不再经过 acceptEdits / default / bypassPermissions', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions({ maxAllowedMode: 'plan' })

      const visited = [ps.getMode()]
      for (let i = 0; i < 5; i++) visited.push(ps.cycleMode())
      expect(visited).not.toContain('acceptEdits')
      expect(visited).not.toContain('default')
      expect(visited).not.toContain('bypassPermissions')
    })

    it('未受限时的循环顺序不变（default → acceptEdits → plan → bypassPermissions）', () => {
      const ps = new PermissionSystem('default')
      expect(ps.cycleMode()).toBe('acceptEdits')
      expect(ps.cycleMode()).toBe('plan')
      expect(ps.cycleMode()).toBe('bypassPermissions')
      expect(ps.cycleMode()).toBe('default')
    })

    it('禁用 bypass 后请求 bypass ⇒ 落到次宽的 acceptEdits（顺序修正的连带结果，如实钉住）', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions({ forbiddenModes: ['bypassPermissions'] })

      ps.setMode('bypassPermissions')
      expect(ps.getMode()).toBe('acceptEdits')
    })
  })

  // ═══════════════════════════════════════════
  // P1 — 写错的 permissionRestrictions 必须告警并 fail-closed
  // ═══════════════════════════════════════════

  describe('P1 — 写错的 permissionRestrictions 不再静默失效', () => {
    /** 模拟 JSON 配置真能塞进来的东西：运行时没有任何类型检查。 */
    const garbage = (v: unknown): PermissionRestrictions => v as PermissionRestrictions
    const warnings = (ps: PermissionSystem): string => ps.getInvalidRestrictions().join('\n')

    it('正常配置：零告警、行为与从前一致（对照组）', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions({ forbiddenModes: ['bypassPermissions'], maxAllowedMode: 'acceptEdits' })

      expect(ps.getInvalidRestrictions()).toEqual([])
      ps.setMode('bypassPermissions')
      expect(ps.getMode()).toBe('acceptEdits')
    })

    it('模式名错拼 ⇒ 告警点名该条目，且模式钉到最严一档（不是忽略）', () => {
      const ps = new PermissionSystem('bypassPermissions')
      ps.setRestrictions(garbage({ forbiddenModes: ['bypass-permissions'] }))

      // 忽略 = fail-open（今天的行为：什么都不禁）；告警 + 钉最严才是 fail-closed
      expect(ps.getMode()).toBe('plan')
      expect(warnings(ps)).toContain('forbiddenModes[0]')
      expect(warnings(ps)).toContain('bypass-permissions')
    })

    it('值写成标量而不是数组 ⇒ 告警并钉住（今天它会整条静默失效）', () => {
      const ps = new PermissionSystem('bypassPermissions')
      ps.setRestrictions(garbage({ forbiddenModes: 'bypassPermissions' }))

      expect(ps.getMode()).toBe('plan')
      expect(warnings(ps)).toContain('must be an array')
    })

    it('maxAllowedMode 错拼 ⇒ 告警并钉住（今天它让上限整个跳过、什么都不限）', () => {
      const ps = new PermissionSystem('bypassPermissions')
      ps.setRestrictions(garbage({ maxAllowedMode: 'acceptedit' }))

      expect(ps.getMode()).toBe('plan')
      expect(warnings(ps)).toContain('acceptedit')
    })

    it('键名错拼（forbiddenMode 漏了 s）⇒ 告警 —— 否则整条策略静默失效', () => {
      const ps = new PermissionSystem('bypassPermissions')
      ps.setRestrictions(garbage({ forbiddenMode: ['bypassPermissions'] }))

      expect(ps.getMode()).toBe('plan')
      expect(warnings(ps)).toContain('forbiddenMode')
    })

    it('整条限制不是对象 ⇒ 告警并钉住', () => {
      const ps = new PermissionSystem('bypassPermissions')
      ps.setRestrictions(garbage('bypassPermissions'))

      expect(ps.getMode()).toBe('plan')
      expect(warnings(ps)).toContain('not an object')
    })

    it('大小写与遗留别名照旧认（PLAN / Bypass）', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions(garbage({ forbiddenModes: ['Bypass', 'PLAN'] }))

      expect(ps.getInvalidRestrictions()).toEqual([])
      expect(ps.getRestrictions()?.forbiddenModes).toEqual(['bypassPermissions', 'plan'])
    })

    it('空对象 = 没有限制，不告警', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions(garbage({}))
      expect(ps.getInvalidRestrictions()).toEqual([])
      expect(ps.getRestrictions()).toBeUndefined()
    })

    it('幂等：已规范化的限制再喂一次不再告警（子代理会原样转交一次）', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions({ maxAllowedMode: 'plan' })
      expect(ps.getInvalidRestrictions()).toEqual([])

      ps.setRestrictions(ps.getRestrictions())
      expect(ps.getInvalidRestrictions()).toEqual([])
      expect(ps.getMode()).toBe('plan')
    })

    it('两条通道互不串：限制的告警不进规则通道，反之亦然', () => {
      const ps = new PermissionSystem('default')
      ps.allow('Read')
      ps.setRestrictions(garbage({ maxAllowedMode: 'nope' }))

      expect(warnings(ps)).toContain('nope')
      expect(ps.getInvalidRules()).toEqual([])
    })
  })

  // ═══════════════════════════════════════════
  // P2 — 上限必须同时约束 allow 规则通道
  // ═══════════════════════════════════════════

  describe('P2 — maxAllowedMode 也约束 allow 规则通道', () => {
    const bash = (): ToolDefinition => makeTool('Bash', 'ask', 'exec')

    it('无限制时 allow 规则照旧直接放行（对照组：本项不动默认行为）', () => {
      const ps = new PermissionSystem('default')
      ps.allow('Bash(git:*)')

      expect(ps.needsApproval(bash(), { command: 'git push origin main' })).toBe(false)
    })

    it('上限 acceptEdits：规则不能放行上限自己都要审批的命令', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions({ maxAllowedMode: 'acceptEdits' })
      ps.allow('Bash')

      // 上限自己就放行的（仅验证类命令）不受影响 —— 上限不是把整条通道封死
      expect(ps.needsApproval(bash(), { command: 'pnpm test' })).toBe(false)
      // 上限之外（acceptEdits 对这一条本就返回 ask）：规则被压回审批
      expect(ps.needsApproval(bash(), { command: 'git push origin main' })).toBe(true)
    })

    it('上限 plan：读仍在限内（规则有效），写被压回审批', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions({ maxAllowedMode: 'plan' })
      ps.allow('Read')
      ps.allow('Write')

      expect(ps.needsApproval(makeTool('Read', 'self', 'file'), { file_path: 'a.ts' })).toBe(false)
      expect(ps.needsApproval(makeTool('Write', 'ask', 'file'), { file_path: 'a.ts' })).toBe(true)
    })

    it('上限 default：落在工具自身声明上（该档即「交给工具自决」）', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions({ maxAllowedMode: 'default' })
      ps.allow('Bash')
      ps.allow('git')

      expect(ps.needsApproval(bash(), { command: 'git push' })).toBe(true) // tool 声明 ask
      expect(ps.needsApproval(makeTool('git', 'self', 'exec'), { command: 'push' })).toBe(false) // tool declares 'self'
    })

    it('只有 forbiddenModes 时不动 allow 规则通道（范围钉住：本项只管上限）', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions({ forbiddenModes: ['bypassPermissions'] })
      ps.allow('Bash(git:*)')

      expect(ps.needsApproval(bash(), { command: 'git push origin main' })).toBe(false)
    })
  })
})
