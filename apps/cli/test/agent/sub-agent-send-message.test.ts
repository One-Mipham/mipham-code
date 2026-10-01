import { describe, it, expect } from 'vitest'
import { SubAgent } from '../../src/agent/sub-agent'
import { getMessageBus } from '../../src/agent/message-bus'
import { getBackgroundAgentRegistry } from '../../src/agent/background-registry'
import { sendMessageTool } from '../../src/tools/agent/send-message'
import type { ProviderRegistry, ProviderInstance, ChatRequest } from '../../src/providers/registry'
import type { ToolDefinition, StreamChunk } from '../../src/shared/index.ts'

function registryFor(provider: ProviderInstance): ProviderRegistry {
  const models = [
    {
      id: 'mock-model',
      name: 'Mock Model',
      providerId: 'mock',
      contextWindow: 128000,
      maxOutput: 4096,
    },
  ]
  return {
    getActive: () => provider,
    getActiveModel: () => 'mock-model',
    listModels: () => models,
    findModel: (id: string) => models.find((m) => m.id === id),
    async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
      yield* provider.chat(req)
    },
  } as unknown as ProviderRegistry
}

const BASE_CONFIG = {
  id: 'mock',
  name: 'Mock',
  protocol: 'openai-compatible' as const,
  apiKey: '',
  models: [],
}

/** Two tool turns, then a text turn so the loop ends on its own. */
function sendsTwoMessages(chat: { call: number }): ProviderInstance {
  return {
    config: { ...BASE_CONFIG },
    async *chat(_req: ChatRequest): AsyncGenerator<StreamChunk> {
      chat.call++
      if (chat.call <= 2) {
        yield {
          type: 'tool_use',
          toolUse: {
            type: 'tool_use',
            id: `${chat.call}`,
            name: 'SendMessage',
            input: { to: 'main', summary: `m${chat.call}`, message: 'body' },
          },
        }
        yield { type: 'stop' }
        return
      }
      yield { type: 'text', content: 'done' }
      yield { type: 'stop' }
    },
    async listModels() {
      return []
    },
    async healthCheck() {
      return true
    },
  }
}

/** Always asks for a tool, so `maxTurns: 1` tips it straight into the cap. */
function alwaysToolUse(): ProviderInstance {
  return {
    config: { ...BASE_CONFIG },
    async *chat(_req: ChatRequest): AsyncGenerator<StreamChunk> {
      yield { type: 'tool_use', toolUse: { type: 'tool_use', id: '1', name: 'Bash', input: {} } }
      yield { type: 'stop' }
    },
    async listModels() {
      return []
    },
    async healthCheck() {
      return true
    },
  }
}

const noopTool: ToolDefinition = {
  name: 'Bash',
  description: 'noop',
  category: 'exec',
  permission: 'self',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ success: true, content: 'ok' }),
}

/**
 * `ToolContext` carried no agent name, so `SendMessage` keyed off `sessionId`,
 * which is the literal 'sub-agent' for every sub-agent. The parent therefore got
 * `sub-agent-<ms>` — minted per message, so messages from one agent could not be
 * grouped and the sender was not the agent the parent spawned.
 */
describe('SubAgent — SendMessage 的发送者身份', () => {
  it('使每条消息以 agent 的名字落款，同一条 agent 的两条消息落同一个名字', async () => {
    const bus = getMessageBus()
    const before = bus.list('main').length
    const tools = new Map<string, ToolDefinition>([['SendMessage', sendMessageTool]])
    const sub = new SubAgent(registryFor(sendsTwoMessages({ call: 0 })), tools)

    await sub.execute('send two notes', 'identity test', {
      type: 'explore',
      autoPatternAnalysis: false,
    })

    const sent = bus.list('main').slice(before)
    expect(sent).toHaveLength(2)
    expect(sent.map((m) => m.from)).toEqual(['explore', 'explore'])
  })
})

/**
 * The max-turns notice told the model to "Use SendMessage to continue this
 * sub-agent" — true only where a channel exists. The background path gets a
 * `bg-…` address and drains it each turn; the synchronous path is called with no
 * id and is already finished by the time the notice is built, so on that path the
 * advice advertised a route with no landing point.
 */
describe('SubAgent — 到达上限时的续接提示', () => {
  it('同步路径不再广告 SendMessage（那条通道在同步运行里不存在）', async () => {
    const sub = new SubAgent(registryFor(alwaysToolUse()), new Map([['Bash', noopTool]]))

    const result = await sub.execute('go', 'sync cap', {
      type: 'general',
      maxTurns: 1,
      autoPatternAnalysis: false,
    })

    expect(result).toContain('reached its 1-turn limit')
    expect(result).toContain('task may be incomplete')
    expect(result).not.toContain('SendMessage')
  })

  it('后台路径仍然保留 SendMessage 的续接提示（它确实有地址可续）', async () => {
    const sub = new SubAgent(registryFor(alwaysToolUse()), new Map([['Bash', noopTool]]))

    const handle = await sub.execute('go', 'bg cap', {
      type: 'general',
      maxTurns: 1,
      runInBackground: true,
      autoPatternAnalysis: false,
    })
    const id = /bg-[^\]]+/.exec(handle)?.[0] ?? ''
    expect(id).toMatch(/^bg-/)

    await new Promise<void>((resolve) =>
      getBackgroundAgentRegistry().onComplete(id, () => resolve()),
    )

    const task = getBackgroundAgentRegistry().get(id)!
    expect(task.result).toContain('Use SendMessage to continue this sub-agent')
  })
})
