import { describe, expect, it, vi, afterEach } from 'vitest'
import { SubAgent } from '../../src/agent/sub-agent'
import type { SubAgentServices } from '../../src/agent/services'
import type { ProviderRegistry, ProviderInstance, ChatRequest } from '../../src/providers/registry'
import type { ToolDefinition, StreamChunk } from '../../src/shared/index.ts'
import type { HookEngine } from '../../src/core/hooks'
import type { ConstitutionLoader } from '../../src/core/constitution-loader'
import type { InferenceHookConfig } from '../../src/shared/index.ts'

/**
 * 子代理的工具循环是一条**独立的推理路径**。它曾经只跑过权限闸门：
 * PreToolUse 钩子在五个构造点都被递了 `undefined`，CRSI 规则、SIS 预检、
 * 宪法、自检与 PreInference DLP 一次都没到过这里。于是同一个 `Write`
 * 在主循环被宪法挡下、下一层却原样执行。
 *
 * 这一组用例钉的是「闸门在子代理里真的会红」，不是「闸门存在」。
 */

interface Harness {
  registry: ProviderRegistry
  requests: ChatRequest[]
  executed: number
}

/**
 * `first` 只在第一次请求时发；之后每次都是 `then`。
 *
 * 一个每次都吐 `tool_use` 的假 provider 会让循环一路撞到 maxTurns，
 * 「工具跑了几次」就不再是「有没有被挡下」的读数。
 */
function makeHarness(first: StreamChunk[], then: StreamChunk[] = []): Harness {
  const h: Harness = {
    registry: undefined as unknown as ProviderRegistry,
    requests: [],
    executed: 0,
  }
  const provider: ProviderInstance = {
    config: { id: 'mock', name: 'Mock', protocol: 'openai-compatible', apiKey: '', models: [] },
    async *chat(req: ChatRequest) {
      const chunks = h.requests.length === 0 ? first : then
      h.requests.push(req)
      for (const chunk of chunks) yield chunk
    },
    async listModels() {
      return []
    },
    async healthCheck() {
      return true
    },
  }
  const models = [
    {
      id: 'mock-model',
      name: 'Mock Model',
      providerId: 'mock',
      contextWindow: 128000,
      maxOutput: 4096,
    },
  ]
  h.registry = {
    getActive: () => provider,
    getActiveModel: () => 'mock-model',
    listModels: () => models,
    findModel: (id: string) => models.find((m) => m.id === id),
    async *chat(req: ChatRequest) {
      yield* provider.chat(req)
    },
  } as unknown as ProviderRegistry
  return h
}

function writeTool(h: Harness): ToolDefinition {
  return {
    name: 'Write',
    description: 'writes a file',
    category: 'file',
    permission: 'self',
    parameters: { type: 'object', properties: {} },
    execute: async () => {
      h.executed++
      return { success: true, content: 'written' }
    },
  }
}

/** 第一轮抛一个 tool_use；后续轮次正常收尾 —— 工具若真跑了，`executed` 加一。 */
const ONE_WRITE: StreamChunk[] = [
  {
    type: 'tool_use',
    toolUse: {
      type: 'tool_use',
      id: '1',
      name: 'Write',
      input: { file_path: 'x.ts', content: "const apiKey = 'sk-live-123456789'" },
    },
  },
  { type: 'text', content: '' },
  { type: 'stop' },
]

const DONE: StreamChunk[] = [{ type: 'text', content: 'done' }, { type: 'stop' }]

function constitution(): ConstitutionLoader {
  return {
    getPrinciplesForTool: () => [
      {
        id: 'no-credential-leak',
        text: 'no keys in files',
        enforce: 'block',
        // 与 `src/core/alignment-vocabulary.json` 逐字相同
        audit_pattern:
          '(apiKey|api_key|password|secret|token|credential)\\s*[=:]\\s*[\'"][^\'"]{8,}',
      },
    ],
  } as unknown as ConstitutionLoader
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('子代理的工具闸门', () => {
  it('宪法在子代理里挡住了工具调用', async () => {
    const h = makeHarness(ONE_WRITE, DONE)
    const services: SubAgentServices = {
      gate: { crsiPreToolHook: true, registry: h.registry, constitution },
    }
    const sub = new SubAgent(
      h.registry,
      new Map([['Write', writeTool(h)]]),
      undefined,
      undefined,
      undefined,
      undefined,
      services,
    )

    await sub.execute('write it', 'write', { type: 'general' })

    expect(h.executed, '宪法拦下的工具仍然执行了').toBe(0)
    // 拦下的原因要回到模型眼前，否则它只会换个写法重试。
    const second = h.requests[1]
    expect(JSON.stringify(second!.messages)).toContain('no-credential-leak')
  })

  it('（对照）同一条调用在没有宪法时照常执行', async () => {
    const h = makeHarness(ONE_WRITE, DONE)
    const services: SubAgentServices = { gate: { crsiPreToolHook: true, registry: h.registry } }
    const sub = new SubAgent(
      h.registry,
      new Map([['Write', writeTool(h)]]),
      undefined,
      undefined,
      undefined,
      undefined,
      services,
    )

    await sub.execute('write it', 'write', { type: 'general' })

    expect(h.executed).toBe(1)
  })

  it('PreToolUse 钩子经由 services 到达子代理', async () => {
    const h = makeHarness(ONE_WRITE, DONE)
    const seen: string[] = []
    // 只关心 PreToolUse；其余生命周期钩子在这次运行里是噪音，用 Proxy 补成无操作，
    // 这样钩子表将来增长也不会让这条用例变成「缺一个方法」的假红。
    const hookEngine = new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (prop === 'executePreToolUse') {
            return async (name: string) => {
              seen.push(name)
              return { allowed: false, reason: 'hook says no' }
            }
          }
          return async () => ({ allowed: true })
        },
      },
    ) as unknown as HookEngine
    const services: SubAgentServices = {
      gate: { crsiPreToolHook: true, registry: h.registry, hookEngine },
    }
    const sub = new SubAgent(
      h.registry,
      new Map([['Write', writeTool(h)]]),
      undefined,
      undefined,
      undefined,
      undefined,
      services,
    )

    await sub.execute('write it', 'write', { type: 'general' })

    expect(seen).toContain('Write')
    expect(h.executed).toBe(0)
    expect(JSON.stringify(h.requests[1]!.messages)).toContain('hook says no')
  })
})

describe('子代理的 PreInference DLP', () => {
  const hookConfig: InferenceHookConfig = {
    endpoint: 'https://dlp.example.invalid/v1/check',
    signing_secret: 'mis_test',
    timeout: 1000,
    on_failure: 'fail-closed',
    organization_id: 'org-test',
    headers: {},
  }

  it('判定 deny 时在 provider 之前抛出，一次请求都不发出去', async () => {
    const h = makeHarness([{ type: 'text', content: 'should never be reached' }, { type: 'stop' }])
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ verdict: 'deny', reason: 'PII' }), { status: 200 }),
      )

    const sub = new SubAgent(h.registry, new Map(), undefined, undefined, undefined, undefined, {
      gate: { crsiPreToolHook: true, registry: h.registry },
      inferenceHook: hookConfig,
    })

    await expect(sub.execute('send secrets', 'leak', { type: 'general' })).rejects.toThrow(/PII/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(h.requests, 'DLP 拦下后仍然请求了模型').toHaveLength(0)
  })

  it('（对照）判定 allow 时照常请求模型', async () => {
    const h = makeHarness([{ type: 'text', content: 'ok' }, { type: 'stop' }])
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ verdict: 'allow' }), { status: 200 }),
    )

    const sub = new SubAgent(h.registry, new Map(), undefined, undefined, undefined, undefined, {
      gate: { crsiPreToolHook: true, registry: h.registry },
      inferenceHook: hookConfig,
    })

    const result = await sub.execute('say ok', 'ok', { type: 'general' })
    expect(result).toContain('ok')
    expect(h.requests).toHaveLength(1)
  })
})
