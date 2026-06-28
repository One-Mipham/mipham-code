import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { StreamChunk, ToolDefinition, ToolResult, Message } from '../../src/shared/index.ts'
import { QueryEngine } from '../../src/core/engine'
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
    config: { id: 'test', name: 'Test', protocol: 'openai-compatible' as const, apiKey: 'key', models: [] },
    chat: chatImpl || (async function* () {
      yield { type: 'text' as const, content: 'Hello!' }
      yield { type: 'stop' as const }
    }),
    listModels: async () => [],
    healthCheck: async () => true,
  }
  registry.register('test', mockProvider)
  return registry
}

function mockContext(): ContextManager {
  return new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 })
}

function mockTool(name: string, impl?: (params: Record<string, unknown>) => Promise<ToolResult>): ToolDefinition {
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
        config: { id: 'other', name: 'Other', protocol: 'openai-compatible', apiKey: 'k', models: [] },
        chat: async function* () { yield { type: 'stop' as const } },
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
      for await (const _ of engine.process('user input')) { /* drain */ }

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

      for await (const _ of engine.process('hi')) { /* drain */ }

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

      const permission = new PermissionSystem('auto')
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

      for await (const _ of engine.process('read')) { /* drain */ }

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

      for await (const _ of engine.process('read')) { /* drain */ }

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

      for await (const _ of engine.process('write')) { /* drain */ }

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

      for await (const _ of engine.process('hi')) { /* drain */ }

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

      for await (const _ of engine.process('read')) { /* drain */ }

      const msgs = ctx.getMessages()
      // user + [assistant with tool_use] + [user with tool_result]
      expect(msgs.length).toBeGreaterThanOrEqual(3)
    })
  })
})
