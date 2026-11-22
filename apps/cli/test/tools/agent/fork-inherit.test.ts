/**
 * CC 2.1.232: `subagent_type: "fork"` inherits the live conversation.
 *
 * `SubAgent` already had an `inheritContext` seam (used by `/fork`), but the
 * Agent tool never passed it — the advertised type would have behaved exactly
 * like `general`. These cases pin the wiring, not just the type name.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ToolContext } from '../../../src/shared'

const calls = vi.hoisted(
  () => [] as Array<{ prompt: string; description: string; options: Record<string, unknown> }>,
)

vi.mock('../../../src/agent/sub-agent', () => ({
  SubAgent: class {
    async execute(prompt: string, description: string, options: Record<string, unknown>) {
      calls.push({ prompt, description, options })
      return 'forked result'
    }
  },
}))

import { agentTool } from '../../../src/tools/agent/agent'

function ctxWith(parentMessages?: ToolContext['parentMessages']): ToolContext {
  return {
    cwd: '/tmp/fork-test',
    sessionId: 'fork-test-session',
    provider: 'test',
    model: 'test-model',
    registry: {} as ToolContext['registry'],
    toolRegistry: new Map(),
    parentMessages,
  }
}

const params = { description: 'continue the task', prompt: 'take it from here' }

describe('Agent tool — fork 继承当前会话', () => {
  beforeEach(() => {
    calls.length = 0
  })

  it('把父会话作为 inheritContext 传给子代理（传的是副本）', async () => {
    const parent = [{ role: 'user' as const, content: 'earlier turn' }]
    const result = await agentTool.execute({ ...params, subagent_type: 'fork' }, ctxWith(parent))

    expect(result.success).toBe(true)
    expect(calls).toHaveLength(1)
    const options = calls[0]!.options as { inheritContext?: { messages: unknown[] } }
    expect(options.inheritContext?.messages).toEqual(parent)
    // A live turn keeps appending to its own list; the fork must not share it.
    expect(options.inheritContext?.messages).not.toBe(parent)
  })

  it('没有会话可继承时拒绝，而不是静默按 general 跑', async () => {
    const result = await agentTool.execute({ ...params, subagent_type: 'fork' }, ctxWith())

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/requires an existing conversation/)
    expect(calls).toHaveLength(0)
  })

  it('非 fork 类型不携带 inheritContext', async () => {
    const result = await agentTool.execute(
      { ...params, subagent_type: 'general' },
      ctxWith([{ role: 'user', content: 'earlier turn' }]),
    )

    expect(result.success).toBe(true)
    const options = calls[0]!.options as { inheritContext?: unknown }
    expect(options.inheritContext).toBeUndefined()
  })
})
