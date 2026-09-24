import { describe, it, expect, vi, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { StreamChunk, ToolDefinition } from '../../src/shared/index.ts'
import { QueryEngine } from '../../src/core/engine'
import { ContextManager } from '../../src/core/context'
import { ProviderRegistry } from '../../src/providers/registry'

/**
 * A session whose working directory was deleted while it was running.
 *
 * Every tool call is handed that directory. Neither runtime flags the condition
 * on its own — Node throws from `process.cwd()` deeper in, Bun hands back the
 * path it cached at startup — so the tool receives a directory that is gone and
 * fails at its first syscall naming whatever it touched first: a shell spawn
 * reports `spawn /bin/sh ENOENT`, which blames the shell, not the directory.
 * The engine is the one place every tool call passes through, so it says what
 * actually happened instead.
 */

function mockTool(impl: () => Promise<{ success: boolean; content: string }>): ToolDefinition {
  return {
    name: 'probe',
    description: 'Tool: probe',
    category: 'system',
    permission: 'self',
    parameters: {},
    execute: impl,
  }
}

/** One tool call in the first round, then a plain stop — the tool runs once. */
function registryWithOneToolCall(counter: { chats: number }): ProviderRegistry {
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
      const n = counter.chats++
      if (n === 0) {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'probe', input: {} },
        }
      }
      yield { type: 'stop' as const }
    },
    listModels: async () => [],
    healthCheck: async () => true,
  })
  return registry
}

function engineWithProbe(ran: { count: number }, counter: { chats: number }): QueryEngine {
  return new QueryEngine(
    registryWithOneToolCall(counter),
    new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 }),
    new Map([
      ['probe', mockTool(async () => (ran.count++, { success: true, content: 'probe done' }))],
    ]),
  )
}

function conversationText(context: ContextManager): string {
  return context
    .getMessages()
    .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
    .join('\n')
}

describe('a tool call in a session whose working directory is gone', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is refused with the reason, rather than run against a directory that is not there', async () => {
    vi.spyOn(process, 'cwd').mockReturnValue(join(tmpdir(), 'mipham-engine-gone-cwd'))

    const ran = { count: 0 }
    const engine = engineWithProbe(ran, { chats: 0 })
    for await (const _ of engine.process('go')) {
      /* drain */
    }

    // The tool never ran — there is no directory to run it in.
    expect(ran.count).toBe(0)
    // And the reason reached the model, which is the only party that can tell
    // the operator to restart from somewhere that exists.
    const text = conversationText(engine.getContext())
    expect(text).toContain('no longer exists')
    expect(text).toContain('restarted from a directory that exists')
  })

  it('still runs the same tool when the directory is there', async () => {
    const ran = { count: 0 }
    const engine = engineWithProbe(ran, { chats: 0 })
    for await (const _ of engine.process('go')) {
      /* drain */
    }

    // The control: the guard is a check, not a blanket refusal.
    expect(ran.count).toBe(1)
    expect(conversationText(engine.getContext())).not.toContain('no longer exists')
  })
})
