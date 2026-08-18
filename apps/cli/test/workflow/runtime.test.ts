import { describe, it, expect } from 'vitest'
import type { QueryEngine } from '../../src/core/engine'
import type { ProviderRegistry, ProviderInstance, ChatRequest } from '../../src/providers/registry'
import type { StreamChunk, ToolDefinition } from '../../src/shared/index.ts'
import { runWorkflow } from '../../src/workflow/runtime'
import { createBudget } from '../../src/workflow/budget'
import { PermissionSystem } from '../../src/core/permission'

function createMockProvider(chunks: StreamChunk[]): ProviderInstance {
  return {
    config: {
      id: 'mock',
      name: 'Mock',
      protocol: 'openai-compatible',
      apiKey: '',
      models: [],
    },
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

function createMockEngine(provider: ProviderInstance): QueryEngine {
  const registry = {
    getActive: () => provider,
    getActiveModel: () => 'mock-model',
    findModel: () => undefined,
    switchProvider: (_id: string, _model?: string) => {},
    async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
      yield* provider.chat(req)
    },
  } as unknown as ProviderRegistry

  const toolRegistry = new Map<string, ToolDefinition>()

  return {
    getRegistry: () => registry,
    getTools: () => toolRegistry,
    getPermission: () => new PermissionSystem('auto'),
    getLlm: () => undefined,
  } as unknown as QueryEngine
}

describe('Budget', () => {
  it('tracks token spending', () => {
    const budget = createBudget(1000)
    expect(budget.total).toBe(1000)
    expect(budget.spent()).toBe(0)
    expect(budget.remaining()).toBe(1000)

    budget.consume(300)
    expect(budget.spent()).toBe(300)
    expect(budget.remaining()).toBe(700)
  })

  it('throws when budget exceeded', () => {
    const budget = createBudget(100)
    budget.consume(80)
    expect(() => budget.consume(30)).toThrow('Token budget exceeded')
  })

  it('returns Infinity remaining when budget is unlimited', () => {
    const budget = createBudget(null)
    expect(budget.total).toBeNull()
    expect(budget.remaining()).toBe(Infinity)
    budget.consume(10000)
    expect(budget.remaining()).toBe(Infinity)
  })
})

describe('Runtime', () => {
  it('executes a simple workflow script and returns a result', async () => {
    const provider = createMockProvider([
      { type: 'text', content: 'Hello from agent!' },
      { type: 'stop' },
    ])
    const engine = createMockEngine(provider)

    const script = `
      const greeting = await agent("say hello")
      return greeting
    `

    const result = await runWorkflow(script, engine, {}, null)
    expect(result.runId).toMatch(/^run-/)
    expect(result.result).toBe('Hello from agent!')
  })

  it('passes args into the workflow script', async () => {
    const provider = createMockProvider([{ type: 'text', content: 'done' }, { type: 'stop' }])
    const engine = createMockEngine(provider)

    const script = `
      return { input: args.input, count: args.count }
    `

    const result = await runWorkflow(script, engine, { input: 'test', count: 42 }, null)
    expect(result.result).toEqual({ input: 'test', count: 42 })
  })

  it('captures errors from the workflow script', async () => {
    const provider = createMockProvider([{ type: 'text', content: 'ok' }, { type: 'stop' }])
    const engine = createMockEngine(provider)

    const script = `
      throw new Error("workflow failure")
    `

    await expect(runWorkflow(script, engine, {}, null)).rejects.toThrow('workflow failure')
  })
})

describe('workflow sandbox escape prevention', () => {
  function escapeMockEngine(): QueryEngine {
    return {
      getRegistry: () =>
        ({
          getActive: () => null,
          getActiveModel: () => 'mock',
          switchProvider: () => {},
        }) as unknown as ProviderRegistry,
      getTools: () => new Map<string, ToolDefinition>(),
      getPermission: () => new PermissionSystem('auto'),
      getLlm: () => undefined,
    } as unknown as QueryEngine
  }

  const escapeTests = [
    {
      name: 'eval escape',
      script: `eval("process")`,
    },
    {
      name: 'dynamic import escape',
      script: `await import("node:fs")`,
    },
    {
      name: 'require escape',
      script: `require("node:fs")`,
    },
    {
      name: 'Function constructor escape',
      script: `new Function("return process")`,
    },
    {
      name: 'process access',
      script: `process.cwd()`,
    },
    {
      name: 'fetch escape',
      script: `fetch("http://localhost")`,
    },
    {
      name: 'setTimeout escape',
      script: `setTimeout(() => {}, 100)`,
    },
  ]

  const mockEngine = escapeMockEngine()

  for (const { name, script } of escapeTests) {
    it(`blocks ${name}`, async () => {
      await expect(runWorkflow(script, mockEngine)).rejects.toThrow()
    })
  }

  it('allows whitelisted APIs (agent, log, args)', async () => {
    // Need a real mock provider for the agent call to work
    const provider = createMockProvider([{ type: 'text', content: 'ok' }, { type: 'stop' }])
    const engine = createMockEngine(provider)

    const result = await runWorkflow(
      `log("hello"); return { ok: true, hasArgs: args !== undefined }`,
      engine,
      { test: true },
    )
    expect(result.result).toEqual({ ok: true, hasArgs: true })
  })
})
