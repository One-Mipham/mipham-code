import { describe, it, expect, vi, afterEach } from 'vitest'
import type { StreamChunk } from '../../src/shared/index.ts'
import { QueryEngine } from '../../src/core/engine'
import { ContextManager } from '../../src/core/context'
import { ProviderRegistry } from '../../src/providers/registry'

/**
 * The 15-minute stall guard has to be able to interrupt a round that is *in
 * flight*, not just notice one between rounds.
 *
 * It used to be a plain `if` at the top of the round loop, so it could only fire
 * after the previous round returned — never while a request was outstanding.
 * The only thing bounding a live request was the provider's own read timeout,
 * and that one measures socket silence (see
 * `test/providers/stream-stall-progress.test.ts` for how a chatty gateway
 * defeats it). Net effect: a turn could wait forever with nothing on screen.
 *
 * These probes hold the request open forever and then let the clock run. The
 * assertion is that the turn ends with a warning naming the wait — the turn
 * gives up on its own instead of waiting for the user to notice.
 */

const TURN_TIMEOUT_MS = 15 * 60 * 1000

function neverResolves(signal?: AbortSignal): Promise<never> {
  return new Promise<never>((_, reject) => {
    const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'))
    if (signal?.aborted) return abort()
    signal?.addEventListener('abort', abort)
  })
}

/** `hangsOnCall` is 1-based: the n-th chat call never produces a chunk. */
function registryThatHangs(hangsOnCall: number, toolName?: string): ProviderRegistry {
  const registry = new ProviderRegistry(
    [{ id: 'test', name: 'Test', protocol: 'openai-compatible', apiKey: 'key', models: [] }],
    'test',
    'test-model',
  )
  let calls = 0
  registry.register('test', {
    config: {
      id: 'test',
      name: 'Test',
      protocol: 'openai-compatible' as const,
      apiKey: 'key',
      models: [],
    },
    chat: async function* (req): AsyncGenerator<StreamChunk> {
      const n = ++calls
      if (n === hangsOnCall) {
        await neverResolves(req.signal)
        return
      }
      if (toolName) {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: `t${n}`, name: toolName, input: {} },
        }
      }
      yield { type: 'stop' }
    },
    listModels: async () => [],
    healthCheck: async () => true,
  })
  return registry
}

function engineWith(registry: ProviderRegistry): QueryEngine {
  return new QueryEngine(
    registry,
    new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 }),
    new Map(),
  )
}

/** Drive `gen` while fake time runs, and report what it produced. */
async function collectFor(
  gen: AsyncGenerator<StreamChunk>,
  windowMs: number,
): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  const done = (async () => {
    for await (const c of gen) chunks.push(c)
  })()
  await vi.advanceTimersByTimeAsync(windowMs)
  void done
  return chunks
}

describe('a round that never returns ends on the turn budget', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('the first request of a turn', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    })
    const chunks = await collectFor(
      engineWith(registryThatHangs(1)).process('go'),
      TURN_TIMEOUT_MS + 60_000,
    )

    const warnings = chunks.filter((c) => c.type === 'warning')
    expect(warnings.length).toBe(1)
    expect(warnings[0]!.content).toContain('15')
    expect(chunks.map((c) => c.type)).toContain('stop')
  })

  it('a continuation round after a tool call', async () => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'],
    })
    const chunks = await collectFor(
      engineWith(registryThatHangs(2, 'Noop')).process('go'),
      TURN_TIMEOUT_MS + 60_000,
    )

    const warnings = chunks.filter((c) => c.type === 'warning')
    expect(warnings.length).toBe(1)
    expect(warnings[0]!.content).toContain('15')
    expect(chunks.map((c) => c.type)).toContain('stop')
  })
})
