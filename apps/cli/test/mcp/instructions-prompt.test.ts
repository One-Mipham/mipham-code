/**
 * MCP instructions 必须**到达模型**，而不只是被存进 `ConnectionInfo`。
 *
 * 「收下来但没人读」正是这一批要关掉的形状：上一步只做到 `connection.instructions = …`
 * —— 数据进了内存，模型一个字节也拿不到，与不接线的区别只有内存占用。
 *
 * 这里断的是**读时派生**，不是「拼一次就完」：MCP server 是**启动后异步连上**的，
 * 若在 `setSystemPrompt()` 那一刻把当时的内容烘进字符串，那么本次会话里后连上的 server
 * 永远进不了提示（与权限段那个「烘进字符串」的缺陷同族）。判据因此是「**同一次读**、
 * 换了答案」，而不是「读了两个不同的字符串」。
 */

import { describe, it, expect, beforeEach } from 'vitest'

import { ContextManager } from '../../src/core/context'
import { buildMcpInstructionsBlock } from '../../src/mcp/instructions'
import type { ConnectionInfo } from '../../src/mcp/types'

const BASE = '# BASE PROMPT\n\n- 一条不涉及 MCP 的指令'

const conn = (name: string, instructions?: string): ConnectionInfo => ({
  config: { name },
  status: 'connected',
  tools: [],
  ...(instructions === undefined ? {} : { instructions }),
})

describe('系统提示里的 MCP instructions 段', () => {
  let context: ContextManager

  beforeEach(() => {
    context = new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.9 })
    context.setSystemPrompt(BASE)
  })

  it('**核心**：后连上的 server 当场进提示 —— 读时派生，不是组装时烘死', () => {
    // 接线时**一个 server 都还没连上**（真实的启动顺序：提示先建、MCP 后连）。
    let connections: ConnectionInfo[] = []
    context.setMcpInstructionsSource(() => buildMcpInstructionsBlock(connections))
    expect(context.getSystemPrompt(), '此时还没连上，不该有 MCP 段').toBe(BASE)

    // server 连上了 —— 这里没有第二次 `setSystemPrompt()`，也没有重设 source。
    connections = [conn('linear', 'Prefer the batch tool.')]

    const after = context.getSystemPrompt()
    expect(after).toContain(BASE)
    expect(after).toContain('Prefer the batch tool.')
    expect(after).toContain('linear')
  })

  it('未接线时系统提示就是 base —— 不留悬空分隔符', () => {
    expect(context.getSystemPrompt()).toBe(BASE)
  })

  it('一个 server 都没带 instructions 时同样是 base（空段不注入）', () => {
    context.setMcpInstructionsSource(() => buildMcpInstructionsBlock([conn('silent')]))
    expect(context.getSystemPrompt()).toBe(BASE)
  })

  it('传 `null` 撤销接线', () => {
    context.setMcpInstructionsSource(() => buildMcpInstructionsBlock([conn('a', 'A')]))
    expect(context.getSystemPrompt()).not.toBe(BASE)

    context.setMcpInstructionsSource(null)
    expect(context.getSystemPrompt()).toBe(BASE)
  })

  it('与权限段共存：两段都在，base 仍在最前（前缀最快命中）', () => {
    context.setPermissionContextSource(() => 'PERM BLOCK')
    context.setMcpInstructionsSource(() => buildMcpInstructionsBlock([conn('a', 'A')]))

    const prompt = context.getSystemPrompt()
    expect(prompt.startsWith(BASE), 'base 不在最前 ⇒ 每次改动都让前缀缓存整体落空').toBe(true)
    expect(prompt).toContain('PERM BLOCK')
    expect(prompt).toContain('A')
  })
})
