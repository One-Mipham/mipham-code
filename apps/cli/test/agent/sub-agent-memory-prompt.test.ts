/**
 * 子代理必须**拿到它声明的记忆**。
 *
 * 观测点与 `sub-agent-permission-prompt.test.ts` 同：provider 的 `ChatRequest.systemPrompt`
 * —— 上下文里存了什么这里看不见，正是本用例要的。
 *
 * 缺陷形状：`agent-context.ts` 把 memory 拼进系统提示、也把它设进了自己那个
 * `ContextManager`；但 `sub-agent.ts` 紧跟着用**没拼记忆的那份**（局部变量 `systemPrompt`）
 * 又设了一遍，而请求那一行读的正是那个局部变量 —— **从不读上下文**。两处叠加，`memory:`
 * 在定义里写着、在 `/agents` 面板里显示着，跑起来一个字都到不了模型手里。
 *
 * 所以判据落在**真正发出去的那份**上，不是「上下文里有没有记忆」——后者从第一天起就是绿的，
 * 也正是这个缺陷能一直躲着的原因。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { SubAgent } from '../../src/agent/sub-agent'
import type { AgentDefinition } from '../../src/agent/types'
import type { ProviderRegistry, ProviderInstance, ChatRequest } from '../../src/providers/registry'
import type { StreamChunk, ToolDefinition } from '../../src/shared/index.ts'
import { MIPHAM_DIR } from '../../src/shared/constants.ts'

const AGENT_NAME = 'memory-prompt-probe'
const MEMORY_DIR = join(process.cwd(), MIPHAM_DIR, 'agent-memory-local', AGENT_NAME)
const MEMORY_TEXT = '本代理记得：用户偏好用 tabs，不用空格。'

beforeEach(() => {
  rmSync(MEMORY_DIR, { recursive: true, force: true })
})

afterEach(() => {
  rmSync(MEMORY_DIR, { recursive: true, force: true })
})

/** 捕获**真正发给 provider** 的系统提示；上下文里存了什么这里看不见。 */
function createCapturingRegistry(): { registry: ProviderRegistry; prompts: string[] } {
  const prompts: string[] = []
  const provider: ProviderInstance = {
    config: { id: 'mock', name: 'Mock', protocol: 'openai-compatible', apiKey: '', models: [] },
    async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
      prompts.push(req.systemPrompt ?? '')
      yield { type: 'text', content: 'ok' }
      yield { type: 'stop' }
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
  const registry = {
    getActive: () => provider,
    getActiveModel: () => 'mock-model',
    listModels: () => models,
    findModel: (id: string) => models.find((m) => m.id === id),
    async *chat(req: ChatRequest): AsyncGenerator<StreamChunk> {
      yield* provider.chat(req)
    },
  } as unknown as ProviderRegistry
  return { registry, prompts }
}

function agentDef(memory?: 'user' | 'project' | 'local'): AgentDefinition {
  return {
    name: AGENT_NAME,
    description: '',
    systemPrompt: 'You are a test agent.',
    model: 'inherit',
    permissionMode: 'inherit',
    source: 'builtin',
    memory,
  }
}

/** 把记忆文件放到位（局部作用域 = cwd 下的 `.mipham/agent-memory-local/<name>/`）。 */
function writeMemoryFile(): void {
  mkdirSync(MEMORY_DIR, { recursive: true })
  writeFileSync(join(MEMORY_DIR, 'note.md'), MEMORY_TEXT, 'utf-8')
}

/** 跑一次子代理，返回它首轮请求带出去的系统提示。 */
async function sentPrompt(memory?: 'user' | 'project' | 'local'): Promise<string> {
  const { registry, prompts } = createCapturingRegistry()
  const sub = new SubAgent(registry, new Map<string, ToolDefinition>())
  await sub.execute('go', 'task', { type: 'general', agentDef: agentDef(memory) })
  expect(prompts.length, '一次请求都没发出去 ⇒ 下面的断言是空数组上的空话').toBeGreaterThan(0)
  return prompts[0]!
}

describe('子代理的记忆：声明的必须真的发出去', () => {
  it('**核心**：`memory: local` 的定义，其记忆文字必须出现在发出去的系统提示里', async () => {
    writeMemoryFile()

    const prompt = await sentPrompt('local')

    expect(prompt, '记忆是**追加**：子代理自己的系统提示逐字保留，且在最前').toContain(
      'You are a test agent.',
    )
    expect(prompt.indexOf('You are a test agent.')).toBe(0)
    expect(
      prompt,
      '声明的 memory 到不了模型手里 —— 定义里写着、面板里显示着、请求里没有',
    ).toContain(MEMORY_TEXT)
  })

  it('反面对照：同一个记忆文件、同一个名字，定义里**没声明** memory ⇒ 一个字都不许出现', async () => {
    writeMemoryFile()

    const prompt = await sentPrompt(undefined)

    // 这一格排掉两种假绿：① 记忆文字从别的路径漏进来（那上面那格就不是这条链路在起作用）；
    // ② 断言写成了恒真的空话。
    expect(prompt).not.toContain(MEMORY_TEXT)
  })

  it('声明了 memory 但目录不存在时照常出请求，且不比基线的提示短', async () => {
    const withMemory = await sentPrompt('local')
    const without = await sentPrompt(undefined)

    expect(withMemory.length).toBeGreaterThanOrEqual(without.length)
  })
})
