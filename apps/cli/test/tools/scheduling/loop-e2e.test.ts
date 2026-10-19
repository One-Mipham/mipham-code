import { it, expect, vi, afterEach } from 'vitest'
import {
  scheduleWakeupTool,
  cancelAllSessionTimers,
  unregisterWakeupHandler,
} from '../../../src/tools/scheduling/schedule-wakeup'
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
  for (const id of ['test-session', 'session-a', 'session-b']) {
    cancelAllSessionTimers(id)
    unregisterWakeupHandler(id)
  }
})

it('fixed-interval /loop re-invokes across two wakeups', async () => {
  vi.useFakeTimers()
  const engine = makeTestEngine()
  // Handlers are keyed by session: the engine must be on the same session the
  // tool is called for, or its wakeup would go to nobody (or to another engine).
  engine.setSessionId('test-session')

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

// The daemon builds one engine per session in a single process. The wakeup
// handler used to be a module-level singleton, so the engine built last got
// every session's wakeups — the loop prompt for session A landed in B.
it('two engines in one process each receive only their own session`s wakeup', async () => {
  vi.useFakeTimers()
  const engineA = makeTestEngine()
  engineA.setSessionId('session-a')
  const engineB = makeTestEngine()
  engineB.setSessionId('session-b')

  await scheduleWakeupTool.execute({ delaySeconds: 60, prompt: 'loop-a', reason: 'test' }, {
    sessionId: 'session-a',
  } as never)
  await scheduleWakeupTool.execute({ delaySeconds: 60, prompt: 'loop-b', reason: 'test' }, {
    sessionId: 'session-b',
  } as never)
  vi.advanceTimersByTime(60_000)

  expect(engineA.dequeueWakeup()?.prompt).toBe('loop-a')
  expect(engineB.dequeueWakeup()?.prompt).toBe('loop-b')
  expect(engineA.hasPendingWakeup()).toBe(false)
  expect(engineB.hasPendingWakeup()).toBe(false)
})
