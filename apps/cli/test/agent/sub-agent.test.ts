import { describe, it, expect, vi } from 'vitest'
import { SubAgent } from '../../src/agent/sub-agent'
import { getMessageBus } from '../../src/agent/message-bus'
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

function createMockRegistry(
  provider: ProviderInstance,
  opts?: { models?: Array<{ id: string; name: string; providerId: string; contextWindow: number; maxOutput: number; status?: string }> },
): ProviderRegistry {
  const models =
    opts?.models ??
    [{ id: 'mock-model', name: 'Mock Model', providerId: 'mock', contextWindow: 128000, maxOutput: 4096 }]
  const registry = {
    getActive: () => provider,
    getActiveModel: () => 'mock-model',
    listModels: () => models,
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

  it('uses worktreePath as cwd for tool execution', async () => {
    let capturedCwd = ''
    const cwdTool: ToolDefinition = {
      name: 'Bash',
      description: 'captures cwd',
      category: 'exec',
      permission: 'auto',
      parameters: { type: 'object', properties: {} },
      execute: async (_params, ctx) => {
        capturedCwd = ctx.cwd
        return { success: true, content: capturedCwd }
      },
    }

    const provider = createMockProvider([
      {
        type: 'tool_use',
        toolUse: { type: 'tool_use', id: '1', name: 'Bash', input: { command: 'pwd' } },
      },
      { type: 'text', content: '' },
      { type: 'stop' },
      { type: 'text', content: 'done' },
      { type: 'stop' },
    ])
    const registry = createMockRegistry(provider)
    const tools = new Map([['Bash', cwdTool]])

    const sub = new SubAgent(registry, tools)
    await sub.execute('test', 'test', { worktreePath: '/tmp/test-worktree' })

    expect(capturedCwd).toBe('/tmp/test-worktree')
  })

  it('falls back to parent model when modelOverride specifies unknown model', async () => {
    let receivedModel = ''
    const provider = createMockProvider([{ type: 'text', content: 'ok' }, { type: 'stop' }])
    const originalChat = provider.chat
    provider.chat = async function* (req) {
      receivedModel = req.model
      yield* originalChat.call(provider, req)
    }

    const knownModels = [
      { id: 'mock-model', name: 'Mock Model', providerId: 'mock', contextWindow: 128000, maxOutput: 4096 },
      { id: 'claude-sonnet', name: 'Claude Sonnet', providerId: 'mock', contextWindow: 200000, maxOutput: 8192 },
    ]
    const registry = createMockRegistry(provider, { models: knownModels })

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const sub = new SubAgent(registry, TOOLS)
    const result = await sub.execute('test', 'test task', { modelOverride: 'unknown-model-xyz' })

    expect(receivedModel).toBe('mock-model')
    expect(result).toContain('ok')
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('unknown-model-xyz'),
    )
    expect(consoleWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('mock-model'),
    )

    consoleWarnSpy.mockRestore()
  })

  it('uses modelOverride when model exists in registry', async () => {
    let receivedModel = ''
    const provider = createMockProvider([{ type: 'text', content: 'ok' }, { type: 'stop' }])
    const originalChat = provider.chat
    provider.chat = async function* (req) {
      receivedModel = req.model
      yield* originalChat.call(provider, req)
    }

    const knownModels = [
      { id: 'mock-model', name: 'Mock Model', providerId: 'mock', contextWindow: 128000, maxOutput: 4096 },
      { id: 'claude-sonnet', name: 'Claude Sonnet', providerId: 'mock', contextWindow: 200000, maxOutput: 8192 },
    ]
    const registry = createMockRegistry(provider, { models: knownModels })

    const sub = new SubAgent(registry, TOOLS)
    const result = await sub.execute('test', 'test task', { modelOverride: 'claude-sonnet' })

    expect(receivedModel).toBe('claude-sonnet')
    expect(result).toContain('ok')
  })

  it('posts warning to message bus when model fallback occurs', async () => {
    const provider = createMockProvider([{ type: 'text', content: 'ok' }, { type: 'stop' }])

    const knownModels = [
      { id: 'mock-model', name: 'Mock Model', providerId: 'mock', contextWindow: 128000, maxOutput: 4096 },
    ]
    const registry = createMockRegistry(provider, { models: knownModels })

    const bus = getMessageBus()
    // Clear any pre-existing messages to isolate this test
    bus.markAllRead('main')

    const sub = new SubAgent(registry, TOOLS)
    const result = await sub.execute('test', 'test task', { modelOverride: 'unknown-model-xyz' })

    expect(result).toContain('ok')

    const warnings = bus.getWarnings('main')
    expect(warnings.length).toBeGreaterThanOrEqual(1)

    const warningMsg = warnings.find((m) => m.type === 'warning' && m.from === 'system')
    expect(warningMsg).toBeDefined()
    expect(warningMsg!.summary).toContain('unknown-model-xyz')
    expect(warningMsg!.summary).toContain('mock-model')
    expect(warningMsg!.type).toBe('warning')
  })
})
