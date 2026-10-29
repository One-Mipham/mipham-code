import { describe, it, expect } from 'vitest'
import type { StreamChunk } from '../../src/shared/index.ts'
import { QueryEngine } from '../../src/core/engine'
import { ContextManager } from '../../src/core/context'
import { ProviderRegistry } from '../../src/providers/registry'

/**
 * 汇报出来的数字要有出处。
 *
 * 拦的是「先猜一个数、再当事实说出去」：回复里带计数单位的数量，若本轮任何工具
 * 结果（或用户这句话）里都没有它，就问一次。**每轮至多一次** —— 问过不作罢的
 * 就作罢，否则一次质疑会变成一台永动机。
 */

interface Counter {
  chats: number
  requests: string[]
}

function engineWithReplies(counter: Counter, replies: string[]): QueryEngine {
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
    chat: async function* (req) {
      counter.chats++
      counter.requests.push(JSON.stringify(req.messages))
      const reply = replies[Math.min(counter.chats - 1, replies.length - 1)]!
      yield { type: 'text' as const, content: reply }
      yield { type: 'stop' as const }
    },
    listModels: async () => [],
    healthCheck: async () => true,
  })
  return new QueryEngine(
    registry,
    new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 }),
    new Map(),
  )
}

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<void> {
  for await (const _ of gen) void _
}

describe('reporting a count no tool produced', () => {
  it('asks once, naming the number it doubts', async () => {
    const counter: Counter = { chats: 0, requests: [] }
    const engine = engineWithReplies(counter, ['测试 4,572 个，全部通过。', '完成。'])

    await collect(engine.process('go'))

    expect(counter.chats).toBe(2)
    // The notice reaches the model — it is the second request that carries it.
    expect(counter.requests[1]).toContain('4,572')
  })

  it('says nothing when the number came from the user', async () => {
    const counter: Counter = { chats: 0, requests: [] }
    const engine = engineWithReplies(counter, ['这 4,572 个都看过了。'])

    await collect(engine.process('看下这 4,572 个结果'))

    expect(counter.chats).toBe(1)
  })

  it('says nothing when the reply makes no count claims', async () => {
    const counter: Counter = { chats: 0, requests: [] }
    const engine = engineWithReplies(counter, ['改好了，版本 2.94.48，端口 3007。'])

    await collect(engine.process('go'))

    expect(counter.chats).toBe(1)
  })

  it('asks at most once per turn — a repeated claim does not loop the turn', async () => {
    const counter: Counter = { chats: 0, requests: [] }
    const engine = engineWithReplies(counter, ['4,572 个测试通过。'])

    await collect(engine.process('go'))

    expect(counter.chats).toBe(2)
  })
})
