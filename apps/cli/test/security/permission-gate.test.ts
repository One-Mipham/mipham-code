import { describe, it, expect } from 'vitest'
import type { ToolDefinition } from '../../src/shared/types'
import { PermissionSystem } from '../../src/core/permission'

// ── Minimal tool fixtures ──

const autoTool: ToolDefinition = {
  name: 'Read',
  description: 'Read a file',
  category: 'file',
  permission: 'auto',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute() {
    return { success: true, content: 'ok' }
  },
}

const askTool: ToolDefinition = {
  name: 'Bash',
  description: 'Execute command',
  category: 'exec',
  permission: 'ask',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute() {
    return { success: true, content: 'ok' }
  },
}

const bypassTool: ToolDefinition = {
  name: 'Debug',
  description: 'Debug tool',
  category: 'system',
  permission: 'bypass',
  parameters: { type: 'object', properties: {}, required: [] },
  async execute() {
    return { success: true, content: 'ok' }
  },
}

// ============================================================
// PermissionSystem Tests
// ============================================================

describe('PermissionSystem', () => {
  describe('default level: auto', () => {
    const ps = new PermissionSystem('auto')

    it('auto tool does NOT need approval', () => {
      expect(ps.needsApproval(autoTool, {})).toBe(false)
    })

    // In auto mode, safety is handled by PreToolUse hooks.
    // The permission system bypasses all tools — even those with permission: 'ask'.
    it('ask tool does NOT need approval (hooks handle safety)', () => {
      expect(ps.needsApproval(askTool, {})).toBe(false)
    })

    it('bypass tool does NOT need approval', () => {
      expect(ps.needsApproval(bypassTool, {})).toBe(false)
      expect(ps.isBypassed(bypassTool, {})).toBe(true)
    })

    it('all tools bypass in auto mode', () => {
      expect(ps.check(autoTool, {})).toBe('bypass')
    })

    it('even ask tools bypass in auto mode', () => {
      expect(ps.check(askTool, {})).toBe('bypass')
    })
  })

  describe('default level: ask', () => {
    const ps = new PermissionSystem('ask')

    it('tool permission takes precedence over default level', () => {
      // Tool-level 'auto' still wins over constructor default 'ask'
      expect(ps.check(autoTool, {})).toBe('auto')
      expect(ps.needsApproval(autoTool, {})).toBe(false)
      // Tool-level 'ask' still needs approval
      expect(ps.needsApproval(askTool, {})).toBe(true)
    })
  })

  describe('default level: bypass', () => {
    const ps = new PermissionSystem('bypass')

    it('tool permission takes precedence over default level', () => {
      // Tool-level permissions still respected even with bypass default
      expect(ps.check(autoTool, {})).toBe('auto')
      expect(ps.needsApproval(autoTool, {})).toBe(false)
      expect(ps.needsApproval(askTool, {})).toBe(true)
      expect(ps.isBypassed(bypassTool, {})).toBe(true)
    })
  })

  describe('per-tool rule overrides', () => {
    it('tool rule overrides default level', () => {
      const ps = new PermissionSystem('default')
      // Make Bash (ask tool) bypass
      ps.setRule('Bash', 'bypass')
      expect(ps.needsApproval(askTool, {})).toBe(false)
      expect(ps.isBypassed(askTool, {})).toBe(true)
    })

    it('tool rule can be removed', () => {
      const ps = new PermissionSystem('default')
      ps.setRule('Bash', 'bypass')
      expect(ps.needsApproval(askTool, {})).toBe(false)

      ps.removeRule('Bash')
      expect(ps.needsApproval(askTool, {})).toBe(true)
    })

    it('rule for one tool does not affect others', () => {
      const ps = new PermissionSystem('auto')
      ps.setRule('Bash', 'bypass')
      expect(ps.needsApproval(askTool, {})).toBe(false) // overridden
      expect(ps.needsApproval(autoTool, {})).toBe(false) // unchanged
    })
  })

  describe('listRules', () => {
    it('returns a copy of rules map', () => {
      const ps = new PermissionSystem('auto')
      ps.setRule('Bash', 'bypass')
      ps.setRule('Edit', 'ask')

      const rules = ps.listRules()
      expect(rules.get('Bash')).toBe('bypass')
      expect(rules.get('Edit')).toBe('ask')
      expect(rules.size).toBe(2)
    })

    it('modifying returned map does not affect original', () => {
      const ps = new PermissionSystem('auto')
      const rules = ps.listRules()
      rules.set('Fake', 'bypass')
      expect(ps.listRules().has('Fake')).toBe(false)
    })
  })

  describe('getByCategory', () => {
    it('filters tools by category', () => {
      const ps = new PermissionSystem('auto')
      const tools = new Map<string, ToolDefinition>()
      tools.set('Read', autoTool)
      tools.set('Bash', askTool)
      tools.set('Debug', bypassTool)

      const fileTools = ps.getByCategory(tools, 'file')
      expect(fileTools).toHaveLength(1)
      expect(fileTools[0]!.name).toBe('Read')

      const execTools = ps.getByCategory(tools, 'exec')
      expect(execTools).toHaveLength(1)
      expect(execTools[0]!.name).toBe('Bash')
    })
  })
})
