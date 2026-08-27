import { describe, it, expect } from 'vitest'
import type { StreamChunk, ToolDefinition, ToolResult } from '../../src/shared/index.ts'
import { QueryEngine, filterExpiredMessages } from '../../src/core/engine'
import { SelfCritique } from '../../src/core/self-critique'
import {
  AgentMessageBus,
  formatInboundMessage,
  type AgentMessage,
} from '../../src/agent/message-bus'
import { ContextManager } from '../../src/core/context'
import { PermissionSystem } from '../../src/core/permission'
import { HookEngine } from '../../src/core/hooks'
import { ProviderRegistry } from '../../src/providers/registry'
import { Context } from '../../src/vajra'
import type { Llm } from '../../src/providers/llm'
import { mountLlm } from '../../src/providers/llm'
import { recordLlm, replayLlm } from '../../src/providers/llm-replay'
import { SessionLog, replayChunks } from '../../src/core/session-log'

// ── Helpers ──

function mockProviderRegistry(chatImpl?: () => AsyncGenerator<StreamChunk>) {
  const registry = new ProviderRegistry(
    [{ id: 'test', name: 'Test', protocol: 'openai-compatible', apiKey: 'key', models: [] }],
    'test',
    'test-model',
  )

  const mockProvider = {
    config: {
      id: 'test',
      name: 'Test',
      protocol: 'openai-compatible' as const,
      apiKey: 'key',
      models: [],
    },
    chat:
      chatImpl ||
      async function* () {
        yield { type: 'text' as const, content: 'Hello!' }
        yield { type: 'stop' as const }
      },
    listModels: async () => [],
    healthCheck: async () => true,
  }
  registry.register('test', mockProvider)
  return registry
}

function mockContext(): ContextManager {
  return new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 })
}

function mockTool(
  name: string,
  impl?: (params: Record<string, unknown>) => Promise<ToolResult>,
): ToolDefinition {
  return {
    name,
    description: `Tool: ${name}`,
    category: 'system',
    permission: 'auto',
    parameters: {},
    execute: impl || (async () => ({ success: true, content: `${name} done` })),
  }
}

function makeToolMap(tools: ToolDefinition[]): Map<string, ToolDefinition> {
  const map = new Map<string, ToolDefinition>()
  for (const t of tools) map.set(t.name, t)
  return map
}

// ── Tests ──

describe('QueryEngine inbound message draining', () => {
  it('drains unread bus messages addressed to "main" into the conversation', () => {
    const registry = mockProviderRegistry()
    const context = mockContext()
    const engine = new QueryEngine(registry, context, makeToolMap([]))

    const bus = new AgentMessageBus()
    bus.post('bg-1', 'main', 'Task done', 'The background task finished.')

    const injected = engine.drainInboundMessages(bus)

    expect(injected).toBe(1)
    expect(context.getMessages()).toContainEqual({
      role: 'user',
      content: '[Message from bg-1]: Task done\n\nThe background task finished.',
    })
  })

  it('drains unread bus messages addressed to the session id into the conversation', () => {
    const registry = mockProviderRegistry()
    const context = mockContext()
    const engine = new QueryEngine(registry, context, makeToolMap([]))
    engine.setSessionId('session-abc')

    const bus = new AgentMessageBus()
    bus.post('other-session', 'session-abc', 'Hello', 'Cross-session reply.')

    const injected = engine.drainInboundMessages(bus)

    expect(injected).toBe(1)
    expect(context.getMessages()).toContainEqual({
      role: 'user',
      content: '[Message from other-session]: Hello\n\nCross-session reply.',
    })
  })

  it('marks drained messages read so they are not re-injected', () => {
    const registry = mockProviderRegistry()
    const context = mockContext()
    const engine = new QueryEngine(registry, context, makeToolMap([]))

    const bus = new AgentMessageBus()
    bus.post('bg-1', 'main', 'Once', 'Only once.')

    expect(engine.drainInboundMessages(bus)).toBe(1)
    expect(engine.drainInboundMessages(bus)).toBe(0)
    expect(context.getMessages()).toHaveLength(1)
  })

  it('formatInboundMessage formats from / summary / message', () => {
    expect(
      formatInboundMessage({
        id: 'm1',
        from: 'alice',
        to: 'main',
        summary: 'Heads up',
        message: 'Body text',
        timestamp: new Date(),
        read: false,
        type: 'message',
      }),
    ).toBe('[Message from alice]: Heads up\n\nBody text')
  })
})

describe('QueryEngine', () => {
  describe('constructor and accessors', () => {
    it('should create engine with required dependencies', () => {
      const registry = mockProviderRegistry()
      const context = mockContext()
      const tools = makeToolMap([])
      const engine = new QueryEngine(registry, context, tools)

      expect(engine.getContext()).toBe(context)
      expect(engine.getTools()).toBe(tools)
      expect(engine.getPermission()).toBeInstanceOf(PermissionSystem)
    })

    it('should accept custom permission system', () => {
      const registry = mockProviderRegistry()
      const context = mockContext()
      const tools = makeToolMap([])
      const permission = new PermissionSystem('ask')
      const engine = new QueryEngine(registry, context, tools, permission)

      expect(engine.getPermission().getDefaultLevel()).toBe('ask')
    })

    it('should switch provider', () => {
      const registry = mockProviderRegistry()
      // Register a second provider
      registry.register('other', {
        config: {
          id: 'other',
          name: 'Other',
          protocol: 'openai-compatible',
          apiKey: 'k',
          models: [],
        },
        chat: async function* () {
          yield { type: 'stop' as const }
        },
        listModels: async () => [],
        healthCheck: async () => true,
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([]))
      expect(() => engine.switchProvider('other')).not.toThrow()
    })

    it('should throw switching to unknown provider', () => {
      const engine = new QueryEngine(mockProviderRegistry(), mockContext(), makeToolMap([]))
      expect(() => engine.switchProvider('nonexistent')).toThrow()
    })

    it('switchProvider propagates the model context window to the context manager', () => {
      const registry = mockProviderRegistry()
      registry.register('one-m', {
        config: {
          id: 'one-m',
          name: 'One M',
          protocol: 'openai-compatible',
          apiKey: 'k',
          models: [
            {
              id: 'model-1m',
              name: 'Model 1M',
              providerId: 'one-m',
              contextWindow: 1_000_000,
              maxOutput: 128_000,
              vision: false,
              status: 'active',
            },
          ],
        },
        chat: async function* () {
          yield { type: 'stop' as const }
        },
        listModels: async () => [],
        healthCheck: async () => true,
      })

      const context = mockContext() // no contextWindow → threshold stays at initial 0.9
      expect(context.getCompactionThreshold()).toBe(0.9)

      const engine = new QueryEngine(registry, context, makeToolMap([]))
      engine.switchProvider('one-m', 'model-1m')

      // maxTokens reflects the 1M window…
      expect(context.getMaxTokens()).toBe(1_000_000)
      // …and the adaptive compaction threshold recomputes to 1 - 50K/1M = 0.95
      expect(context.getCompactionThreshold()).toBe(0.95)
    })
  })

  describe('skills seam — setSkills', () => {
    it('setSkills overrides the skills provider injected into tool context', async () => {
      const fakeSkills = {
        get: () => undefined,
        list: () => [],
        has: () => false,
        buildSystemReminder: () => '',
      }

      // 捕获工具执行时注入的 ToolContext，验证 setSkills 覆盖默认 loader
      let capturedSkills: unknown
      const tool: ToolDefinition = {
        ...mockTool('capture-skills'),
        execute: async (_params, ctx) => {
          capturedSkills = ctx.skillsLoader
          return { success: true, content: 'captured' }
        },
      }

      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'capture-skills', input: {} },
        }
        yield { type: 'stop' }
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([tool]))
      engine.setSkills(fakeSkills)

      for await (const _ of engine.process('capture skills provider')) {
        /* drain */
      }

      expect(capturedSkills).toBe(fakeSkills)
    })
  })

  describe('process — input guards', () => {
    it('should ignore whitespace-only input without calling the provider', async () => {
      let called = false
      const registry = mockProviderRegistry(async function* () {
        called = true
        yield { type: 'text', content: 'should not happen' }
        yield { type: 'stop' }
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([]))

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('   \n\t ')) {
        chunks.push(chunk)
      }

      expect(chunks).toHaveLength(0)
      expect(called).toBe(false)
    })
  })

  describe('process — provider fallback', () => {
    it('should degrade to default provider when active provider fails', async () => {
      const goodChat = async function* (): AsyncGenerator<StreamChunk> {
        yield { type: 'text', content: 'fallback response' }
        yield { type: 'stop' }
      }
      const badChat = async function* (): AsyncGenerator<StreamChunk> {
        throw new Error('ECONNREFUSED: connection refused')
      }

      const registry = new ProviderRegistry([], 'good', 'good-model')
      registry.register('good', {
        config: {
          id: 'good',
          name: 'Good',
          protocol: 'openai-compatible' as const,
          apiKey: 'k',
          models: [
            {
              id: 'good-model',
              name: 'Good Model',
              providerId: 'good',
              contextWindow: 1000,
              maxOutput: 100,
              vision: false,
              status: 'active' as const,
            },
          ],
        },
        chat: goodChat,
        listModels: async () => [],
        healthCheck: async () => true,
      })
      registry.register('bad', {
        config: {
          id: 'bad',
          name: 'Bad',
          protocol: 'openai-compatible' as const,
          apiKey: 'k',
          models: [],
        },
        chat: badChat,
        listModels: async () => [],
        healthCheck: async () => true,
      })
      registry.switchProvider('bad', 'bad-model')

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([]))
      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('hi')) {
        chunks.push(chunk)
      }

      expect(chunks.some((c) => c.type === 'warning')).toBe(true)
      expect(chunks.some((c) => c.type === 'text' && c.content === 'fallback response')).toBe(true)
      // Active provider should now be the default (good)
      expect(registry.getActive().config.id).toBe('good')
    })
  })

  describe('process — basic conversation', () => {
    it('should yield text and stop chunks from provider', async () => {
      const registry = mockProviderRegistry(async function* () {
        yield { type: 'text', content: 'Hello, user!' }
        yield { type: 'stop' }
      })

      const context = mockContext()
      const engine = new QueryEngine(registry, context, makeToolMap([]))

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('hi')) {
        chunks.push(chunk)
      }

      expect(chunks).toHaveLength(2)
      expect(chunks[0]).toEqual({ type: 'text', content: 'Hello, user!' })
      expect(chunks[1]).toEqual({ type: 'stop' })
    })

    it('should add user and assistant messages to context', async () => {
      const registry = mockProviderRegistry(async function* () {
        yield { type: 'text', content: 'Response' }
        yield { type: 'stop' }
      })

      const context = mockContext()
      const engine = new QueryEngine(registry, context, makeToolMap([]))

      // consume all chunks
      for await (const _ of engine.process('user input')) {
        /* drain */
      }

      const messages = context.getMessages()
      expect(messages).toHaveLength(2)
      expect(messages[0]).toMatchObject({ role: 'user', content: 'user input' })
      expect(messages[1]).toMatchObject({ role: 'assistant', content: 'Response' })
    })

    it('should track assistant text across multiple text chunks', async () => {
      const registry = mockProviderRegistry(async function* () {
        yield { type: 'text', content: 'Part 1 ' }
        yield { type: 'text', content: 'Part 2' }
        yield { type: 'stop' }
      })

      const context = mockContext()
      const engine = new QueryEngine(registry, context, makeToolMap([]))

      for await (const _ of engine.process('hi')) {
        /* drain */
      }

      const msgs = context.getMessages()
      expect(msgs[1]?.content).toBe('Part 1 Part 2')
    })

    it('routes chat through the injected Llm seam when setLlm is called', async () => {
      const registry = mockProviderRegistry(async function* () {
        yield { type: 'text', content: 'from-registry' }
        yield { type: 'stop' }
      })
      const engine = new QueryEngine(registry, mockContext(), makeToolMap([]))

      engine.setLlm({
        chat: async function* () {
          yield { type: 'text', content: 'from-seam' }
          yield { type: 'stop' }
        },
      })

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('hi')) {
        chunks.push(chunk)
      }

      expect(chunks.some((c) => c.type === 'text' && c.content === 'from-seam')).toBe(true)
      expect(chunks.some((c) => c.type === 'text' && c.content === 'from-registry')).toBe(false)
    })
  })

  describe('process — session log chunk recording', () => {
    it('records assistant stream chunks on the primary process loop', async () => {
      const registry = mockProviderRegistry(async function* () {
        yield { type: 'text', content: 'hello' }
        yield { type: 'stop' }
      })

      const context = mockContext()
      const log = new SessionLog('engine-chunk-test')
      context.setLog(log)

      const engine = new QueryEngine(registry, context, makeToolMap([]))

      for await (const _ of engine.process('hi')) {
        /* drain */
      }

      expect(replayChunks(log)).toEqual(['hello'])
    })
  })

  describe('process — ctx.llm provider-swap (llm-replay)', () => {
    it('swapping ctx.llm to a replay makes the engine follow it', async () => {
      // 1. Record a "real" chat turn
      const { llm: realLlm, turns } = recordLlm({
        chat: async function* () {
          yield { type: 'text', content: 'recorded-response' }
          yield { type: 'stop' }
        },
      })
      const recorded: StreamChunk[] = []
      for await (const c of realLlm.chat({ model: 'm', messages: [] })) recorded.push(c)
      expect(turns).toHaveLength(1)

      // 2. Mount the replay under ctx.llm (swap the implementation)
      const ctx = new Context()
      mountLlm(ctx, replayLlm(turns))

      // 3. Engine injects that seam
      const engine = new QueryEngine(mockProviderRegistry(), mockContext(), makeToolMap([]))
      const llm = ctx.get<Llm>('llm')
      if (!llm) throw new Error('expected ctx.llm to be mounted')
      engine.setLlm(llm)

      // 4. Engine's chat goes through the replay, not the registry mock
      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('hi')) chunks.push(chunk)

      expect(chunks.some((c) => c.type === 'text' && c.content === 'recorded-response')).toBe(true)
      expect(chunks.some((c) => c.type === 'text' && c.content === 'Hello!')).toBe(false)
    })
  })

  describe('process — error handling', () => {
    it('should add error message to context and stop', async () => {
      const registry = mockProviderRegistry(async function* () {
        yield { type: 'error', error: 'API unavailable' }
      })

      const context = mockContext()
      const engine = new QueryEngine(registry, context, makeToolMap([]))

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('hi')) {
        chunks.push(chunk)
      }

      expect(chunks).toHaveLength(1)
      expect(chunks[0]?.type).toBe('error')
      expect(context.getMessages()).toHaveLength(2) // user + error line
      // #23: client error must persist as a system line, not model (assistant) output
      expect(context.getMessages()[1]).toMatchObject({ role: 'system' })
    })
  })

  describe('process — tool execution', () => {
    it('should execute tool and yield tool_result', async () => {
      let toolCalled = false
      const tool = mockTool('read', async () => {
        toolCalled = true
        return { success: true, content: 'file content' }
      })

      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'read', input: { path: '/f.txt' } },
        }
        yield { type: 'stop' }
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([tool]))

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('read file')) {
        chunks.push(chunk)
      }

      expect(toolCalled).toBe(true)
      const toolResult = chunks.find((c) => c.type === 'tool_result')
      expect(toolResult).toMatchObject({
        type: 'tool_result',
        tool_use_id: 'call_1',
        content: 'file content',
      })
    })

    it('should return error for unknown tool', async () => {
      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'nonexistent', input: {} },
        }
        yield { type: 'stop' }
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([]))

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('do thing')) {
        chunks.push(chunk)
      }

      const result = chunks.find((c) => c.type === 'tool_result')
      expect(result?.content).toContain('Unknown tool')
    })

    it('should block tool when permission is ask', async () => {
      const tool: ToolDefinition = {
        ...mockTool('bash'),
        permission: 'ask',
      }

      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'rm -rf /' } },
        }
        yield { type: 'stop' }
      })

      const permission = new PermissionSystem('default')
      const engine = new QueryEngine(registry, mockContext(), makeToolMap([tool]), permission)

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('run command')) {
        chunks.push(chunk)
      }

      const result = chunks.find((c) => c.type === 'tool_result')
      expect(result?.content).toContain('requires approval under "default" mode')
    })
  })

  describe('hook integration', () => {
    it('should invoke PreToolUse hook and allow execution', async () => {
      const tool = mockTool('read')
      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'read', input: {} },
        }
        yield { type: 'stop' }
      })

      const hooks = new HookEngine()
      let hookCalled = false
      hooks.register({
        event: 'PreToolUse',
        handler: async (ctx) => {
          hookCalled = true
          expect(ctx.toolName).toBe('read')
          return { allowed: true }
        },
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([tool]))
      engine.setHookEngine(hooks)

      for await (const _ of engine.process('read')) {
        /* drain */
      }

      expect(hookCalled).toBe(true)
    })

    it('should block tool when PreToolUse hook denies', async () => {
      const tool = mockTool('bash')
      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'bash', input: { command: 'rm' } },
        }
        yield { type: 'stop' }
      })

      const hooks = new HookEngine()
      hooks.register({
        event: 'PreToolUse',
        handler: async () => ({ allowed: false, reason: 'Dangerous command blocked' }),
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([tool]))
      engine.setHookEngine(hooks)

      const chunks: StreamChunk[] = []
      for await (const chunk of engine.process('run')) {
        chunks.push(chunk)
      }

      const result = chunks.find((c) => c.type === 'tool_result')
      expect(result?.content).toContain('Dangerous command blocked')
    })

    it('should invoke PostToolUse hook after execution', async () => {
      const tool = mockTool('read')
      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'read', input: {} },
        }
        yield { type: 'stop' }
      })

      const hooks = new HookEngine()
      let postCalled = false
      hooks.register({
        event: 'PostToolUse',
        handler: async (ctx) => {
          postCalled = true
          expect(ctx.toolResult?.success).toBe(true)
          return { allowed: true }
        },
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([tool]))
      engine.setHookEngine(hooks)

      for await (const _ of engine.process('read')) {
        /* drain */
      }

      expect(postCalled).toBe(true)
    })

    it('should merge modified input from PreToolUse hook', async () => {
      let receivedParams: Record<string, unknown> = {}
      const tool: ToolDefinition = {
        ...mockTool('write'),
        execute: async (params) => {
          receivedParams = params
          return { success: true, content: 'ok' }
        },
      }

      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'call_1', name: 'write', input: { path: '/tmp/x' } },
        }
        yield { type: 'stop' }
      })

      const hooks = new HookEngine()
      hooks.register({
        event: 'PreToolUse',
        handler: async () => ({
          allowed: true,
          modifiedInput: { safe: true },
        }),
      })

      const engine = new QueryEngine(registry, mockContext(), makeToolMap([tool]))
      engine.setHookEngine(hooks)

      for await (const _ of engine.process('write')) {
        /* drain */
      }

      expect(receivedParams).toMatchObject({ path: '/tmp/x', safe: true })
    })
  })

  describe('process — context compaction', () => {
    it('should check compaction before processing', async () => {
      const registry = mockProviderRegistry(async function* () {
        yield { type: 'text', content: 'ok' }
        yield { type: 'stop' }
      })

      // Use a small maxTokens so compaction triggers
      const context = new ContextManager({ maxTokens: 500, compactionThreshold: 0.5 })
      // Add many messages to trigger compaction (each ~100 tokens with estimator)
      for (let i = 0; i < 35; i++) {
        context.addMessage({ role: 'user', content: `msg ${i}`.repeat(100) })
      }

      const engine = new QueryEngine(registry, context, makeToolMap([]))

      for await (const _ of engine.process('hi')) {
        /* drain */
      }

      // After compaction + new messages, should be ≤ 22 (20 kept + user + assistant)
      expect(context.getMessageCount()).toBeLessThanOrEqual(22)
    })
  })

  describe('process — tool result context', () => {
    it('should add tool_use and tool_result to context', async () => {
      const tool = mockTool('read')
      const registry = mockProviderRegistry(async function* () {
        yield {
          type: 'tool_use',
          toolUse: { type: 'tool_use', id: 'cu1', name: 'read', input: { p: 1 } },
        }
        yield { type: 'stop' }
      })

      const ctx = mockContext()
      const engine = new QueryEngine(registry, ctx, makeToolMap([tool]))

      for await (const _ of engine.process('read')) {
        /* drain */
      }

      const msgs = ctx.getMessages()
      // user + [assistant with tool_use] + [user with tool_result]
      expect(msgs.length).toBeGreaterThanOrEqual(3)
    })
  })
})

// ============================================================
// Cross-Session Inbound Config
// ============================================================

describe('filterExpiredMessages', () => {
  const now = Date.now()
  const mkMsg = (ageMs: number): AgentMessage => ({
    id: 'm',
    from: 'a',
    to: 'b',
    summary: 's',
    message: 'x',
    timestamp: new Date(now - ageMs),
    read: false,
    type: 'message',
  })

  it('keeps messages within the expiry window', () => {
    const msgs = [mkMsg(0), mkMsg(10_000)]
    expect(filterExpiredMessages(msgs, 300, now)).toHaveLength(2)
  })

  it('drops messages older than the expiry window', () => {
    const msgs = [mkMsg(0), mkMsg(301_000)]
    expect(filterExpiredMessages(msgs, 300, now)).toHaveLength(1)
  })

  it('drops everything when expiry is zero', () => {
    // Any real message is older than the instant it was written (age > 0).
    const msgs = [mkMsg(1)]
    expect(filterExpiredMessages(msgs, 0, now)).toHaveLength(0)
  })
})

describe('Cross-session inbound config', () => {
  const makeEngine = () => {
    const registry = mockProviderRegistry()
    const ctx = mockContext()
    return new QueryEngine(registry, ctx, new Map())
  }

  it('stores cross-session config via setCrossSessionConfig', () => {
    const engine = makeEngine()
    engine.setCrossSessionConfig({ crossSessionInbound: 'deny', dialogExpiry: 600 })
    // setSessionId is needed for pollCrossSessionInbox
    engine.setSessionId('test-session-config')
    // verify no throw — config is accepted
  })

  it('defaults to ask mode before setCrossSessionConfig is called', async () => {
    const engine = makeEngine()
    engine.setSessionId('test-session-default')

    // In 'ask' mode (default), pollCrossSessionInbox should not throw
    // even when the inbox directory doesn't exist yet
    await expect(engine.pollCrossSessionInbox()).resolves.toBeUndefined()
  })

  it('pollCrossSessionInbox succeeds in deny mode', async () => {
    const engine = makeEngine()
    engine.setCrossSessionConfig({ crossSessionInbound: 'deny', dialogExpiry: 300 })
    engine.setSessionId('test-session-deny')

    // Deny mode should silently succeed (no messages to discard)
    await expect(engine.pollCrossSessionInbox()).resolves.toBeUndefined()
  })

  it('pollCrossSessionInbox succeeds in allow mode', async () => {
    const engine = makeEngine()
    engine.setCrossSessionConfig({ crossSessionInbound: 'allow', dialogExpiry: 300 })
    engine.setSessionId('test-session-allow')

    // Allow mode should silently succeed (no messages to forward)
    await expect(engine.pollCrossSessionInbox()).resolves.toBeUndefined()
  })
})

// ============================================================
// SelfCritique — 注入 Llm 缝
// ============================================================

describe('SelfCritique — critique chat seam', () => {
  it('routes critique chat through the injected llm, not registry.chat', async () => {
    // registry.chat 若被调用则打标记——探测 critique 是否绕过注入的 llm 缝
    let registryChatCalled = false
    const registry = mockProviderRegistry(async function* () {
      registryChatCalled = true
      yield {
        type: 'text',
        content: JSON.stringify({
          safe: false,
          correct: false,
          necessary: false,
          reasoning: 'registry',
        }),
      }
      yield { type: 'stop' }
    })

    const critique = new SelfCritique({ enabled: true })
    const llm: Llm = {
      chat: async function* () {
        yield {
          type: 'text',
          content: JSON.stringify({ safe: true, correct: true, necessary: true, reasoning: 'ok' }),
        }
        yield { type: 'stop' }
      },
    }

    const result = await critique.critique('Bash', { command: 'ls' }, registry, llm)

    expect(result).not.toBeNull()
    expect(result?.safe).toBe(true)
    expect(result?.score).toBe(1)
    expect(registryChatCalled).toBe(false)
  })

  it('falls back to registry.chat when no llm is provided', async () => {
    const registry = mockProviderRegistry(async function* () {
      yield {
        type: 'text',
        content: JSON.stringify({
          safe: true,
          correct: true,
          necessary: true,
          reasoning: 'registry fallback',
        }),
      }
      yield { type: 'stop' }
    })

    const critique = new SelfCritique({ enabled: true })
    const result = await critique.critique('Bash', { command: 'ls' }, registry)

    expect(result).not.toBeNull()
    expect(result?.safe).toBe(true)
  })
})
