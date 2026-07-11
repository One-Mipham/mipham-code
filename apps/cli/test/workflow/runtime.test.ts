import { describe, it, expect } from 'vitest'
import { runWorkflow } from '../../src/workflow/runtime'
import { createBudget } from '../../src/workflow/budget'
import type { QueryEngine } from '../../src/core/engine'
import type { ProviderRegistry, ProviderInstance, ChatRequest } from '../../src/providers/registry'
import type { StreamChunk, ToolDefinition } from '../../src/shared/index.ts'

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
    switchProvider: (_id: string, _model?: string) => {},
  } as unknown as ProviderRegistry

  const toolRegistry = new Map<string, ToolDefinition>()

  return {
    getRegistry: () => registry,
    getTools: () => toolRegistry,
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
    const provider = createMockProvider([
      { type: 'text', content: 'done' },
      { type: 'stop' },
    ])
    const engine = createMockEngine(provider)

    const script = `
      return { input: args.input, count: args.count }
    `

    const result = await runWorkflow(script, engine, { input: 'test', count: 42 }, null)
    expect(result.result).toEqual({ input: 'test', count: 42 })
  })

  it('captures errors from the workflow script', async () => {
    const provider = createMockProvider([
      { type: 'text', content: 'ok' },
      { type: 'stop' },
    ])
    const engine = createMockEngine(provider)

    const script = `
      throw new Error("workflow failure")
    `

    await expect(runWorkflow(script, engine, {}, null)).rejects.toThrow('workflow failure')
  })
})
