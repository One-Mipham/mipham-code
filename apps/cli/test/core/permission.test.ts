import { describe, it, expect } from 'vitest'
import type { ToolDefinition } from '@mipham/shared'
import { PermissionSystem } from '../../src/core/permission'

// ── Helpers ──

function makeTool(
  name: string,
  permission: ToolDefinition['permission'] = 'auto',
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
    const tool = makeTool('read', 'auto')

    expect(ps.check(tool, {})).toBe('auto')
  })

  it('should respect defaultLevel in constructor', () => {
    const ps = new PermissionSystem('ask')
    const tool = makeTool('read', 'auto')

    // Tool default is 'auto', but no rules → returns tool default (not constructor default)
    expect(ps.check(tool, {})).toBe('auto')
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
    const tool = makeTool('read', 'auto')

    ps.setRule('read', 'ask')
    expect(ps.check(tool, {})).toBe('ask')
  })

  it('should allow rule to escalate from auto to ask', () => {
    const ps = new PermissionSystem()
    const tool = makeTool('read', 'auto')

    ps.setRule('read', 'ask')
    expect(ps.check(tool, {})).toBe('ask')
  })

  it('should allow rule to downgrade from ask to auto', () => {
    const ps = new PermissionSystem()
    const tool = makeTool('write', 'ask')

    ps.setRule('write', 'auto')
    expect(ps.check(tool, {})).toBe('auto')
  })

  it('should remove rule and fall back to tool default', () => {
    const ps = new PermissionSystem()
    const tool = makeTool('read', 'auto')

    ps.setRule('read', 'ask')
    ps.removeRule('read')
    expect(ps.check(tool, {})).toBe('auto')
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
    const tool = makeTool('read', 'auto')

    expect(ps.needsApproval(tool, {})).toBe(false)
  })

  it('should reflect rule override in needsApproval', () => {
    const ps = new PermissionSystem()
    const tool = makeTool('read', 'auto')

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
    const tool = makeTool('read', 'auto')

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
    rules.set('read', 'auto')
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
      ['read', makeTool('read', 'auto', 'file')],
      ['write', makeTool('write', 'ask', 'file')],
      ['bash', makeTool('bash', 'ask', 'exec')],
      ['git', makeTool('git', 'auto', 'exec')],
    ])

    const fileTools = ps.getByCategory(tools, 'file')
    expect(fileTools).toHaveLength(2)
    expect(fileTools.map((t) => t.name)).toContain('read')
    expect(fileTools.map((t) => t.name)).toContain('write')
  })

  it('should apply rule overrides in category results', () => {
    const ps = new PermissionSystem()
    ps.setRule('read', 'ask')
    const tools = new Map<string, ToolDefinition>([['read', makeTool('read', 'auto', 'file')]])

    const results = ps.getByCategory(tools, 'file')
    expect(results[0]!.level).toBe('ask') // overridden
  })

  it('should return empty array for category with no matches', () => {
    const ps = new PermissionSystem()
    const tools = new Map<string, ToolDefinition>([['read', makeTool('read', 'auto', 'file')]])

    expect(ps.getByCategory(tools, 'network')).toHaveLength(0)
  })

  // ═══════════════════════════════════════════
  // Tier 2: 6-mode refactored PermissionSystem
  // ═══════════════════════════════════════════

  it('cycles through all 6 modes', () => {
    const ps = new PermissionSystem('default')
    expect(ps.getMode()).toBe('default')
    ps.cycleMode()
    expect(ps.getMode()).toBe('acceptEdits')
    ps.cycleMode() // plan
    ps.cycleMode() // auto
    ps.cycleMode() // dontAsk
    ps.cycleMode() // bypassPermissions
    ps.cycleMode() // back to default
    expect(ps.getMode()).toBe('default')
  })

  it('deny rule blocks even when mode is bypassPermissions', () => {
    const ps = new PermissionSystem('bypassPermissions')
    ps.deny('Bash(rm -rf *)')
    const tool = makeTool('Bash', 'auto', 'exec')
    expect(ps.needsApproval(tool, { command: 'rm -rf /' })).toBe(true)
  })

  it('allow rule permits in dontAsk mode', () => {
    const ps = new PermissionSystem('dontAsk')
    ps.allow('Read')
    const tool = makeTool('Read', 'auto', 'file')
    expect(ps.isBypassed(tool, {})).toBe(true)
  })

  it('dontAsk mode blocks non-allowlisted tools', () => {
    const ps = new PermissionSystem('dontAsk')
    const tool = makeTool('Bash', 'auto', 'exec')
    expect(ps.needsApproval(tool, { command: 'ls' })).toBe(true)
  })

  it('plan mode allows reads only', () => {
    const ps = new PermissionSystem('plan')
    const readTool = makeTool('Read', 'auto', 'file')
    const bashTool = makeTool('Bash', 'auto', 'exec')
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
    const gitTool = makeTool('Bash', 'auto', 'exec')
    expect(ps.isBypassed(gitTool, { command: 'git status' })).toBe(true)
    expect(ps.needsApproval(gitTool, { command: 'rm -rf /' })).toBe(true)
  })
})
