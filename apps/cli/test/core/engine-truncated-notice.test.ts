import { describe, it, expect } from 'vitest'
import type { StreamChunk } from '../../src/shared/index.ts'
import { QueryEngine } from '../../src/core/engine'
import { ContextManager } from '../../src/core/context'
import { ProviderRegistry } from '../../src/providers/registry'

/**
 * A turn the provider cut short must not read like an answer.
 *
 * The provider states it — `chunk.truncated` on the terminal stop — but the engine
 * forwarded the chunk and said nothing, so a response cut off at the output ceiling
 * or by a proxy that closed the connection cleanly reached the user as an ordinary
 * finished reply. The provider is the only layer that can tell the two apart; the
 * engine is the only layer every consumer of a chat stream passes through.
 */

function registryWith(chat: () => AsyncGenerator<StreamChunk>): ProviderRegistry {
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
    chat,
    listModels: async () => [],
    healthCheck: async () => true,
  })
  return registry
}

function engineWith(chat: () => AsyncGenerator<StreamChunk>): QueryEngine {
  return new QueryEngine(
    registryWith(chat),
    new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 }),
    new Map(),
  )
}

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of gen) chunks.push(chunk)
  return chunks
}

const warnings = (chunks: StreamChunk[]) => chunks.filter((c) => c.type === 'warning')

describe('a turn the provider cut short', () => {
  it('is announced rather than shown as a finished answer', async () => {
    const engine = engineWith(async function* () {
      yield { type: 'text' as const, content: 'The answer begins here and then' }
      yield { type: 'stop' as const, truncated: true }
    })

    const chunks = await collect(engine.process('explain'))
    const notice = warnings(chunks)

    expect(notice).toHaveLength(1)
    // `t()` hands back the key itself when a locale lacks it, so "not empty" is
    // also what a forgotten translation would look like.
    expect(notice[0]!.content).toBeTruthy()
    expect(notice[0]!.content).not.toBe('errors.turn_truncated')
    // The notice has to arrive before the turn ends, not after it.
    expect(chunks.indexOf(notice[0]!)).toBeLessThan(chunks.length - 1)
  })

  it('says where to look first when the connection is the suspect', async () => {
    // 断流的原因一半在本地网络栈之外。只说「断了」把排查工作原样丢回给用户；
    // 代理/网关是第一顺位（它们会干净地关掉连接，看起来和输出上限一模一样），
    // VPN 与防火墙是第二顺位。
    const engine = engineWith(async function* () {
      yield { type: 'text' as const, content: 'partial' }
      yield { type: 'stop' as const, truncated: true }
    })

    const notice = warnings(await collect(engine.process('explain')))
    expect(notice[0]!.content).toMatch(/proxy|gateway/i)
    expect(notice[0]!.content).toMatch(/VPN|firewall/i)
  })

  it('is announced once even when a plain stop follows it', async () => {
    // OpenAI-compatible providers emit the truncated stop at `finish_reason: length`
    // and a second, bare stop at `[DONE]`. Only the first knows the turn was cut.
    const engine = engineWith(async function* () {
      yield { type: 'text' as const, content: 'partial' }
      yield { type: 'stop' as const, truncated: true }
      yield { type: 'stop' as const }
    })

    expect(warnings(await collect(engine.process('explain')))).toHaveLength(1)
  })

  it('says nothing about a turn that finished', async () => {
    const engine = engineWith(async function* () {
      yield { type: 'text' as const, content: 'A complete answer.' }
      yield { type: 'stop' as const }
    })

    expect(warnings(await collect(engine.process('explain')))).toHaveLength(0)
  })
})
