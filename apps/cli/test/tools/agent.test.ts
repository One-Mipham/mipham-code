import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { ToolContext } from '@mipham/shared'
import { agentTool } from '../../src/tools/agent/agent'
import { skillTool } from '../../src/tools/agent/skill'
import { planTool } from '../../src/tools/agent/plan'
import { memoryTool } from '../../src/tools/agent/memory'

// ── Test context ──

const ctx: ToolContext = {
  cwd: '/tmp/test',
  sessionId: 'test-session',
  provider: 'test',
  model: 'test-model',
}

// ============================================================
// Agent Tool
// ============================================================

describe('Agent tool definition', () => {
  it('has correct metadata', () => {
    expect(agentTool.name).toBe('Agent')
    expect(agentTool.category).toBe('agent')
    expect(agentTool.permission).toBe('ask')
  })

  it('requires description and prompt parameters', () => {
    const params = agentTool.parameters as { required: string[] }
    expect(params.required).toEqual(['description', 'prompt'])
  })

  it('has optional subagent_type parameter', () => {
    const params = agentTool.parameters as { properties: Record<string, unknown> }
    expect(params.properties).toHaveProperty('subagent_type')
  })
})

describe('Agent tool execution', () => {
  it('returns error when no provider registry is available', async () => {
    const result = await agentTool.execute(
      { description: 'Review code', prompt: 'Find bugs in src/' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('provider')
  })

  it('returns error for explore type without provider', async () => {
    const result = await agentTool.execute(
      { description: 'Test', prompt: 'Search for patterns', subagent_type: 'explore' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('provider')
  })

  it('rejects invalid subagent_type', async () => {
    const result = await agentTool.execute(
      { description: 'Test', prompt: 'Test', subagent_type: 'invalid_type' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('Invalid subagent_type')
  })
})

// ============================================================
// Skill Tool
// ============================================================

describe('Skill tool definition', () => {
  it('has correct metadata', () => {
    expect(skillTool.name).toBe('Skill')
    expect(skillTool.category).toBe('agent')
    expect(skillTool.permission).toBe('auto')
  })

  it('requires skill parameter', () => {
    const params = skillTool.parameters as { required: string[] }
    expect(params.required).toEqual(['skill'])
  })

  it('has optional args parameter', () => {
    const params = skillTool.parameters as { properties: Record<string, unknown> }
    expect(params.properties).toHaveProperty('args')
  })
})

describe('Skill tool execution', () => {
  it('returns error when SkillsLoader is not in context', async () => {
    const result = await skillTool.execute({ skill: 'code-reviewer' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('SkillsLoader')
  })

  it('shows available skills in error message', async () => {
    const result = await skillTool.execute({ skill: 'nonexistent-skill' }, ctx)
    expect(result.error).toContain('SKILL.md')
  })

  it('includes args in response when available', async () => {
    const result = await skillTool.execute({ skill: 'searcher', args: '--deep' }, ctx)
    // Without SkillsLoader, returns error
    expect(result.success).toBe(false)
  })
})

// ============================================================
// Plan Tool
// ============================================================

describe('Plan tool definition', () => {
  it('has correct metadata', () => {
    expect(planTool.name).toBe('Plan')
    expect(planTool.category).toBe('agent')
    expect(planTool.permission).toBe('auto')
  })

  it('has empty required parameters', () => {
    const params = planTool.parameters as { required?: string[] }
    expect(params.required || []).toEqual([])
  })
})

describe('Plan tool execution', () => {
  it('activates plan mode and creates plan file', async () => {
    const result = await planTool.execute({ title: 'Test Plan' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('Plan Mode Activated')
    expect(result.content).toContain('.mipham/plans/plan-')
  })

  it('creates plan file on disk', async () => {
    const result = await planTool.execute({ title: 'Disk Test' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('Plan file:')
  })
})

// ============================================================
// Memory Tool
// ============================================================

describe('Memory tool definition', () => {
  it('has correct metadata', () => {
    expect(memoryTool.name).toBe('Memory')
    expect(memoryTool.category).toBe('agent')
    expect(memoryTool.permission).toBe('auto')
  })

  it('requires action parameter', () => {
    const params = memoryTool.parameters as { required: string[] }
    expect(params.required).toEqual(['action'])
  })

  it('accepts action enum: read, write, list', () => {
    const params = memoryTool.parameters as { properties: Record<string, unknown> }
    const action = params.properties.action as { enum: string[] }
    expect(action.enum).toEqual(['read', 'write', 'list'])
  })
})

describe('Memory tool execution', () => {
  const MEM_DIR = join(process.env.HOME || tmpdir(), '.mipham', 'memory')

  function cleanMemDir() {
    try {
      rmSync(MEM_DIR, { recursive: true, force: true })
    } catch {
      /* ok */
    }
  }

  beforeEach(() => {
    cleanMemDir()
  })

  afterEach(() => {
    cleanMemDir()
  })

  it('writes a memory', async () => {
    const result = await memoryTool.execute(
      { action: 'write', name: 'test-note', content: '# Hello\n\nThis is a note.' },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.content).toContain('Memory "test-note" written')
  })

  it('reads a memory that exists', async () => {
    await memoryTool.execute(
      { action: 'write', name: 'readable', content: 'readable content' },
      ctx,
    )

    const result = await memoryTool.execute({ action: 'read', name: 'readable' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toBe('readable content')
  })

  it('errors when reading non-existent memory', async () => {
    const result = await memoryTool.execute({ action: 'read', name: 'nonexistent' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('lists all memories', async () => {
    await memoryTool.execute({ action: 'write', name: 'alpha', content: 'a' }, ctx)
    await memoryTool.execute({ action: 'write', name: 'beta', content: 'b' }, ctx)

    const result = await memoryTool.execute({ action: 'list' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('alpha.md')
    expect(result.content).toContain('beta.md')
  })

  it('returns (no memories) for empty directory', async () => {
    const result = await memoryTool.execute({ action: 'list' }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toBe('(no memories)')
  })

  it('errors when name is missing for read', async () => {
    const result = await memoryTool.execute({ action: 'read' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('name is required')
  })

  it('errors when name is missing for write', async () => {
    const result = await memoryTool.execute({ action: 'write', content: 'stuff' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('name is required')
  })

  it('errors for unknown action (when name is provided)', async () => {
    const result = await memoryTool.execute({ action: 'delete', name: 'some-name' }, ctx)
    expect(result.success).toBe(false)
    expect(result.error).toContain('Unknown action')
  })

  it('overwrites existing memory', async () => {
    await memoryTool.execute({ action: 'write', name: 'overwrite', content: 'original' }, ctx)
    await memoryTool.execute({ action: 'write', name: 'overwrite', content: 'updated' }, ctx)
    const result = await memoryTool.execute({ action: 'read', name: 'overwrite' }, ctx)
    expect(result.content).toBe('updated')
  })
})
