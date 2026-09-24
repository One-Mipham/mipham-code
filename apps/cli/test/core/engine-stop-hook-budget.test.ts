import { describe, it, expect } from 'vitest'
import type { StreamChunk } from '../../src/shared/index.ts'
import { QueryEngine } from '../../src/core/engine'
import { ContextManager } from '../../src/core/context'
import { HookEngine } from '../../src/core/hooks'
import { ProviderRegistry } from '../../src/providers/registry'

/**
 * The tool-round cap is a cap on the *turn*.
 *
 * A Stop hook that blocks buys another round — but the continuation re-entered the
 * loop with a fresh budget every time, so the cap bounded one loop invocation and
 * not the turn. A hook that always asks for more (its condition is not met and the
 * model cannot meet it) ran the turn without bound: each cycle cost at least one
 * provider call and nothing ever ended it.
 */

const MAX_TOOL_TURNS = 100

function registryCounting(counter: { chats: number }): ProviderRegistry {
  const registry = new ProviderRegistry(
    [{ id: 'test', name: 'Test', protocol: 'openai-compatible', apiKey: 'key', models: [] }],
    'test',
    'test-model',
  )
  registry.register('test', {
    config: {
      id: 'test',
      name: 'Test',
      protocol: 'openai-compatible' as const,
      apiKey: 'key',
      models: [],
    },
    // Each round answers and stops with no tool calls — the shape a Stop hook
    // loops on. The throw is the harness's own bound: without it a runaway turn
    // runs until the test times out instead of failing with a number.
    chat: async function* () {
      counter.chats++
      if (counter.chats > MAX_TOOL_TURNS * 4) {
        throw new Error('runaway turn: the cap did not apply')
      }
      yield { type: 'text' as const, content: 'done' }
      yield { type: 'stop' as const }
    },
    listModels: async () => [],
    healthCheck: async () => true,
  })
  return registry
}

function engineWithStopHook(counter: { chats: number }, answers: boolean[]): QueryEngine {
  const hooks = new HookEngine()
  let n = 0
  hooks.register({
    event: 'Stop',
    handler: async () => {
      const allow = answers[n] ?? answers[answers.length - 1] ?? true
      n++
      return allow ? { allowed: true } : { allowed: false, reason: 'not done yet' }
    },
  })
  const engine = new QueryEngine(
    registryCounting(counter),
    new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 }),
    new Map(),
  )
  engine.setHookEngine(hooks)
  return engine
}

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of gen) chunks.push(chunk)
  return chunks
}

describe('a Stop hook that keeps asking for more', () => {
  it('cannot run the turn without bound', async () => {
    const counter = { chats: 0 }
    const chunks = await collect(engineWithStopHook(counter, [false]).process('go'))

    // The hook is honored — the turn continues — but only inside the cap.
    expect(counter.chats).toBeGreaterThan(1)
    expect(counter.chats).toBeLessThanOrEqual(MAX_TOOL_TURNS)
    // And the operator is told the hook's wish could not be honored — the hook's
    // own reason is what distinguishes that notice from any other warning.
    const notices = chunks.filter((c) => c.type === 'warning')
    expect(notices).toHaveLength(1)
    expect(notices[0]!.content).toContain('not done yet')
    expect(notices[0]!.content).not.toBe('errors.stop_hook_budget_spent')
  })

  it('still lets a hook that asks once continue the turn', async () => {
    const counter = { chats: 0 }
    const chunks = await collect(engineWithStopHook(counter, [false, true]).process('go'))

    // One continuation, no cap notice: bounding the turn must not neuter hooks.
    expect(counter.chats).toBe(2)
    expect(chunks.filter((c) => c.type === 'warning')).toHaveLength(0)
  })
})
