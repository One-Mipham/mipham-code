import { describe, it, expect, vi } from 'vitest'
import { SubAgent } from '../../src/agent/sub-agent'
import type { ProviderRegistry, ProviderInstance, ChatRequest } from '../../src/providers/registry'
import type { ToolDefinition, StreamChunk } from '../../src/shared/index.ts'

function createMockProvider(chunks: StreamChunk[]): ProviderInstance {
  return {
    config: { id: 'mock', name: 'Mock', protocol: 'openai-compatible', apiKey: '', models: [] },
    async *chat(_req: ChatRequest): AsyncGenerator<StreamChunk> {
      for (const chunk of chunks) {
        yield chunk
      }
    },
    async listModels() {
      return []
    },
    async healthCheck() {
      return true
    },
  }
}

function createMockRegistry(provider: ProviderInstance): ProviderRegistry {
  const registry = {
    getActive: () => provider,
    getActiveModel: () => 'mock-model',
  } as unknown as ProviderRegistry
  return registry
}

const TOOLS = new Map<string, ToolDefinition>()

describe('SubAgent', () => {
  it('returns AI-generated text for general type', async () => {
    const provider = createMockProvider([
      { type: 'text', content: 'Task analysis complete.' },
      { type: 'stop' },
    ])
    const registry = createMockRegistry(provider)

    const sub = new SubAgent(registry, TOOLS)
    const result = await sub.execute('analyze this', 'analysis task', { type: 'general' })

    expect(result).toContain('Task analysis complete.')
  })

  it('throws when no active provider is available', async () => {
    const registry = {
      getActive: () => undefined,
      getActiveModel: () => '',
    } as unknown as ProviderRegistry

    const sub = new SubAgent(registry, TOOLS)
    await expect(sub.execute('test', 'test task', { type: 'general' })).rejects.toThrow(
      'No active provider',
    )
  })

  it('throws on API error chunk', async () => {
    const provider = createMockProvider([{ type: 'error', error: 'API rate limit exceeded' }])
    const registry = createMockRegistry(provider)

    const sub = new SubAgent(registry, TOOLS)
    await expect(sub.execute('test', 'test task', { type: 'general' })).rejects.toThrow(
      'API rate limit exceeded',
    )
  })

  it('uses agent definition system prompt when provided', async () => {
    let receivedSystemPrompt = ''
    const provider = createMockProvider([{ type: 'text', content: 'ok' }, { type: 'stop' }])
    // Spy on chat to capture system prompt
    const originalChat = provider.chat
    provider.chat = async function* (req) {
      receivedSystemPrompt = req.systemPrompt || ''
      yield* originalChat.call(provider, req)
    }

    const registry = createMockRegistry(provider)
    const agentDef = {
      name: 'custom',
      description: 'custom agent',
      systemPrompt: 'You are a custom agent. Be concise.',
      model: 'inherit',
      permissionMode: 'inherit',
      background: false,
      source: 'project' as const,
    }

    const sub = new SubAgent(registry, TOOLS)
    await sub.execute('test', 'test task', { agentDef })

    expect(receivedSystemPrompt).toBe('You are a custom agent. Be concise.')
  })

  it('scopes tools based on agent definition allowlist', async () => {
    let receivedTools: Record<string, unknown>[] | undefined
    const provider = createMockProvider([{ type: 'text', content: 'ok' }, { type: 'stop' }])
    const originalChat = provider.chat
    provider.chat = async function* (req) {
      receivedTools = req.tools
      yield* originalChat.call(provider, req)
    }

    const registry = createMockRegistry(provider)

    const readTool: ToolDefinition = {
      name: 'Read',
      description: 'read',
      category: 'file',
      permission: 'auto',
      parameters: {},
      execute: async () => ({ success: true, content: '' }),
    }
    const writeTool: ToolDefinition = {
      name: 'Write',
      description: 'write',
      category: 'file',
      permission: 'ask',
      parameters: {},
      execute: async () => ({ success: true, content: '' }),
    }
    const tools = new Map([
      ['Read', readTool],
      ['Write', writeTool],
    ])

    const agentDef = {
      name: 'reader',
      description: 'read only',
      systemPrompt: 'Read only.',
      tools: 'Read',
      model: 'inherit',
      permissionMode: 'inherit',
      background: false,
      source: 'project' as const,
    }

    const sub = new SubAgent(registry, tools)
    await sub.execute('test', 'test task', { agentDef })

    expect(receivedTools).toBeDefined()
    expect(receivedTools!).toHaveLength(1)
    expect(receivedTools![0]!.name).toBe('Read')
  })

  it('does not return simulate-style template text', async () => {
    const provider = createMockProvider([
      { type: 'text', content: 'Real AI response.' },
      { type: 'stop' },
    ])
    const registry = createMockRegistry(provider)

    const sub = new SubAgent(registry, TOOLS)
    const result = await sub.execute('test', 'test task', { type: 'explore' })

    // Must NOT contain simulation template markers
    expect(result).not.toContain('Sub-Agent Result')
    expect(result).not.toContain('simulation mode')
    expect(result).not.toContain('would search the codebase')
  })
})
