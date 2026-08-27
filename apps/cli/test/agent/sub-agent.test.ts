import { describe, it, expect, vi, afterAll } from 'vitest'
import { SubAgent } from '../../src/agent/sub-agent'
import { getMessageBus } from '../../src/agent/message-bus'
import { AgentExperience } from '../../src/agent/agent-experience'
import type { ProviderRegistry, ProviderInstance, ChatRequest } from '../../src/providers/registry'
import type { Llm } from '../../src/providers/llm'
import type { ToolDefinition, StreamChunk, Message } from '../../src/shared/index.ts'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const AGENT_TEST_DIR = join(tmpdir(), 'mipham-agent-exp-test-' + Date.now())

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
  opts?: {
    models?: Array<{
      id: string
      name: string
      providerId: string
      contextWindow: number
      maxOutput: number
      status?: string
    }>
  },
): ProviderRegistry {
  const models = opts?.models ?? [
    {
      id: 'mock-model',
      name: 'Mock Model',
      providerId: 'mock',
      contextWindow: 128000,
      maxOutput: 4096,
    },
  ]
  const registry = {
    getActive: () => provider,
    getActiveModel: () => 'mock-model',
    listModels: () => models,
    findModel: (id: string) => models.find((m) => m.id === id),
    async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
      yield* provider.chat(req)
    },
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

  it('routes chat through injected Llm seam instead of registry active provider', async () => {
    // registry active provider 会产出 "from-registry"——必须被绕过
    const registryProvider = createMockProvider([
      { type: 'text', content: 'from-registry' },
      { type: 'stop' },
    ])
    const registry = createMockRegistry(registryProvider)

    // 注入的 llm 缝产出 "from-llm"——必须被走通
    let llmChatCalled = false
    const llm: Llm = {
      async *chat(_req: ChatRequest): AsyncGenerator<StreamChunk> {
        llmChatCalled = true
        yield { type: 'text', content: 'from-llm' }
        yield { type: 'stop' }
      },
    }

    const sub = new SubAgent(registry, TOOLS, undefined, undefined, undefined, llm)
    const result = await sub.execute('test', 'test task', { type: 'general' })

    expect(llmChatCalled).toBe(true)
    expect(result).toContain('from-llm')
    expect(result).not.toContain('from-registry')
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

  it('includes the model name in a chat error', async () => {
    const provider = createMockProvider([
      { type: 'error', error: 'OpenAI API error 404: model not found' },
    ])
    const registry = createMockRegistry(provider)

    const sub = new SubAgent(registry, TOOLS)
    await expect(sub.execute('test', 'task', { type: 'general' })).rejects.toThrow('mock-model')
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
      {
        id: 'mock-model',
        name: 'Mock Model',
        providerId: 'mock',
        contextWindow: 128000,
        maxOutput: 4096,
      },
      {
        id: 'claude-sonnet',
        name: 'Claude Sonnet',
        providerId: 'mock',
        contextWindow: 200000,
        maxOutput: 8192,
      },
    ]
    const registry = createMockRegistry(provider, { models: knownModels })

    const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const sub = new SubAgent(registry, TOOLS)
    const result = await sub.execute('test', 'test task', { modelOverride: 'unknown-model-xyz' })

    expect(receivedModel).toBe('mock-model')
    expect(result).toContain('ok')
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('unknown-model-xyz'))
    expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('mock-model'))

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
      {
        id: 'mock-model',
        name: 'Mock Model',
        providerId: 'mock',
        contextWindow: 128000,
        maxOutput: 4096,
      },
      {
        id: 'claude-sonnet',
        name: 'Claude Sonnet',
        providerId: 'mock',
        contextWindow: 200000,
        maxOutput: 8192,
      },
    ]
    const registry = createMockRegistry(provider, { models: knownModels })

    const sub = new SubAgent(registry, TOOLS)
    const result = await sub.execute('test', 'test task', { modelOverride: 'claude-sonnet' })

    expect(receivedModel).toBe('claude-sonnet')
    expect(result).toContain('ok')
  })

  it('seeds inherited parent conversation into the sub-agent context', async () => {
    let receivedMessages: Message[] = []
    const provider = createMockProvider([{ type: 'text', content: 'ok' }, { type: 'stop' }])
    const originalChat = provider.chat
    provider.chat = async function* (req) {
      receivedMessages = req.messages
      yield* originalChat.call(provider, req)
    }

    const registry = createMockRegistry(provider)
    const sub = new SubAgent(registry, TOOLS)

    const inherited: Message[] = [
      { role: 'user', content: 'parent question' },
      { role: 'assistant', content: 'parent answer' },
    ]

    await sub.execute('do the task', 'task', {
      type: 'general',
      inheritContext: { messages: inherited },
    })

    expect(receivedMessages.length).toBeGreaterThanOrEqual(3)
    expect(receivedMessages[0]).toEqual(inherited[0])
    expect(receivedMessages[1]).toEqual(inherited[1])
    const last = receivedMessages[receivedMessages.length - 1]!
    expect(last.role).toBe('user')
    expect(last.content).toBe('do the task')
  })

  it('posts warning to message bus when model fallback occurs', async () => {
    const provider = createMockProvider([{ type: 'text', content: 'ok' }, { type: 'stop' }])

    const knownModels = [
      {
        id: 'mock-model',
        name: 'Mock Model',
        providerId: 'mock',
        contextWindow: 128000,
        maxOutput: 4096,
      },
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

  it('marks result as partial when the sub-agent hits its max tool-turn limit', async () => {
    // Always emits a tool_use so the loop never breaks early → hits maxTurns.
    const provider = createMockProvider([
      { type: 'tool_use', toolUse: { type: 'tool_use', id: '1', name: 'Bash', input: {} } },
      { type: 'stop' },
    ])
    const registry = createMockRegistry(provider)

    const bashTool: ToolDefinition = {
      name: 'Bash',
      description: 'bash',
      category: 'exec',
      permission: 'auto',
      parameters: {},
      execute: async () => ({ success: true, content: 'ran' }),
    }
    const tools = new Map([['Bash', bashTool]])

    const sub = new SubAgent(registry, tools)
    const result = await sub.execute('loop', 'task', { maxTurns: 2 })

    expect(result).toContain('partial')
  })
})

describe('AgentExperience', () => {
  afterAll(() => {
    rmSync(AGENT_TEST_DIR, { recursive: true, force: true })
  })

  it('logSuccess appends to Success Patterns', () => {
    const exp = new AgentExperience('test-agent', AGENT_TEST_DIR)
    exp.logSuccess('Used Grep to find all import cycles', 'Cross-module PR review')

    const content = exp.getExperience()
    expect(content).toContain('## Success Patterns')
    expect(content).toContain('Grep to find all import cycles')
    expect(content).toContain('Cross-module PR review')
  })

  it('logFailure appends to Failure Patterns', () => {
    const exp = new AgentExperience('test-agent', AGENT_TEST_DIR)
    exp.logFailure('Bash timeout on npm install', 'CI build commands with default timeout')

    const content = exp.getExperience()
    expect(content).toContain('## Failure Patterns')
    expect(content).toContain('Bash timeout')
    expect(content).toContain('CI build commands')
  })

  it('stats track execution counts', () => {
    const exp = new AgentExperience('test-agent-stats', AGENT_TEST_DIR)
    exp.logSuccess('Task A complete', 'When doing A')
    exp.logSuccess('Task B complete', 'When doing B')
    exp.logFailure('Task C failed', 'Avoid pattern C')

    const content = exp.getExperience()
    expect(content).toContain('总执行: 3 次')
    expect(content).toContain('成功: 2')
    expect(content).toContain('失败: 1')
  })

  it('getExperience returns empty string for agent with no history', () => {
    const exp = new AgentExperience('new-agent', AGENT_TEST_DIR)
    const content = exp.getExperience()
    expect(content).toBe('')
  })

  it('reset clears experience', () => {
    const exp = new AgentExperience('reset-test', AGENT_TEST_DIR)
    exp.logSuccess('Something', 'Context')
    exp.reset()
    expect(exp.getExperience()).toBe('')
  })
})
