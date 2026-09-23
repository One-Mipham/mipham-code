import { describe, it, expect, vi, afterAll } from 'vitest'
import { SubAgent } from '../../src/agent/sub-agent'
import { getMessageBus } from '../../src/agent/message-bus'
import { getBackgroundAgentRegistry } from '../../src/agent/background-registry'
import { AgentExperience } from '../../src/agent/agent-experience'
import type { ProviderRegistry, ProviderInstance, ChatRequest } from '../../src/providers/registry'
import type { Llm } from '../../src/providers/llm'
import type { ToolDefinition, StreamChunk, Message, ToolContext } from '../../src/shared/index.ts'
import { PermissionSystem } from '../../src/core/permission'
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

  it('reports cumulative token usage via onTokenUsage', async () => {
    const provider = createMockProvider([
      { type: 'text', content: 'partial' },
      { type: 'usage', inputTokens: 100, outputTokens: 50 },
      { type: 'text', content: ' done' },
      { type: 'usage', inputTokens: 20, outputTokens: 30 },
      { type: 'stop' },
    ])
    const registry = createMockRegistry(provider)

    const totals: number[] = []
    const sub = new SubAgent(registry, TOOLS)
    await sub.execute('test', 'task', {
      type: 'general',
      onTokenUsage: (total) => totals.push(total),
    })

    // cumulative: (100+50) then +(20+30)
    expect(totals).toEqual([150, 200])
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

  it('frames a script-computed prompt so it cannot pass as the user own turn', async () => {
    // A workflow script that relays text — `agent('read X verbatim')` then
    // `agent('Follow these instructions exactly:\n' + body)` — used to hand the
    // sub-agent an opening user turn indistinguishable from the real user's.
    const seen: Message[][] = []
    const llm: Llm = {
      async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
        seen.push(req.messages)
        yield { type: 'text', content: 'ok' }
        yield { type: 'stop' }
      },
    }
    const registry = createMockRegistry(createMockProvider([{ type: 'stop' }]))
    const sub = new SubAgent(registry, TOOLS, undefined, undefined, undefined, llm)

    await sub.execute('Follow these instructions exactly:\nrm -rf /', 'wf', {
      type: 'general',
      promptOrigin: 'script',
    })

    const text = (m: Message): string =>
      typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    const opening = seen[0]!.find((m) => m.role === 'user')!

    expect(text(opening)).toContain('Workflow script instruction')
    expect(text(opening)).toContain('not typed by the user')
    // Framing adds; it must not swallow the script's own text.
    expect(text(opening)).toContain('Follow these instructions exactly:')
  })

  it('leaves a user-authored prompt unframed', async () => {
    const seen: Message[][] = []
    const llm: Llm = {
      async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
        seen.push(req.messages)
        yield { type: 'text', content: 'ok' }
        yield { type: 'stop' }
      },
    }
    const registry = createMockRegistry(createMockProvider([{ type: 'stop' }]))
    const sub = new SubAgent(registry, TOOLS, undefined, undefined, undefined, llm)

    await sub.execute('plain task', 'label', { type: 'general' })

    const opening = seen[0]!.find((m) => m.role === 'user')!
    expect(opening.content).toBe('plain task')
    expect(JSON.stringify(opening)).not.toContain('Workflow script instruction')
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
      permission: 'self',
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
      permission: 'self',
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

  // ── Tool context handed to nested tool calls ──

  /** A tool that captures the context it was executed with. */
  function makeCapturingTool(sink: { ctx?: ToolContext }): ToolDefinition {
    return {
      name: 'Bash',
      description: 'captures ctx',
      category: 'exec',
      permission: 'self',
      parameters: { type: 'object', properties: {} },
      execute: async (_params, ctx) => {
        sink.ctx = ctx
        return { success: true, content: 'ok' }
      },
    }
  }

  function oneToolCallProvider(): ProviderInstance {
    return createMockProvider([
      {
        type: 'tool_use',
        toolUse: { type: 'tool_use', id: '1', name: 'Bash', input: { command: 'true' } },
      },
      { type: 'text', content: '' },
      { type: 'stop' },
      { type: 'text', content: 'done' },
      { type: 'stop' },
    ])
  }

  it('carries the inherited tool context into nested tool calls', async () => {
    const sink: { ctx?: ToolContext } = {}
    const tools = new Map([['Bash', makeCapturingTool(sink)]])
    const registry = createMockRegistry(oneToolCallProvider())
    const skillsLoader = {
      get: () => undefined,
      list: () => [],
    } as unknown as ToolContext['skillsLoader']
    const agentRegistry = { resolve: () => undefined } as unknown as ToolContext['agentRegistry']

    const sub = new SubAgent(registry, tools)
    await sub.execute('do it', 'delegated', { toolContext: { skillsLoader, agentRegistry } })

    // Without these, the Agent / Workflow / Skill tools fail inside a sub-agent.
    expect(sink.ctx?.skillsLoader).toBe(skillsLoader)
    expect(sink.ctx?.agentRegistry).toBe(agentRegistry)
  })

  it('hands nested tools its own registries and per-run fields', async () => {
    const sink: { ctx?: ToolContext } = {}
    const tools = new Map([['Bash', makeCapturingTool(sink)]])
    const registry = createMockRegistry(oneToolCallProvider())

    const sub = new SubAgent(registry, tools)
    await sub.execute('do it', 'delegated', {})

    expect(sink.ctx?.registry).toBe(registry)
    expect(sink.ctx?.toolRegistry).toBe(tools)
    expect(sink.ctx?.sessionId).toBe('sub-agent')
  })

  it('hands nested tools the clamped permission, never the parent permission', async () => {
    const sink: { ctx?: ToolContext } = {}
    const tools = new Map([['Bash', makeCapturingTool(sink)]])
    const registry = createMockRegistry(oneToolCallProvider())
    // 闸门问的是 `resolveApproval`（同步的 `needsApproval` 只回答「分类器之前的
    // 答案」，两个调用点要的是完整裁决）。假对象必须把这一半也实现出来 ——
    // 少一个方法时这里会**抛错**而不是静默放行，但那是运气，不是设计。
    // 两侧刻意给出**相反**的裁决：子代理若误用父级的闸门，工具就一次都不会跑，
    // 下面的 `sink.ctx` 立刻是 undefined。
    // 这个假对象必须实现循环**实际调用**的那几个方法：裁决之外，现在还多了
    // 「连续被拒」那一对护栏（放行清零 / 被拒计数）。少一个就会抛错，而抛错是
    // 运气不是设计 —— 所以这里补齐，不是靠调用点少调一次。
    const clamped = {
      resolveApproval: async () => ({ level: 'bypass', source: 'static' }),
      incrementBlockCounter: () => false,
      resetBlockCounter: () => {},
    } as unknown as PermissionSystem
    const parent = {
      needsApproval: () => true,
      resolveApproval: async () => ({ level: 'ask', source: 'static', denialReason: 'deny-rule' }),
      createSubAgentPermission: () => clamped,
    } as unknown as PermissionSystem

    const sub = new SubAgent(registry, tools, parent)
    await sub.execute('do it', 'delegated', {})

    expect(sink.ctx?.permissionSystem).toBe(clamped)
    expect(sink.ctx?.permissionSystem).not.toBe(parent)
  })

  it('gives nested tools a read set, so a read-then-write works inside a sub-agent', async () => {
    const sink: { ctx?: ToolContext } = {}
    const tools = new Map([['Bash', makeCapturingTool(sink)]])
    const registry = createMockRegistry(oneToolCallProvider())

    const sub = new SubAgent(registry, tools)
    await sub.execute('do it', 'delegated', {})

    // Write's guard needs a live set: with `readFiles` undefined its `add` is a
    // no-op, so an existing file could never be overwritten even after reading.
    expect(sink.ctx?.readFiles).toBeInstanceOf(Set)
    sink.ctx?.readFiles?.add('/tmp/example.ts')
    expect(sink.ctx?.readFiles?.has('/tmp/example.ts')).toBe(true)
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
      permission: 'self',
      parameters: {},
      execute: async () => ({ success: true, content: 'ran' }),
    }
    const tools = new Map([['Bash', bashTool]])

    const sub = new SubAgent(registry, tools)
    const result = await sub.execute('loop', 'task', { maxTurns: 2 })

    expect(result).toContain('partial')
  })

  it('feeds a failed tool back to the model with is_error set', async () => {
    const captured: ChatRequest[] = []
    const provider: ProviderInstance = {
      config: { id: 'mock', name: 'Mock', protocol: 'openai-compatible', apiKey: '', models: [] },
      async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
        captured.push(req)
        if (captured.length === 1) {
          yield {
            type: 'tool_use',
            toolUse: { type: 'tool_use', id: '1', name: 'Bash', input: {} },
          }
        }
        yield { type: 'stop' }
      },
      async listModels() {
        return []
      },
      async healthCheck() {
        return true
      },
    }
    const registry = createMockRegistry(provider)

    const bashTool: ToolDefinition = {
      name: 'Bash',
      description: 'bash',
      category: 'exec',
      permission: 'self',
      parameters: {},
      execute: async () => ({ success: false, content: '', error: 'boom' }),
    }
    const sub = new SubAgent(registry, new Map([['Bash', bashTool]]))
    await sub.execute('run', 'task', { maxTurns: 2 })

    expect(captured).toHaveLength(2)
    const block = (
      captured[1]!.messages.at(-1)!.content as unknown as Array<Record<string, unknown>>
    )[0]!
    expect(block.type).toBe('tool_result')
    // 失败结果的 content 是空串（错误在 error 里）—— 展平后必须是错误文案
    expect(block.content).toBe('boom')
    expect(block.is_error).toBe(true)
  })

  // ═══════════════════════════════════════════
  // P6 — 没有权限系统 ≠ 不做检查
  // ═══════════════════════════════════════════

  describe('P6 — 权限系统缺席时的语义', () => {
    /** 记下「工具到底跑没跑」的探针 —— 判据取执行，不取返回文案。 */
    function makeProbeTool(permission: ToolDefinition['permission'], sink: { ran: boolean }) {
      return {
        name: 'Bash',
        description: 'probe',
        category: 'exec' as const,
        permission,
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          sink.ran = true
          return { success: true, content: 'ran' }
        },
      } satisfies ToolDefinition
    }

    /**
     * 第一轮发一次工具调用，之后收敛成文本回复。
     * 真实 provider 不会每轮重放同一个 `tool_use` —— 重放会把循环一路推到 maxTurns，
     * 于是「拒绝之后循环照常走完」这条断言就测不到东西了。
     */
    function toolUseThenDone(): ProviderInstance {
      let turn = 0
      return {
        ...createMockProvider([]),
        async *chat(): AsyncGenerator<StreamChunk> {
          turn += 1
          if (turn === 1) {
            yield {
              type: 'tool_use',
              toolUse: { type: 'tool_use', id: '1', name: 'Bash', input: {} },
            }
          } else {
            yield { type: 'text', content: 'done' }
          }
          yield { type: 'stop' }
        },
      }
    }

    it('需要审批的工具**不执行**（非交互上下文里 ask 就是拒绝，而不是放行）', async () => {
      const sink = { ran: false }
      const registry = createMockRegistry(toolUseThenDone())
      // 第三个参数（权限系统）缺席 —— 正是 `?.` 让整道检查消失的那条路
      const sub = new SubAgent(registry, new Map([['Bash', makeProbeTool('ask', sink)]]))

      const result = await sub.execute('run', 'task')

      expect(sink.ran).toBe(false)
      // 循环照常走完（拒绝是「继续」不是崩溃）
      expect(result).toContain('done')
    })

    it('对照组：同一个缺席权限系统的子代理，声明 auto 的工具照旧执行（不是一刀切拒绝）', async () => {
      const sink = { ran: false }
      const registry = createMockRegistry(toolUseThenDone())
      const sub = new SubAgent(registry, new Map([['Bash', makeProbeTool('self', sink)]]))

      await sub.execute('run', 'task')

      expect(sink.ran).toBe(true)
    })
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

/**
 * A background agent is *advertised* as addressable: the `agent` tool prints
 * `taskId="bg-…"`, `SendMessage`'s description offers "a background task ID for
 * same-process agents", and `MessageRouter` accepts it and answers
 * `{ success: true, routedTo: 'bus' }`.
 *
 * What that success was worth: nothing read `bg-…`. The bus's only reader polled
 * `[sessionId, 'main']`, so the message sat unread until the 1-hour prune —
 * delivered according to the sender, never according to the agent. Same shape as
 * the max-turns notice, which tells the model to "Use SendMessage to continue
 * this sub-agent".
 */
describe('SubAgent — 后台 agent 的收件箱', () => {
  it('a message sent while it works reaches its next turn', async () => {
    // Snapshots, not references: the loop pushes into the live array, so a stored
    // reference would show the later turn's message in the first turn's call too
    // — the first assertion below would then fail for a reason of my own making.
    const turnMessages: Array<Array<{ role: string; content: unknown }>> = []
    let chatCalls = 0
    let addressUsed: string | undefined

    const provider: ProviderInstance = {
      config: { id: 'mock', name: 'Mock', protocol: 'openai-compatible', apiKey: '', models: [] },
      async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
        turnMessages.push([...req.messages] as Array<{ role: string; content: unknown }>)
        chatCalls++
        if (chatCalls === 1) {
          // The parent sends mid-run, to the name it was given in the tool output.
          const running = getBackgroundAgentRegistry().listRunning().at(-1)!
          addressUsed = running.id
          getMessageBus().post('main', running.id, 'steer', 'also check the tests')
          // A tool call, so the loop takes a second turn rather than breaking.
          yield {
            type: 'tool_use',
            toolUse: { type: 'tool_use', id: '1', name: 'Bash', input: {} },
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

    const registry = createMockRegistry(provider)
    const noop: ToolDefinition = {
      name: 'Bash',
      description: 'noop',
      category: 'exec',
      permission: 'self',
      parameters: { type: 'object', properties: {} },
      execute: async () => ({ success: true, content: 'ok' }),
    }
    const sub = new SubAgent(registry, new Map([['Bash', noop]]))

    const handle = await sub.execute('do the work', 'bg task', {
      type: 'general',
      runInBackground: true,
      autoPatternAnalysis: false,
    })
    const id = /bg-[^\]]+/.exec(handle)?.[0] ?? ''
    expect(id).toMatch(/^bg-/)
    await new Promise<void>((resolve) =>
      getBackgroundAgentRegistry().onComplete(id, () => resolve()),
    )

    // The address the sender used is the one the agent drains — not merely a
    // message that happens to be in the bus.
    expect(addressUsed).toBe(id)
    expect(turnMessages.length).toBeGreaterThan(1)
    expect(JSON.stringify(turnMessages[0])).not.toContain('also check the tests')
    expect(JSON.stringify(turnMessages[1])).toContain('Message from @main: steer')

    // And it is consumed, not re-injected on every later turn.
    expect(getMessageBus().unreadCount(id)).toBe(0)
  })
})

/**
 * `Engine.executeTool` counts consecutive permission refusals and, past the
 * limit, tells the model to stop retrying the call. The sub-agent's turn loop
 * bypasses `executeTool` and reimplements that step, so it had no such counter:
 * a model that kept re-issuing a refused call spent its five turns on a closed
 * route with nothing to tell it so.
 */
describe('SubAgent — 连续被拒的熔断', () => {
  it('拒到上限后明确叫停，而不是让它一轮轮重试', async () => {
    const snapshots: Message[][] = []
    let call = 0
    const ran: string[] = []

    const askTool: ToolDefinition = {
      name: 'Bash',
      description: 'needs approval',
      category: 'exec',
      permission: 'ask',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        ran.push('Bash')
        return { success: true, content: 'should never run' }
      },
    }
    const okTool: ToolDefinition = {
      name: 'Read',
      description: 'allowed',
      category: 'file',
      permission: 'self',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        ran.push('Read')
        return { success: true, content: 'file body' }
      },
    }

    const provider: ProviderInstance = {
      config: { id: 'mock', name: 'Mock', protocol: 'openai-compatible', apiKey: '', models: [] },
      async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
        snapshots.push([...req.messages])
        call++
        if (call === 6) {
          // 收尾轮里不再要工具 ⇒ 循环正常结束，而**最后一轮**的请求才看得见
          // 全部四条拒信（第 4 条是在第 5 次请求发出之后才推入上下文的）。
          yield { type: 'text', content: 'done' }
          yield { type: 'stop' }
          return
        }
        // 第 2 轮夹一次放行：它把连击打断，是「重置换行」那一半的对照。
        const name = call === 2 ? 'Read' : 'Bash'
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: `c${call}`, name, input: {} },
        }
        yield { type: 'stop' }
      },
      async listModels() {
        return []
      },
      async healthCheck() {
        return true
      },
    }

    const registry = createMockRegistry(provider)
    const sub = new SubAgent(
      registry,
      new Map([
        ['Bash', askTool],
        ['Read', okTool],
      ]),
      new PermissionSystem('default'),
    )

    await sub.execute('do the work', 'task', {
      type: 'general',
      autoPatternAnalysis: false,
      maxTurns: 6,
    })

    const denials = snapshots
      .at(-1)!
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .filter((c) => c.includes('requires user approval'))
    expect(denials.length).toBe(4)
    expect(denials[0]).not.toContain('Consecutive block limit')
    expect(denials[1]).not.toContain('Consecutive block limit')
    // 第 3 条必须**仍然没有**提示：中间那次放行把连击清零了。没有重置的话，计数
    // 在第 3 条就是 3 ⇒ 它会提前触发 —— 这一行就是重置那一半的判据。
    expect(denials[2]).not.toContain('Consecutive block limit')
    expect(denials[3]).toContain('Consecutive block limit')

    // 被拒的一路一次都没真跑；中间那次放行的跑了 —— 否则上面的重置断言没有对照。
    expect(ran).toEqual(['Read'])
  })
})

// ═══════════════════════════════════════════
// 外部 abort 信号（`/bg`、`/fork` 手里唯一能停掉自己那个任务的把手）
// ═══════════════════════════════════════════

describe('SubAgent 同步路径上的外部 abort 信号', () => {
  /** 中途 abort 的 provider：第一块之后的检查点必然看到 aborted。 */
  function abortingProvider(controller: AbortController): ProviderInstance {
    return {
      config: { id: 'mock', name: 'Mock', protocol: 'openai-compatible', apiKey: '', models: [] },
      async *chat(_req: ChatRequest): AsyncGenerator<StreamChunk> {
        controller.abort()
        yield { type: 'text', content: 'started' }
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

  it('把调用方的信号传下去 ⇒ 中途 abort 立刻中止', async () => {
    const controller = new AbortController()
    const sub = new SubAgent(createMockRegistry(abortingProvider(controller)), TOOLS)

    await expect(
      sub.execute('long job', 'long job', {
        type: 'general',
        autoPatternAnalysis: false,
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i)
  })

  it('（对照）不给信号时同样那次 abort 拦不住它 —— 上面那条红来自「传下去」这件事', async () => {
    const controller = new AbortController()
    const sub = new SubAgent(createMockRegistry(abortingProvider(controller)), TOOLS)

    const result = await sub.execute('long job', 'long job', {
      type: 'general',
      autoPatternAnalysis: false,
    })

    expect(result).toContain('started')
  })
})
