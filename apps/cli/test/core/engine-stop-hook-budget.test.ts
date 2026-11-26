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

  it('caps a huge block reason fed back into the conversation', async () => {
    // "Do not stop yet" + a whole log attached used to be injected verbatim —
    // the very context the turn is trying to keep under its limit.
    const hooks = new HookEngine()
    let n = 0
    hooks.register({
      event: 'Stop',
      handler: async () => {
        n++
        return n === 1 ? { allowed: false, reason: 'R'.repeat(50_000) } : { allowed: true }
      },
    })
    const context = new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 })
    const engine = new QueryEngine(registryCounting({ chats: 0 }), context, new Map())
    engine.setHookEngine(hooks)

    await collect(engine.process('go'))

    const injected = context
      .getMessages()
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .find((t) => t.includes('truncated'))
    expect(injected, '截断标记应出现在回灌的 block 文本里').toBeDefined()
    expect(injected!.length).toBeLessThan(11_000)
  })
})

// A hook's `systemMessage` is addressed to the operator, not the model. It was
// parsed nowhere; these pin the two events that have a live user channel.
describe('hook systemMessage reaches the operator', () => {
  function engineWithHook(
    event: 'Stop' | 'UserPromptSubmit',
    result: { allowed: boolean; systemMessage?: string; reason?: string },
  ): QueryEngine {
    const hooks = new HookEngine()
    hooks.register({ event, handler: async () => result })
    const engine = new QueryEngine(
      registryCounting({ chats: 0 }),
      new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 }),
      new Map(),
    )
    engine.setHookEngine(hooks)
    return engine
  }

  it('UserPromptSubmit systemMessage is yielded as a warning', async () => {
    const chunks = await collect(
      engineWithHook('UserPromptSubmit', {
        allowed: true,
        systemMessage: 'context loaded',
      }).process('go'),
    )
    expect(chunks.some((c) => c.type === 'warning' && c.content === 'context loaded')).toBe(true)
  })

  it('Stop systemMessage is yielded even when the hook allows stopping', async () => {
    const chunks = await collect(
      engineWithHook('Stop', { allowed: true, systemMessage: 'remember to commit' }).process('go'),
    )
    expect(chunks.some((c) => c.type === 'warning' && c.content === 'remember to commit')).toBe(
      true,
    )
  })

  it('negative control: a hook without systemMessage yields no such warning', async () => {
    const chunks = await collect(
      engineWithHook('UserPromptSubmit', { allowed: true }).process('go'),
    )
    expect(chunks.filter((c) => c.type === 'warning')).toHaveLength(0)
  })
})

describe('Stop fires when the tool-round budget is already spent', () => {
  it('entering the loop with zero rounds still runs the Stop hook', async () => {
    const hooks = new HookEngine()
    hooks.register({
      event: 'Stop',
      handler: async () => ({ allowed: true, systemMessage: 'budget path reached' }),
    })
    const engine = new QueryEngine(
      registryCounting({ chats: 0 }),
      new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 }),
      new Map(),
    )
    engine.setHookEngine(hooks)

    // This is the terminal branch a 100-round tool loop used to return from in
    // silence — the hook was never told the turn had ended.
    const chunks = await collect(
      (
        engine as unknown as {
          continueWithTools: (s?: AbortSignal, r?: number) => AsyncGenerator<StreamChunk>
        }
      ).continueWithTools(undefined, 0),
    )
    expect(chunks.some((c) => c.type === 'warning' && c.content === 'budget path reached')).toBe(
      true,
    )
  })

  it('a blocking hook there is told the budget is spent instead of being ignored', async () => {
    const hooks = new HookEngine()
    hooks.register({
      event: 'Stop',
      handler: async () => ({ allowed: false, reason: 'keep going' }),
    })
    const engine = new QueryEngine(
      registryCounting({ chats: 0 }),
      new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 }),
      new Map(),
    )
    engine.setHookEngine(hooks)

    const chunks = await collect(
      (
        engine as unknown as {
          continueWithTools: (s?: AbortSignal, r?: number) => AsyncGenerator<StreamChunk>
        }
      ).continueWithTools(undefined, 0),
    )
    expect(chunks.some((c) => c.type === 'warning' && c.content?.includes('keep going'))).toBe(true)
  })
})
