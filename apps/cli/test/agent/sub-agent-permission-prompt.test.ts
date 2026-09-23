/**
 * 子代理报**它自己的权限档** —— 断言读的是**真正发给 provider 的那份提示**。
 *
 * 缺陷形状：子代理的系统提示里从来没有权限段。上下文里有没有都不算账 ——
 * 子代理的请求读的是 `sub-agent.ts` 里的局部变量，**从不读上下文**的系统提示，所以
 * 「把权限段接到 `ContextManager` 的读时缝上」在这个调用点是一处**装饰**：接线在场、
 * 请求里一个字都到不了。故这里的观测点选在 provider 的 `ChatRequest.systemPrompt` 上。
 *
 * 判据是「**它自己的**那一档」而不是「有一档」：
 * - 定义指名了 `acceptEdits` 而父档是 `default` 时，必须报 `acceptEdits`，且**父档的
 *   句子必须消失**（只断「新句子出现」的话，把两段一起拼上去也能过）；
 * - 写 `inherit` 的定义才是父档 —— 那是 `createSubAgentPermission` 的解析结果，
 *   本用例只是把它读出来；
 * - 报的是**生效档**：组织级上限把定义里的 `bypassPermissions` 钳走之后，提示跟着钳后
 *   的值。报请求档 = 报得比实际宽，与系统提示那边（P5）同族、方向也相同。
 *
 * 与之配对的源码侧守卫在 `test/integrity/permission-status-parity.test.ts`（P6）：那边断
 * 「接在闸门上、且不是父系统或字面量」，这边断「接上之后真的到了线上」。
 */

import { describe, it, expect } from 'vitest'
import { SubAgent } from '../../src/agent/sub-agent'
import { PermissionSystem } from '../../src/core/permission'
import type { AgentDefinition } from '../../src/agent/types'
import type { ProviderRegistry, ProviderInstance, ChatRequest } from '../../src/providers/registry'
import type { StreamChunk, ToolDefinition } from '../../src/shared/index.ts'

/** 捕获**真正发给 provider** 的系统提示；上下文里存了什么这里看不见，正是本用例要的。 */
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

function agentDef(permissionMode: string): AgentDefinition {
  return {
    name: 'tester',
    description: '',
    systemPrompt: 'You are a test agent.',
    model: 'inherit',
    permissionMode,
    source: 'builtin',
  }
}

/** 跑一次子代理，返回它首轮请求带出去的系统提示。 */
async function sentPrompt(
  parent: PermissionSystem | undefined,
  permissionMode: string,
): Promise<string> {
  const { registry, prompts } = createCapturingRegistry()
  const sub = new SubAgent(registry, new Map<string, ToolDefinition>(), parent)
  await sub.execute('go', 'task', { type: 'general', agentDef: agentDef(permissionMode) })
  expect(prompts.length, '一次请求都没发出去 ⇒ 下面的断言是空数组上的空话').toBeGreaterThan(0)
  return prompts[0]!
}

describe('子代理的权限段：报它自己的档', () => {
  it('正对照：`inherit` + 父档 `default` ⇒ 发出去的就是 `default` 那段的文字', async () => {
    const prompt = await sentPrompt(new PermissionSystem('default'), 'inherit')
    expect(prompt).toContain('## Permission Context')
    expect(prompt).toContain('You are in **default** mode')
  })

  it('**核心**：定义指名的一档是它**自己**的档，父档的句子必须消失', async () => {
    const prompt = await sentPrompt(new PermissionSystem('default'), 'acceptEdits')
    expect(prompt).toContain('You are in **acceptEdits** mode')
    // 关键的一半：不许两段并存 —— 模型同时读到「编辑已允许」与「工具会被挡」时，
    // 它按更保守的那句行事，于是拒绝做它已经被允许做的事。
    expect(prompt, '把父档也拼进去了 ⇒ 子代理拿着不属于自己的权限说明去办事').not.toContain(
      'You are in **default** mode',
    )
    expect(prompt, '往宽切的那一半：闸门开了，指令必须跟着说可以编辑了').toContain(
      'File reads and edits are allowed',
    )
  })

  it('`inherit` 才是父档：父档 `plan` 时子代理报 `plan`', async () => {
    const prompt = await sentPrompt(new PermissionSystem('plan'), 'inherit')
    expect(prompt).toContain('You are in **plan** mode')
  })

  it('没人递权限系统时报 `default` —— 那正是它真正过的闸门，不是「无权限」', async () => {
    const prompt = await sentPrompt(undefined, 'inherit')
    expect(prompt).toContain('You are in **default** mode')
  })

  it('报的是**生效档**：组织级上限钳走定义里的 `bypassPermissions` 之后，提示跟着钳后的值', async () => {
    const parent = new PermissionSystem('default')
    parent.setRestrictions({ maxAllowedMode: 'plan' })
    const prompt = await sentPrompt(parent, 'bypassPermissions')
    expect(prompt).toContain('You are in **plan** mode')
    expect(prompt, '报得比实际宽 —— 与 P5 那次同族、方向也相同').not.toContain(
      'bypassPermissions** mode',
    )
  })

  it('权限段是**追加**：子代理自己的系统提示逐字保留', async () => {
    const prompt = await sentPrompt(new PermissionSystem('default'), 'acceptEdits')
    expect(prompt).toContain('You are a test agent.')
    expect(prompt.indexOf('You are a test agent.')).toBe(0)
  })
})
