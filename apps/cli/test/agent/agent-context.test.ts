// apps/cli/test/agent/agent-context.test.ts
import { describe, it, expect, vi } from 'vitest'
import { createAgentContext } from '../../src/agent/agent-context'
import type { AgentDefinition } from '../../src/agent/types'
import type { ToolDefinition } from '../../src/shared/index.ts'

function makeAgent(): AgentDefinition {
  return {
    name: 'test-agent',
    description: '',
    systemPrompt: 'You are a test agent.',
    model: 'inherit',
    permissionMode: 'inherit',
    source: 'builtin',
  }
}

function makeTools(): Map<string, ToolDefinition> {
  const read: ToolDefinition = {
    name: 'read',
    description: 'Read a file',
    category: 'file',
    permission: 'self',
    parameters: {},
    execute: async () => ({ success: true, content: '' }),
  }
  return new Map([['read', read]])
}

describe('createAgentContext', () => {
  it('sizes the context to the model window and enables adaptive thresholds', () => {
    const { context } = createAgentContext(makeAgent(), makeTools(), 1_000_000)
    expect(context.getMaxTokens()).toBe(1_000_000)
    // 1 - 50_000/1_000_000 = 0.95 (adaptive threshold for a 1M window)
    expect(context.getCompactionThreshold()).toBe(0.95)
  })

  it('falls back to 100K with no adaptive thresholds when the window is omitted', () => {
    const { context } = createAgentContext(makeAgent(), makeTools())
    expect(context.getMaxTokens()).toBe(100_000)
    expect(context.getCompactionThreshold()).toBe(0.85)
  })
})

describe('createAgentContext tool scoping', () => {
  function mcpTools(): Map<string, ToolDefinition> {
    const tools = makeTools()
    for (const name of [
      'mcp__forge__search',
      'mcp__forge__write',
      'mcp__other__search',
      'mcp__forge2__search',
    ]) {
      tools.set(name, {
        name,
        description: '',
        category: 'network',
        permission: 'ask',
        parameters: {},
        execute: async () => ({ success: true, content: '' }),
      })
    }
    return tools
  }

  const names = (tools: { name: string }[]) => tools.map((t) => t.name).sort()

  it.each(['mcp__forge', 'mcp__forge__*'])(
    'expands whole-server rule %s to that server only',
    (rule) => {
      const agent = { ...makeAgent(), tools: `${rule}, read` }
      const { allowedTools } = createAgentContext(agent, mcpTools())
      expect(names(allowedTools)).toEqual(['mcp__forge__search', 'mcp__forge__write', 'read'])
    },
  )

  it('keeps a full MCP tool name exact', () => {
    const agent = { ...makeAgent(), tools: 'mcp__forge__search' }
    const { allowedTools } = createAgentContext(agent, mcpTools())
    expect(names(allowedTools)).toEqual(['mcp__forge__search'])
  })

  it('warns when a non-empty tools list matches nothing', () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const agent = { ...makeAgent(), tools: 'no-such-tool' }
      const { allowedTools } = createAgentContext(agent, mcpTools())
      expect(allowedTools).toHaveLength(0)
      expect(stderr.mock.calls.map(String).join('')).toContain('matched no registered tool')
    } finally {
      stderr.mockRestore()
    }
  })
})
