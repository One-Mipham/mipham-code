// apps/cli/test/agent/agent-context.test.ts
import { describe, it, expect } from 'vitest'
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
    permission: 'auto',
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
