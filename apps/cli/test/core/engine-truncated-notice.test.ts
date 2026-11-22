import { describe, it, expect } from 'vitest'
import type { StreamChunk } from '../../src/shared/index.ts'
import type { ChatRequest } from '../../src/providers/registry'
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

function registryWith(chat: (req: ChatRequest) => AsyncGenerator<StreamChunk>): ProviderRegistry {
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

function engineWith(chat: (req: ChatRequest) => AsyncGenerator<StreamChunk>): QueryEngine {
  return new QueryEngine(
    registryWith(chat),
    new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 }),
    new Map(),
  )
}

/** One scripted response per chat call; requests are captured for assertions. */
function scriptedEngine(script: Array<() => AsyncGenerator<StreamChunk>>): {
  engine: QueryEngine
  calls: ChatRequest[]
} {
  const calls: ChatRequest[] = []
  let call = 0
  const engine = engineWith(async function* (req) {
    calls.push(req)
    const step = script[Math.min(call, script.length - 1)]!
    call++
    yield* step()
  })
  return { engine, calls }
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

  it('continues an output-limit cut exactly once and joins the halves', async () => {
    const { engine, calls } = scriptedEngine([
      async function* () {
        yield { type: 'text' as const, content: 'Part one' }
        yield { type: 'stop' as const, truncated: true, truncationCause: 'max_tokens' as const }
      },
      async function* () {
        yield { type: 'text' as const, content: ' part two.' }
        yield { type: 'stop' as const }
      },
    ])

    const chunks = await collect(engine.process('explain'))
    expect(
      chunks
        .filter((c) => c.type === 'text')
        .map((c) => c.content)
        .join(''),
    ).toBe('Part one part two.')

    // Exactly one follow-up request, and it asks the model to keep writing —
    // with the partial answer as its own assistant turn.
    expect(calls).toHaveLength(2)
    const followUp = calls[1]!.messages
    expect(followUp.at(-2)).toMatchObject({ role: 'assistant', content: 'Part one' })
    expect(String(followUp.at(-1)!.content)).toMatch(/continue/i)
    // No tools on the continuation: a tool call there would have no executor.
    expect(calls[1]!.tools).toBeUndefined()

    // One assistant message, both halves — not two bubbles.
    const assistant = engine
      .getContext()
      .getMessages()
      .filter((m) => m.role === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0]!.content).toBe('Part one part two.')

    // Says it is continuing; the proxy/VPN advice belongs to connection cuts.
    const notices = warnings(chunks)
    expect(notices).toHaveLength(1)
    expect(notices[0]!.content).not.toMatch(/proxy|VPN/i)
  })

  it('does not continue a connection cut', async () => {
    const { engine, calls } = scriptedEngine([
      async function* () {
        yield { type: 'text' as const, content: 'partial' }
        yield { type: 'stop' as const, truncated: true, truncationCause: 'connection' as const }
      },
    ])

    const chunks = await collect(engine.process('explain'))
    expect(calls).toHaveLength(1)
    expect(warnings(chunks)[0]!.content).toMatch(/proxy|gateway/i)
  })

  it('stops after one continuation even when the ceiling is hit again', async () => {
    const { engine, calls } = scriptedEngine([
      async function* () {
        yield { type: 'text' as const, content: 'a' }
        yield { type: 'stop' as const, truncated: true, truncationCause: 'max_tokens' as const }
      },
      async function* () {
        yield { type: 'text' as const, content: 'b' }
        yield { type: 'stop' as const, truncated: true, truncationCause: 'max_tokens' as const }
      },
    ])

    const chunks = await collect(engine.process('explain'))
    expect(calls).toHaveLength(2)
    const assistant = engine
      .getContext()
      .getMessages()
      .filter((m) => m.role === 'assistant')
    expect(assistant).toHaveLength(1)
    expect(assistant[0]!.content).toBe('ab')
    // Bounded: the second cut is reported, not followed by a third request.
    expect(warnings(chunks).some((w) => /not be continued further/.test(String(w.content)))).toBe(
      true,
    )
  })

  it('says nothing about a turn that finished', async () => {
    const engine = engineWith(async function* () {
      yield { type: 'text' as const, content: 'A complete answer.' }
      yield { type: 'stop' as const }
    })

    expect(warnings(await collect(engine.process('explain')))).toHaveLength(0)
  })
})
