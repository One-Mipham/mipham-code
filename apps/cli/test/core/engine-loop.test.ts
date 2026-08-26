import { describe, it, expect, vi, afterEach } from 'vitest'
import type { StreamChunk, ToolDefinition } from '../../src/shared/index.ts'
import { QueryEngine } from '../../src/core/engine'
import { ContextManager } from '../../src/core/context'
import { ProviderRegistry } from '../../src/providers/registry'
import { scheduleWakeupTool } from '../../src/tools/scheduling/schedule-wakeup'

// ── Helpers (minimal fixture — queue methods don't touch the provider) ──

function mockProviderRegistry() {
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
    chat: async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text' as const, content: 'Hello!' }
      yield { type: 'stop' as const }
    },
    listModels: async () => [],
    healthCheck: async () => true,
  })
  return registry
}

function mockContext(): ContextManager {
  return new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 })
}

function makeToolMap(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  const map = new Map<string, ToolDefinition>()
  for (const t of tools) map.set(t.name, t)
  return map
}

function makeTestEngine(): QueryEngine {
  return new QueryEngine(mockProviderRegistry(), mockContext(), makeToolMap([]))
}

// ── Tests ──

describe('QueryEngine — wakeup queue', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('enqueue/dequeue/hasPending round-trips wakeup prompts (keep latest)', () => {
    const engine = makeTestEngine()
    expect(engine.hasPendingWakeup()).toBe(false)
    engine.enqueueWakeup('loop-prompt-A')
    engine.enqueueWakeup('loop-prompt-B') // A 被丢弃（只保留最新，spec §七）
    expect(engine.hasPendingWakeup()).toBe(true)
    expect(engine.dequeueWakeup()?.prompt).toBe('loop-prompt-B')
    expect(engine.dequeueWakeup()).toBeNull()
  })

  it('enqueueWakeup keeps only the latest pending prompt', () => {
    const engine = makeTestEngine()
    engine.enqueueWakeup('first')
    engine.enqueueWakeup('second')
    engine.enqueueWakeup('third')
    expect(engine.dequeueWakeup()?.prompt).toBe('third')
    expect(engine.hasPendingWakeup()).toBe(false)
  })

  it('constructor registers a handler that enqueues the wakeup prompt when the timer fires', async () => {
    vi.useFakeTimers()
    // Constructing the engine overwrites the module-level handler singleton to
    // point at this engine's enqueueWakeup (one engine per test — by design).
    const engine = makeTestEngine()

    await scheduleWakeupTool.execute(
      { delaySeconds: 60, prompt: 'loop-prompt-timer', reason: 'test' },
      { sessionId: 'test-session' } as never,
    )

    expect(engine.hasPendingWakeup()).toBe(false) // timer hasn't fired yet

    vi.advanceTimersByTime(60 * 1000)

    expect(engine.hasPendingWakeup()).toBe(true)
    expect(engine.dequeueWakeup()?.prompt).toBe('loop-prompt-timer')
    expect(engine.hasPendingWakeup()).toBe(false)
  })

  it('enqueueWakeup invokes the registered onWakeupEnqueued callback', () => {
    const engine = makeTestEngine()
    const fn = vi.fn()
    engine.setOnWakeupEnqueued(fn)
    engine.enqueueWakeup('loop-prompt')
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('clearWakeupQueue empties the pending wakeup queue', () => {
    const engine = makeTestEngine()
    engine.enqueueWakeup('loop-prompt')
    expect(engine.hasPendingWakeup()).toBe(true)
    engine.clearWakeupQueue()
    expect(engine.hasPendingWakeup()).toBe(false)
  })
})
