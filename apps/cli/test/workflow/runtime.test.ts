import { describe, it, expect } from 'vitest'
import type { QueryEngine } from '../../src/core/engine'
import type { ProviderRegistry, ProviderInstance, ChatRequest } from '../../src/providers/registry'
import type { StreamChunk, ToolDefinition } from '../../src/shared/index.ts'
import { runWorkflow } from '../../src/workflow/runtime'
import { createBudget } from '../../src/workflow/budget'
import { loadJournal } from '../../src/workflow/journal'
import { getEventBus } from '../../src/workflow/event-bus'
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
    getPermission: () => new PermissionSystem('self'),
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

  /**
   * `agent('x')` 不 await 时，它的拒绝原先没有任何人接 ⇒ 落到**进程级**
   * `unhandledRejection`（崩溃上报是**无条件安装**的）⇒ `handleFatal` → `exit(1)`：一次
   * 甩手扇出就把 CLI 关掉，理由是「workflow 脚本里的未处理拒绝」。失败本身是脚本的事，
   * 但它**不该有这条通往进程的路径** —— 所以判据有三条，缺一条都不算验到：
   *   ① 这次 run 仍然正常返回（没被拒绝带走）；
   *   ② 失败的那次调用仍拿到 `agent:start`/`agent:end` 一对且 `success: false`，
   *      并落进 journal 的 `error` 字段（**可归因**，不是被吞掉）；
   *   ③ 宿主 realm 上没有任何未处理拒绝真正逃出去。
   */
  it('未 await 的 agent() 失败由这次运行接住，而不是交给进程', async () => {
    const provider = createMockProvider([])
    provider.chat = async function* () {
      throw new Error('provider exploded')
    }
    const engine = createMockEngine(provider)

    const bus = getEventBus()
    let settleEnd: (e: { success: boolean }) => void = () => {}
    const ended = new Promise<{ success: boolean }>((resolve) => {
      settleEnd = resolve
    })
    // Stored rather than `bus.once`: the bus is a process-wide singleton, and
    // `off('agent:end')` would take other listeners down with it.
    const onEnd = (e: unknown) => settleEnd(e as { success: boolean })
    bus.on('agent:end', onEnd)
    const escaped: unknown[] = []
    const onUnhandled = (reason: unknown) => {
      escaped.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)

    try {
      // 有意不 await：这正是那个形状。
      const script = `
        agent("fire and forget")
        return "finished"
      `
      const result = await runWorkflow(script, engine, {}, null)
      expect(result.result).toBe('finished')

      expect((await ended).success).toBe(false)

      const entry = loadJournal(result.runId).find((e) => e.type === 'agent')
      expect(entry?.error).toContain('provider exploded')
      // 失败不写进 `result`：resume 缓存以 `result !== undefined` 为准，写进去会让
      // 一次失败在重放时变成一条成功的缓存答案。
      expect(entry?.result).toBeUndefined()

      // 未处理的拒绝是在**微任务清空后**上报的 —— 多让事件循环跑两圈，好让真正逃出去
      // 的那条落到监听器上，而不是让用例在它上报前就结束。
      await new Promise((resolve) => setImmediate(resolve))
      await new Promise((resolve) => setImmediate(resolve))
      expect(escaped).toEqual([])
    } finally {
      bus.off('agent:end', onEnd)
      process.off('unhandledRejection', onUnhandled)
    }
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
      getPermission: () => new PermissionSystem('self'),
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
