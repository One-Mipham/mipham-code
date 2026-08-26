import { describe, it, expect, vi, afterEach } from 'vitest'
import { scheduleWakeupTool } from '../../../src/tools/scheduling/schedule-wakeup'
import { QueryEngine } from '../../../src/core/engine'
import { ProviderRegistry } from '../../../src/providers/registry'
import { ContextManager } from '../../../src/core/context'
import type { ToolDefinition } from '../../../src/shared/index.ts'

// Minimal fixture — mirror test/core/engine-loop.test.ts (do NOT import across test files).
function makeTestEngine(): QueryEngine {
  const registry = new ProviderRegistry([], 'good', 'good-model')
  const context = new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 })
  const tools = new Map<string, ToolDefinition>()
  return new QueryEngine(registry, context, tools)
}

const ctx = { sessionId: 'test-session' } as never // only ctx.sessionId is read by execute

afterEach(() => {
  vi.useRealTimers()
})

it('fixed-interval /loop re-invokes across two wakeups', async () => {
  vi.useFakeTimers()
  const engine = makeTestEngine() // constructor registers registerWakeupHandler -> this.enqueueWakeup

  // Round 1: the loop turn schedules a wakeup
  await scheduleWakeupTool.execute({ delaySeconds: 60, prompt: 'poll', reason: 'test' }, ctx)
  expect(engine.hasPendingWakeup()).toBe(false) // timer not yet fired
  vi.advanceTimersByTime(60_000)
  expect(engine.hasPendingWakeup()).toBe(true)
  expect(engine.dequeueWakeup()?.prompt).toBe('poll')
  expect(engine.hasPendingWakeup()).toBe(false)

  // Round 2: after draining, the next turn schedules again -> second wakeup re-enqueues
  await scheduleWakeupTool.execute({ delaySeconds: 60, prompt: 'poll-2', reason: 'test' }, ctx)
  vi.advanceTimersByTime(60_000)
  expect(engine.dequeueWakeup()?.prompt).toBe('poll-2')
})
