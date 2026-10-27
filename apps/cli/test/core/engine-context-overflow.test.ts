/**
 * 请求被拒收为「太大」时：压缩，再问一次。
 *
 * 与「同 provider 重试一次」是**两种**失败，判据必须分开：
 * - 传输抖动 ⇒ 原样重发有意义；
 * - 提示本身超窗 ⇒ 原样重发得到同一个错误，唯一能改变结果的动作是**先压缩**。
 *
 * 所以第一条用例的关键断言不是「重试了」，而是「重试的那条请求比被拒的那条**短**」——
 * 只断言「发了第二次」的话，一个把同一份超窗提示原样重发的实现也能全绿。
 */

import { describe, it, expect } from 'vitest'
import { QueryEngine, isContextOverflowError } from '../../src/core/engine'
import { ContextManager } from '../../src/core/context'
import { ProviderRegistry, type ChatRequest } from '../../src/providers/registry'
import type { StreamChunk } from '../../src/shared/index.ts'

function registryWith(chatImpl: (req: ChatRequest) => AsyncGenerator<StreamChunk>) {
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
    chat: chatImpl,
    listModels: async () => [],
    healthCheck: async () => true,
  })
  return registry
}

/** A conversation long enough that `compact()` actually drops messages. */
function longContext(): ContextManager {
  const context = new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 })
  for (let i = 0; i < 31; i++) {
    context.addMessage({ role: i % 2 === 0 ? 'user' : 'assistant', content: `old message ${i}` })
  }
  return context
}

async function collect(engine: QueryEngine, input: string) {
  const chunks: StreamChunk[] = []
  for await (const chunk of engine.process(input)) chunks.push(chunk)
  return chunks
}

describe('请求超窗 ⇒ 压缩后重问', () => {
  it('被拒一次之后压缩，重问的那条请求确实更短', async () => {
    const requests: ChatRequest[] = []
    const registry = registryWith(async function* (req) {
      requests.push(req)
      if (requests.length === 1) {
        // `retryable: false` 是重点：这条路径不花「同 provider 重试一次」的额度，
        // 它判断的是「重发有没有意义」。
        yield {
          type: 'error',
          error: 'prompt is too long: 250000 tokens > 200000 maximum',
          retryable: false,
        }
        return
      }
      yield { type: 'text', content: 'recovered' }
      yield { type: 'stop' }
    })
    const context = longContext()
    const engine = new QueryEngine(registry, context, new Map())

    const chunks = await collect(engine, 'next question')

    expect(requests).toHaveLength(2)
    expect(requests[0]!.messages.length).toBeGreaterThan(requests[1]!.messages.length)
    expect(chunks.some((c) => c.type === 'warning' && /compact/i.test(c.content ?? ''))).toBe(true)
    expect(chunks.some((c) => c.type === 'text' && c.content === 'recovered')).toBe(true)
    expect(chunks.some((c) => c.type === 'error')).toBe(false)
  })

  it('负控：非超窗的确定性失败不压缩，也不多发请求', async () => {
    const requests: ChatRequest[] = []
    const registry = registryWith(async function* (req) {
      requests.push(req)
      yield { type: 'error', error: 'invalid api key', retryable: false }
    })
    const context = longContext()
    const engine = new QueryEngine(registry, context, new Map())

    const chunks = await collect(engine, 'next question')

    expect(requests).toHaveLength(1)
    expect(context.getMessages().length).toBeGreaterThan(20)
    expect(chunks.some((c) => c.type === 'error' && /invalid api key/.test(c.error ?? ''))).toBe(
      true,
    )
  })

  it('只压缩一次：压缩后仍超窗 ⇒ 不再压第二趟', async () => {
    const requests: ChatRequest[] = []
    const registry = registryWith(async function* (req) {
      requests.push(req)
      yield { type: 'error', error: 'context_length_exceeded', retryable: false }
    })
    const context = longContext()
    const engine = new QueryEngine(registry, context, new Map())

    const chunks = await collect(engine, 'next question')

    // 第一次 + 压缩后一次，然后收手（重试额度也用完了）。
    expect(requests).toHaveLength(2)
    expect(chunks.some((c) => c.type === 'error')).toBe(true)
  })
})

describe('isContextOverflowError', () => {
  it('认得各家真的这么说的话', () => {
    for (const msg of [
      'prompt is too long: 250000 tokens > 200000 maximum',
      'context_length_exceeded',
      'This model maximum context length is 128000 tokens',
      'Usage credits required for 1M context',
      'The request exceeds the model context window',
    ]) {
      expect(isContextOverflowError(msg), msg).toBe(true)
    }
  })

  it('不把别的失败当成超窗', () => {
    for (const msg of [
      'invalid api key',
      'ECONNREFUSED',
      'max_tokens: 9000 > 8192',
      'Rate limit exceeded',
      '',
      null,
    ]) {
      expect(isContextOverflowError(msg), String(msg)).toBe(false)
    }
  })
})
