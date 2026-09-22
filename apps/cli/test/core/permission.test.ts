import { beforeAll, describe, it, expect } from 'vitest'
import type {
  PermissionLevel,
  PermissionMode,
  PermissionRestrictions,
  ToolDefinition,
} from '../../src/shared'
import { PermissionSystem } from '../../src/core/permission'
import type { PermissionClassifier } from '../../src/core/permission-classifier'
import {
  ALL_MODES,
  MODE_CYCLE,
  PERMISSION_MODE_HIERARCHY,
  clampMode,
} from '../../src/core/permission-config'

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
      // 请求 bypass 被禁 ⇒ 落到层级表上「次宽的允许档」。这条断言**第三次**被改，
      // 三次改的都是同一个原因：夹在中间的那一档变了（plan⇒acceptEdits⇒auto）。
      //
      // 为什么 `auto` 方向上是安全的：它是 bypass 的**严格子集**（bypass 无门放行一切，
      // auto 对每一次调用先过分类器），所以「落到 auto」相对请求是**收窄**，不是提权。
      // 为什么它仍有分量、必须记下来：auto 是运行期裁决，能放行 acceptEdits 会拦下的
      // 调用（非校验型 Bash、网络）。所以对一个「明令禁掉 bypass」的配置，落点从
      // 「静默放行写文件」变成「每一次调用都被门」，语义确实变了。
      //
      // **未接线期间的后果（Step 5 之前）**：分类器还没接，auto 的静态基线恒为 ask
      // ⇒ 该配置下**每个工具调用都被拒**。fail-closed 方向，但服务会像坏了一样安静，
      // 所以 daemon 侧另有一条测试与一段注释点名这件事。
      expect(ps.getMode()).toBe('auto')
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

  describe('setDefaultLevel — legacy levels and real mode names', () => {
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

    it('leaves every legacy spelling unreported — they are mapped, not dropped', () => {
      for (const legacy of ['self', 'ask', 'bypass'] as const) {
        const ps = new PermissionSystem('default')
        ps.setDefaultLevel(legacy)
        // Silence is the contract for a *recognized* value, legacy or not. Only a
        // value that is neither is something the operator needs to hear about.
        expect(ps.getInvalidPermissionMode(), `permission: ${legacy}`).toEqual([])
      }
    })

    it('honours every real mode name — the "permission: plan" regression', () => {
      // Until 2.82.0 this method read `level === 'bypass' ? 'bypassPermissions' :
      // 'default'`, so *every* mode name a user could write in config.yml —
      // including `plan` and `auto` and `bypassPermissions` itself — landed on
      // `default` with no warning and no error. `default` auto-approves every tool
      // declaring `permission: 'self'` (git, task, web-fetch, cron, memory, …)
      // while `plan` admits only reads: a user asking to NARROW the gate got a
      // wider one, silently. Each mode name must now land on itself.
      for (const mode of ALL_MODES) {
        const ps = new PermissionSystem('default')
        ps.setDefaultLevel(mode)
        expect(ps.getMode(), `permission: ${mode}`).toBe(mode)
        expect(ps.getInvalidPermissionMode(), `permission: ${mode}`).toEqual([])
      }
    })

    it('an unknown value pins "default" and reports it', () => {
      const ps = new PermissionSystem('default')
      ps.setDefaultLevel('manaul' as PermissionLevel)

      expect(ps.getMode()).toBe('default')
      const warnings = ps.getInvalidPermissionMode()
      expect(warnings).toHaveLength(1)
      // The message has to be actionable — it echoes the bad value and names every
      // accepted spelling, legacy one included.
      for (const mode of ALL_MODES) expect(warnings[0]).toContain(mode)
      expect(warnings[0]).toContain('manaul')
      expect(warnings[0]).toContain('bypass')
    })

    it('reports an unknown value of a non-string type instead of throwing', () => {
      // The value comes from YAML, so `permission: 42` reaches this method as a
      // number — the discriminator must answer false for it, not explode.
      const ps = new PermissionSystem('default')
      ps.setDefaultLevel(42 as unknown as PermissionLevel)

      expect(ps.getMode()).toBe('default')
      expect(ps.getInvalidPermissionMode()[0]).toContain('42')
    })

    it('a later recognized value clears the previous warning', () => {
      const ps = new PermissionSystem('default')
      ps.setDefaultLevel('nope' as PermissionLevel)
      expect(ps.getInvalidPermissionMode()).toHaveLength(1)

      ps.setDefaultLevel('acceptEdits')
      expect(ps.getMode()).toBe('acceptEdits')
      expect(ps.getInvalidPermissionMode()).toEqual([])
    })

    it('org restrictions still cap a requested mode name', () => {
      // Discriminating on purpose: the ceiling admits `default` too, so this can
      // only land on `acceptEdits` if the mode name was actually honoured — the
      // old `… : 'default'` mapping yields `default` here and fails.
      const honoured = new PermissionSystem('default')
      honoured.setRestrictions({ maxAllowedMode: 'acceptEdits' })
      honoured.setDefaultLevel('acceptEdits')
      expect(honoured.getMode()).toBe('acceptEdits')

      // And the ceiling still bites above the request: getMode() reports the
      // clamped destination, never the value asked for.
      const capped = new PermissionSystem('default')
      capped.setRestrictions({ maxAllowedMode: 'plan' })
      capped.setDefaultLevel('bypassPermissions')
      expect(capped.getMode()).toBe('plan')
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

    /**
     * 静态宽度**测不出来的**档位 —— `auto` 把裁决委托给运行期的分类器，本探针读的是
     * 同步的 `check()`（静态基线），所以量出来的是**基线**，不是这一档的真实宽度。
     *
     * 留在域里的后果很具体：`auto` 的静态基线（只读三件套放行，其余一律 `ask`）与
     * `plan` **逐项相同**，`narrowest` 会因此翻成 `['auto', 'plan']` 或把层级表首位
     * 指向 `auto`，即把「运行期委托档」放到最严的位置上。
     *
     * 排除集合由**测量**导出，不是宣布 —— 判据是「挂上一个一律放行的分类器之后，
     * `resolveApproval` 比 `check` 更宽」的档位。这正是「委托给运行期」的可测定义。
     *
     * 上一版的判据是「静态上什么都不放行」。它随 `auto` 拿到只读豁免而失效：口径一
     * 变，那个predicate 就再也指不到任何档位（`passNothing` 恒为空集），而空集与
     * 「没有委托档」在断言里同形 —— 检查自己出事了，所以换成本条。
     *
     * 声明与测量分开写是有意的：哪天又有档位开始运行期委托，测量值会变大而声明不会，
     * 这条立刻红，逼人来认领，而不是静默扩大排除面。
     */
    const DELEGATING_DECLARED: PermissionMode[] = ['auto']
    let RUNTIME_DELEGATING: PermissionMode[] = []

    beforeAll(async () => {
      RUNTIME_DELEGATING = []
      for (const m of ALL_MODES) {
        const ps = new PermissionSystem(m)
        ps.setClassifier({ version: 'width-probe', classify: async () => ({ allow: true }) })
        for (const t of PROBES) {
          if (passesIn(m, t)) continue // 静态已放行 ⇒ 无从观察「更宽」
          const d = await ps.resolveApproval(t, { command: 'pnpm test' })
          if (d.level !== 'ask') {
            RUNTIME_DELEGATING.push(m)
            break
          }
        }
      }
    })

    const STATICALLY_MEASURABLE = ALL_MODES.filter((m) => !DELEGATING_DECLARED.includes(m))

    it('被排除在宽度探针外的，恰好是「运行期会委托出去」的那些档位（导出，不是宣布）', () => {
      expect(RUNTIME_DELEGATING).toEqual(DELEGATING_DECLARED)
    })

    it('层级表首位 = 实测最严的那一档（数组与测量同源，不是各说各话）', () => {
      const narrowest = STATICALLY_MEASURABLE.filter((m) =>
        STATICALLY_MEASURABLE.every((o) => o === m || notWiderThan(m, o)),
      )
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

    it('禁用 bypass 后请求 bypass ⇒ 落到次宽的 auto（层级表插档的连带结果，如实钉住）', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions({ forbiddenModes: ['bypassPermissions'] })

      ps.setMode('bypassPermissions')
      // `auto` 插在 acceptEdits 与 bypassPermissions 之间（就是 CC 的 `zo` 排序），
      // 于是「次宽的允许档」从 acceptEdits 变成 auto。两者都符合 `clampMode`
      // 「≤ 请求档的最高允许档」的契约，且 auto 是 bypass 的**严格子集**
      // ⇒ 依然是收窄，不是提权。（上一条 `:344` 有同一处的完整论证。）
      expect(ps.getMode()).toBe('auto')
    })
  })

  // ═══════════════════════════════════════════
  // P4c — `auto` 档：静态基线恒为 ask，且层级表必须收全每一个档位
  // ═══════════════════════════════════════════

  describe('P4c — auto 档的静态形状与层级表全员在场', () => {
    it('**每个**档位都在层级表里 —— 漏一个会让组织级上限整体静默失效', () => {
      // 这张表是**编译期穷尽**的：往 `PermissionMode` 里加一个成员而不改这里，
      // `tsc` 会报「缺少属性」。它存在的理由不是好看，而是层级表本身**不会**
      // 因为漏项而报错 —— `indexOf` 给 -1，`permission-config.ts` 的
      // `if (capIdx >= 0)` 于是整条上限被跳过（fail-open，无任何提示）。
      const EVERY_MODE: Record<PermissionMode, true> = {
        default: true,
        acceptEdits: true,
        plan: true,
        auto: true,
        bypassPermissions: true,
      }
      const members = Object.keys(EVERY_MODE) as PermissionMode[]
      expect([...ALL_MODES].sort()).toEqual([...members].sort())
      for (const m of members) {
        expect(PERMISSION_MODE_HIERARCHY, `${m} 不在层级表里 ⇒ org 上限会静默失效`).toContain(m)
      }
    })

    it('auto 夹在 acceptEdits 与 bypassPermissions 之间（运行期可比 acceptEdits 更宽）', () => {
      const h = PERMISSION_MODE_HIERARCHY
      expect(h.indexOf('auto')).toBeGreaterThan(h.indexOf('acceptEdits'))
      expect(h.indexOf('auto')).toBeLessThan(h.indexOf('bypassPermissions'))
    })

    it('上限 acceptEdits 时 auto 不可达 —— 否则上限会把「比它宽的一档」放进来', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions({ maxAllowedMode: 'acceptEdits' })

      ps.setMode('auto')
      expect(ps.getMode()).not.toBe('auto')
      expect(ps.getMode()).toBe('acceptEdits')
    })

    it('auto 的静态基线只放行只读三件套，其余一律 ask —— 含 `permission: self` 的非文件工具', () => {
      // 这一条守的是承重的那一行（`modeBaseline` 的 `case 'auto'`）。
      // 若它改成 `'mode-baseline'`（直觉做法，`default` 就是那样），`check()` 的
      // 第 5 步会放行、继续走到第 6 步读 `tool.permission`，于是 20 个声明
      // `permission: 'self'` 的工具**永远见不到分类器** —— 半坏，不是明显坏。
      // 断言里点名非文件的 `self` 工具，正是为了钉住「第 5 步不得让位给第 6 步」。
      //
      // 只读三件套是**有意**让位的（`isReadOnlyTool`，与 plan 同一份判据）：把读也
      // 拦进分类器，会让 auto 成为整条梯子里唯一「开个文件都要跨模型往返」的档，
      // 且分类器一旦不可达就连读都做不了。所以这里的豁免是契约的一部分，不是漏网。
      const ps = new PermissionSystem('auto')
      for (const tool of [
        makeTool('git', 'self', 'exec'),
        makeTool('web-fetch', 'self', 'network'),
        makeTool('task', 'self', 'exec'),
        makeTool('memory', 'self', 'agent'),
        makeTool('cron', 'self', 'scheduling'),
        makeTool('Bash', 'ask', 'exec'),
        makeTool('Write', 'ask', 'file'),
        // 最强的一根探针：**声明 `permission: 'bypass'` 的工具在 auto 档也必须被问**。
        // 第 6 步会原样返回 `'bypass'`，所以只要基线让位给它，这条立刻红。
        makeTool('DeclaredBypass', 'bypass', 'exec'),
        // 类别那一半是承重的：名字叫 Read 但**不是** file 类别的工具不得吃豁免。
        // 只按名字判断的话，将来任何一个叫 Read 的非文件工具都会静默走只读通道。
        makeTool('Read', 'self', 'network'),
      ]) {
        expect(ps.check(tool, { command: 'pnpm test' }), `${tool.name} 在 auto 档应问`).toBe('ask')
        expect(ps.explainDenial(tool, { command: 'pnpm test' }).reason).toBe('mode-baseline')
      }

      for (const name of ['Read', 'Grep', 'Glob']) {
        expect(ps.check(makeTool(name, 'self', 'file'), {}), `${name} 是只读，不该问`).toBe(
          'bypass',
        )
      }
    })

    it('auto 不是 bypass：允许规则/上限之外的一切都不被它放行', () => {
      const ps = new PermissionSystem('auto')
      expect(ps.isBypassed(makeTool('Bash', 'ask', 'exec'), { command: 'pnpm test' })).toBe(false)
      expect(ps.getDefaultLevel()).toBe('self')
    })

    it('agent 要 auto 就能拿到 auto（手写 modeMap 漏项会静默落到 default）', () => {
      const sub = new PermissionSystem('default').createSubAgentPermission('auto')
      expect(sub.getMode()).toBe('auto')
      // 对照：认不出的值仍落到 default —— 证明上一条抓的是映射表，不是「谁都给 auto」
      expect(new PermissionSystem('default').createSubAgentPermission('nope').getMode()).toBe(
        'default',
      )
    })
  })

  // ═══════════════════════════════════════════
  // P4b — 合法档位集（ALL_MODES）与转盘（MODE_CYCLE）是两张表
  // ═══════════════════════════════════════════

  describe('P4b — ALL_MODES 是合法档位集，MODE_CYCLE 只是转盘', () => {
    /**
     * 这两张表今天**内容相同**，所以本组用例现在全都绿，看起来像在测空气。
     * 它的价值在下一次两张表分道扬镳的时刻：`getAllowedModes` 一旦被改回过滤
     * `MODE_CYCLE`，第一条就会红 —— 那一刻 `clampMode('bypassPermissions')` 会
     * 沿途下走到 `acceptEdits`，即一次**静默降档**，而其余测试全绿。
     * 两条负控都实跑过（都在 `permission-config.ts` 上做，做完 `cp` 还原并逐字比对 sha256）：
     *
     * - **两张表被合并**（转盘去掉 `bypassPermissions` + `getAllowedModes` 改回过滤
     *   `MODE_CYCLE`）：本条报 `expected 'acceptEdits' to be 'bypassPermissions'`
     *   —— 那行差异就是静默降档本身。这正是本组要抓的那一种坏法。
     * - **只做前半步**（转盘变短、`getAllowedModes` 仍过滤 `ALL_MODES`）：本条
     *   **保持绿**（确实没有任何降档，拆分正在起作用），但 P4 的
     *   `cycles through all 4 modes` 与 `未受限时的循环顺序不变…` 两条转红
     *   —— 转盘变短本身不是静默的，它被那两条钉住了。
     */
    it('合法档位集里的每一档都是 clampMode 的不动点（无限制时不许被改写）', () => {
      for (const mode of ALL_MODES) {
        expect(clampMode(mode, undefined)).toBe(mode)
        // 构造函数走另一条路（VALID_MODES），一并钉住：认得出它就不该退化成遗留级别。
        expect(new PermissionSystem(mode).getMode()).toBe(mode)
      }
    })

    it('转盘里的每一档都必须是合法档位（否则转盘会报出一个构造函数不认的模式）', () => {
      for (const mode of MODE_CYCLE) expect(ALL_MODES).toContain(mode)
    })

    it('显式禁用 bypassPermissions 仍然生效 —— 显式禁用 ≠ 静默降档', () => {
      const ps = new PermissionSystem('default')
      ps.setRestrictions({ forbiddenModes: ['bypassPermissions'] })

      ps.setMode('bypassPermissions')
      expect(ps.getMode()).not.toBe('bypassPermissions')
    })

    it('循环只在转盘上走，永不落到转盘之外的档位', () => {
      const ps = new PermissionSystem('default')
      for (let i = 0; i < MODE_CYCLE.length * 3; i++) {
        expect(MODE_CYCLE).toContain(ps.cycleMode())
      }
    })
  })

  // ═══════════════════════════════════════════
  // P5 — `resolveApproval`：只可放行，不可否决
  // ═══════════════════════════════════════════

  describe('P5 — resolveApproval（分类器可介入的范围）', () => {
    const bash = (): ToolDefinition => makeTool('Bash', 'ask', 'exec')
    const BASH_INPUT = { command: 'pnpm test' }

    /**
     * 一律放行的分类器，并记下每次被问到什么。「问了没有」是契约的一半 —— 只测结果
     * 的话，一条把每次调用都送去问 LLM（包括静态已放行的）的实现同样会全绿。
     */
    function alwaysAllow(): { classifier: PermissionClassifier; asked: string[] } {
      const asked: string[] = []
      return {
        asked,
        classifier: {
          version: 'test',
          classify: async (req) => {
            asked.push(`${req.tool}:${req.reason}`)
            return { allow: true }
          },
        },
      }
    }

    it('auto 档没挂分类器 ⇒ 仍然 ask（fail-closed，不是静默放行）', async () => {
      const ps = new PermissionSystem('auto')
      expect(await ps.resolveApproval(bash(), BASH_INPUT)).toEqual({
        level: 'ask',
        source: 'static',
        denialReason: 'mode-baseline',
      })
    })

    it('auto 之外的档位即使挂了分类器也不问 —— 分类器是 auto 档的组成，不是全局后门', async () => {
      const ps = new PermissionSystem('default')
      const { classifier, asked } = alwaysAllow()
      ps.setClassifier(classifier)

      expect((await ps.resolveApproval(bash(), BASH_INPUT)).level).toBe('ask')
      expect(asked).toEqual([])
    })

    it('放行 ⇒ bypass，来源记为 classifier，且恰好问了它一次', async () => {
      const ps = new PermissionSystem('auto')
      const { classifier, asked } = alwaysAllow()
      ps.setClassifier(classifier)

      expect(await ps.resolveApproval(bash(), BASH_INPUT)).toMatchObject({
        level: 'bypass',
        source: 'classifier',
      })
      expect(asked).toEqual(['Bash:mode-baseline'])

      // 同一次调用再问一遍不再命中分类器（裁决已缓存）。
      expect((await ps.resolveApproval(bash(), BASH_INPUT)).level).toBe('bypass')
      expect(asked).toHaveLength(1)
    })

    it('静态已放行的调用一次都不问分类器（非 ask 判定逐字节不变）', async () => {
      const ps = new PermissionSystem('auto')
      const { classifier, asked } = alwaysAllow()
      ps.setClassifier(classifier)

      expect(await ps.resolveApproval(makeTool('Read', 'self', 'file'), {})).toEqual({
        level: 'bypass',
        source: 'static',
      })
      expect(asked).toEqual([])
    })

    it('deny 规则不可被分类器覆盖 —— 否则它成了绕开组织规则的万能通道', async () => {
      const ps = new PermissionSystem('auto')
      const { classifier, asked } = alwaysAllow()
      ps.setClassifier(classifier)
      ps.deny('Bash')

      expect(await ps.resolveApproval(bash(), BASH_INPUT)).toMatchObject({
        level: 'ask',
        source: 'static',
        denialReason: 'deny-rule',
      })
      expect(asked).toEqual([])
    })

    it('ask 规则不可被覆盖 —— 这一条是人写下来的', async () => {
      const ps = new PermissionSystem('auto')
      const { classifier, asked } = alwaysAllow()
      ps.setClassifier(classifier)
      ps.ask('Bash')

      expect(await ps.resolveApproval(bash(), BASH_INPUT)).toMatchObject({
        level: 'ask',
        denialReason: 'ask-rule',
      })
      expect(asked).toEqual([])
    })

    it('缓存过的放行会被新增的 deny 规则作废（裁决不是免死金牌）', async () => {
      const ps = new PermissionSystem('auto')
      const { classifier, asked } = alwaysAllow()
      ps.setClassifier(classifier)

      expect((await ps.resolveApproval(bash(), BASH_INPUT)).level).toBe('bypass')
      ps.deny('Bash')
      expect(await ps.resolveApproval(bash(), BASH_INPUT)).toMatchObject({
        level: 'ask',
        denialReason: 'deny-rule',
      })
      expect(asked).toHaveLength(1)
    })

    it('可重试的引擎故障不缓存（否则 `retryable: true` 当场变成假话）', async () => {
      const ps = new PermissionSystem('auto')
      let n = 0
      ps.setClassifier({
        version: 'test',
        classify: async () => {
          n++
          return { allow: false, reason: 'classifier unreachable', retryable: true }
        },
      })

      const first = await ps.resolveApproval(bash(), BASH_INPUT)
      expect(first).toMatchObject({ denialReason: 'classifier-deny', retryable: true })
      await ps.resolveApproval(bash(), BASH_INPUT)
      expect(n).toBe(2)
    })

    it('策略拒绝会缓存 —— 同一次调用反复问同一个问题只是烧 token', async () => {
      const ps = new PermissionSystem('auto')
      let n = 0
      ps.setClassifier({
        version: 'test',
        classify: async () => {
          n++
          return { allow: false, reason: 'irreversible local destruction' }
        },
      })

      expect(await ps.resolveApproval(bash(), BASH_INPUT)).toMatchObject({
        denialReason: 'classifier-deny',
        classifierReason: 'irreversible local destruction',
      })
      expect((await ps.resolveApproval(bash(), BASH_INPUT)).retryable).toBeUndefined()
      expect(n).toBe(1)
    })

    /**
     * 上限把「放行」重新按**上限档的静态授予**推导（`allowRuleDecision`），于是
     * `maxAllowedMode: 'auto'` 恰好把分类器**废掉**：非只读工具在 auto 档的静态
     * 授予就是 `ask`，而只读三件套根本走不到分类器。
     *
     * 方向是对的 —— 上限越高能跑的东西越多（不设上限 ⇒ 放行；上限 auto ⇒ 拒绝），
     * 单调，没有反转，所以不是安全缺陷。代价也是真的：`maxAllowedMode: 'auto'`
     * 读起来像「允许 auto 档」，实际让 auto 退化成 plan 的行为。想要的运维写法是
     * 不设上限、或设成 `bypassPermissions`（上限管的是**档位**，不是逐次裁决）。
     * 这一条**故意不是**断言「本该如此」，而是钉住现行为，免得它悄悄改成别的样子。
     */
    it('上限 auto：分类器放行仍落回 ask（上限的静态授予说了算）', async () => {
      const ps = new PermissionSystem('auto')
      const { classifier } = alwaysAllow()
      ps.setClassifier(classifier)
      ps.setRestrictions({ maxAllowedMode: 'auto' })

      expect(ps.getMode()).toBe('auto') // 档位没被降级 —— 界面仍显示 auto
      expect(await ps.resolveApproval(bash(), BASH_INPUT)).toMatchObject({
        level: 'ask',
        source: 'classifier',
      })
    })

    it('上限 bypassPermissions：分类器放行照常生效（对照上一条）', async () => {
      const ps = new PermissionSystem('auto')
      const { classifier } = alwaysAllow()
      ps.setClassifier(classifier)
      ps.setRestrictions({ maxAllowedMode: 'bypassPermissions' })

      expect((await ps.resolveApproval(bash(), BASH_INPUT)).level).toBe('bypass')
    })

    it('分类器随 auto **档**传播到子代理（不是随代理）', async () => {
      const ps = new PermissionSystem('auto')
      const { classifier, asked } = alwaysAllow()
      ps.setClassifier(classifier)

      const inherited = ps.createSubAgentPermission('inherit')
      expect(inherited.getMode()).toBe('auto')
      expect(inherited.hasClassifier()).toBe(true)
      expect((await inherited.resolveApproval(bash(), BASH_INPUT)).level).toBe('bypass')

      // 子代理自己挑了别的档位 ⇒ 不带分类器，那条路必须仍是硬拒。
      const explicit = ps.createSubAgentPermission('default')
      expect(explicit.hasClassifier()).toBe(false)
      expect((await explicit.resolveApproval(bash(), BASH_INPUT)).level).toBe('ask')

      expect(asked).toHaveLength(1)
    })

    it('分类器不会被绕过 auto 档拿到（改档之后再改回来，仍是当前那个）', async () => {
      const ps = new PermissionSystem('auto')
      const { classifier } = alwaysAllow()
      ps.setClassifier(classifier)

      ps.setMode('plan')
      expect((await ps.resolveApproval(bash(), BASH_INPUT)).level).toBe('ask')
      ps.setMode('auto')
      expect((await ps.resolveApproval(bash(), BASH_INPUT)).level).toBe('bypass')

      // 交回 undefined 就真的没有了 —— setter 不是只能加。
      ps.setClassifier(undefined)
      expect(ps.hasClassifier()).toBe(false)
      expect((await ps.resolveApproval(bash(), BASH_INPUT)).level).toBe('ask')
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
