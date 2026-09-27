import { describe, it, expect } from 'vitest'
import { ProviderRegistry } from '../../src/providers/registry'
import type { ProviderInstance, ChatRequest } from '../../src/providers/registry'
import type { StreamChunk, ToolDefinition } from '../../src/shared/index.ts'
import { workflowAgent } from '../../src/workflow/primitives/agent'

/**
 * `workflowAgent` 的 provider 覆盖必须**只属于这次调用**。
 *
 * 注释写的是 "switch temporarily"，但代码只是 `registry.switchProvider(...)` 就走了
 * —— 没有任何还原点。而 registry 的 active 是**会话级**的：`SubAgent` 在
 * `runExecution` 里读 `registry.getActiveModel()`、`registry.chat` 按 active 路由，
 * 引擎的页脚与 `/model` 面板读的也是它。于是一个 workflow 里的一次
 * `agent('…', { provider: 'x' })` 会把这台机器的整个会话换到 x 上，且不再换回来。
 *
 * 用**真** `ProviderRegistry`（不是 mock 一个空 `switchProvider`）：这条性质的全部内容
 * 就是「registry 的状态变了没有」，假 registry 会让它改前改后都绿。
 */
type Seen = Array<{ providerId: string; model: string }>

function makeProvider(
  id: string,
  modelId: string,
  seen: Seen,
  opts: { fail?: boolean } = {},
): ProviderInstance {
  return {
    config: {
      id,
      name: id,
      protocol: 'openai-compatible' as const,
      apiKey: 'k',
      models: [
        {
          id: modelId,
          name: modelId,
          providerId: id,
          contextWindow: 1000,
          maxOutput: 100,
          vision: false,
          status: 'active' as const,
        },
      ],
    },
    async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
      // 记的是「这一刻 registry 把请求路由给了谁」—— 覆盖生效与否的直接读数。
      seen.push({ providerId: id, model: req.model })
      if (opts.fail) throw new Error(`${id} unreachable`)
      yield { type: 'text', content: `hello from ${id}` }
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

function makeRegistry(seen: Seen, opts: { betaFails?: boolean } = {}): ProviderRegistry {
  const registry = new ProviderRegistry([], 'alpha', 'alpha-model')
  registry.register('alpha', makeProvider('alpha', 'alpha-model', seen))
  registry.register('beta', makeProvider('beta', 'beta-model', seen, { fail: opts.betaFails }))
  return registry
}

const NO_TOOLS = new Map<string, ToolDefinition>()

describe('workflowAgent — provider 覆盖的作用域', () => {
  it('跑的过程中确实切到了 beta（正控），跑完必须切回 alpha', async () => {
    const seen: Seen = []
    const registry = makeRegistry(seen)

    await workflowAgent('hi', registry, NO_TOOLS, { provider: 'beta', model: 'beta-model' })

    // 正控：没有这一条，「把 switch 整个删掉」也能让下面的还原断言变绿 ——
    // 那就不是「覆盖生效且被还原」，而是「覆盖从来没生效过」。
    expect(seen).toEqual([{ providerId: 'beta', model: 'beta-model' }])

    expect(registry.getActive().config.id).toBe('alpha')
    expect(registry.getActiveModel()).toBe('alpha-model')
  })

  it('负控：没有覆盖时 active 从头到尾没被动过', async () => {
    const seen: Seen = []
    const registry = makeRegistry(seen)

    await workflowAgent('hi', registry, NO_TOOLS, {})

    expect(seen).toEqual([{ providerId: 'alpha', model: 'alpha-model' }])
    expect(registry.getActive().config.id).toBe('alpha')
    // 这条挡的是另一种「修法」：无条件把 active 重置成默认 provider。
    expect(registry.getActiveModel()).toBe('alpha-model')
  })

  it('子代理失败时，还原照样发生（还原点在 finally）', async () => {
    const seen: Seen = []
    const registry = makeRegistry(seen, { betaFails: true })

    await expect(
      workflowAgent('hi', registry, NO_TOOLS, { provider: 'beta', model: 'beta-model' }),
    ).rejects.toThrow(/Sub-agent execution failed/)

    // 上面那条 `rejects` 是这条用例的自证：**先证明它真的走到了失败那半** —— 否则
    // 「还原了」可能只是走了成功路径，与上一条用例测的是同一件事（假绿的老形状）。
    expect(seen).toEqual([{ providerId: 'beta', model: 'beta-model' }])
    expect(registry.getActive().config.id).toBe('alpha')
    expect(registry.getActiveModel()).toBe('alpha-model')
  })
})
