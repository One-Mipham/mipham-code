import { describe, it, expect } from 'vitest'
import type { StreamChunk, ToolDefinition, ToolResult } from '../../src/shared/index.ts'
import { QueryEngine, filterExpiredMessages } from '../../src/core/engine'
import type { AgentMessage } from '../../src/agent/message-bus'
import { ContextManager } from '../../src/core/context'
import { PermissionSystem } from '../../src/core/permission'
import { HookEngine } from '../../src/core/hooks'
import { ProviderRegistry } from '../../src/providers/registry'

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
      expect(context.getMessages()).toHaveLength(2) // user + error assistant
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
      expect(result?.content).toContain('requires user approval')
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
