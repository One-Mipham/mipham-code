import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { QueryEngine } from '../../src/core/engine'
import { ContextManager } from '../../src/core/context'
import { ProviderRegistry } from '../../src/providers/registry'
import { SubAgent } from '../../src/agent/sub-agent'
import { getMetrics, resetMetrics } from '../../src/core/metrics'
import type { StreamChunk, ToolDefinition } from '../../src/shared/index.ts'

/**
 * There are two ways a tool gets run, and they share no code:
 *
 *   A. `Engine.executeTool`   — the main funnel; has counted `toolCalls` for a while
 *   B. `SubAgent`'s tool loop — calls `tool.execute` directly, reimplementing the
 *                               hook and permission steps, and counted nothing
 *
 * Workflows derive sub-agents, so path B is not an exotic corner: without a
 * counter there, every tool call made by a sub-agent or a workflow is invisible.
 * The repo has recorded this exact failure shape twice ("two render paths, one
 * wired" in v0.60.1; the `rules-loader` seam), so the guard here is not "does B
 * count something" but "do A and B produce the *same* measurement".
 */

const TOOL = 'Bash'

function toolSpy(): { tool: ToolDefinition; calls: () => number } {
  let n = 0
  return {
    calls: () => n,
    tool: {
      name: TOOL,
      description: 'test tool',
      category: 'exec',
      permission: 'self',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        n++
        return { success: true, content: 'ok' }
      },
    },
  }
}

/** A provider that emits one tool_use, then a text turn, then stops. */
function oneToolCall(): ProviderRegistry {
  const registry = new ProviderRegistry(
    [{ id: 'test', name: 'Test', protocol: 'openai-compatible', apiKey: 'key', models: [] }],
    'test',
    'test-model',
  )
  let turn = 0
  registry.register('test', {
    config: {
      id: 'test',
      name: 'Test',
      protocol: 'openai-compatible' as const,
      apiKey: 'key',
      models: [],
    },
    chat: async function* (): AsyncGenerator<StreamChunk> {
      if (turn++ === 0) {
        yield {
          type: 'tool_use' as const,
          toolUse: { type: 'tool_use', id: 'c1', name: TOOL, input: {} },
        }
      } else {
        yield { type: 'text' as const, content: 'done' }
      }
      yield { type: 'stop' as const }
    },
    listModels: async () => [],
    healthCheck: async () => true,
  })
  return registry
}

/**
 * Labelled series only. The registry also keeps an unlabelled series at zero;
 * including it would make every expectation read as noise.
 */
function toolCallSeries(): Record<string, number> {
  const json = getMetrics().toolCalls.toJSON() as {
    series: Array<{ labels: string; value: number }>
  }
  const out: Record<string, number> = {}
  for (const s of json.series) {
    if (s.labels) out[s.labels] = s.value
  }
  return out
}

const BASH = '{tool_name="Bash"}'

beforeEach(() => resetMetrics())
afterEach(() => resetMetrics())

describe('tool counting — both execution paths measure the same thing', () => {
  it('path A: the engine funnel counts one call, under the tool-name label', async () => {
    const { tool, calls } = toolSpy()
    const tools = new Map([[TOOL, tool]])
    const engine = new QueryEngine(
      oneToolCall(),
      new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 }),
      tools,
    )

    for await (const _ of engine.process('run the tool')) {
      /* drain */
    }

    expect(calls()).toBe(1)
    expect(toolCallSeries()).toEqual({ [BASH]: 1 })
  })

  it('path B: a sub-agent counts one call, under the identical label', async () => {
    const { tool, calls } = toolSpy()
    const tools = new Map([[TOOL, tool]])
    const sub = new SubAgent(oneToolCall(), tools)

    await sub.execute('run the tool', 'task', { type: 'general' })

    expect(calls()).toBe(1)
    // The label is the whole point: a different key here would land in a
    // second series and silently halve every tool's reported usage.
    expect(toolCallSeries()).toEqual({ [BASH]: 1 })
  })

  it('counts once per invocation, not once per path traversal', async () => {
    // Double counting would be as wrong as no counting, and is the likelier
    // mistake when a counter is added to a loop that may retry.
    const { tool } = toolSpy()
    const tools = new Map([[TOOL, tool]])
    const sub = new SubAgent(oneToolCall(), tools)

    await sub.execute('run the tool', 'task', { type: 'general' })

    expect(toolCallSeries()[BASH]).toBe(1)
  })
})
