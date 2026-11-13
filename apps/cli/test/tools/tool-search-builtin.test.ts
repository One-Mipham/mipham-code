/**
 * 323-197：ToolSearch 零命中时，若查询其实是**内置工具**的名字，答案必须是
 * 「它已经可用、直接调它」，而不是「没有匹配」。
 *
 * 为什么这算缺陷：ToolSearch 只覆盖 MCP 服务器。模型拿内置工具的短名去搜
 * （`WebSearch` / `web search` / `Grep`）得到「0 个匹配」时，唯一合理的下一步
 * 是去找一个能提供它的服务器 —— 而它本来就在手边。零命中的文案把「没有这个
 * MCP 工具」说成了「没有这个东西」。
 */

import { describe, expect, it, vi, afterEach } from 'vitest'
import { McpClient } from '../../src/mcp/client'
import { toolSearchTool, builtInToolMatches } from '../../src/tools/system/tool-search'
import type { ToolDefinition, ToolContext } from '../../src/shared/index.ts'

const tool = (name: string): ToolDefinition => ({
  name,
  description: `${name} tool`,
  category: 'file',
  permission: 'self',
  parameters: { type: 'object', properties: {} },
  execute: async () => ({ success: true, content: '' }),
})

const registry = () =>
  new Map([
    ['WebSearch', tool('WebSearch')],
    ['Grep', tool('Grep')],
    ['ToolSearch', tool('ToolSearch')],
  ])

const ctxWith = (reg?: Map<string, ToolDefinition>) =>
  ({ toolRegistry: reg }) as unknown as ToolContext

/** 一个连接着、但没有任何工具的 MCP 服务器：搜索必然零命中。 */
function stubEmptyServer(): void {
  const client = McpClient.getInstance()
  vi.spyOn(client, 'getConnectedServers').mockReturnValue(['srv'])
  vi.spyOn(client, 'getTools').mockReturnValue([])
}

describe('ToolSearch 零命中且查到内置工具', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('内置工具名按「空格/下划线/大小写不敏感」匹配', () => {
    expect(builtInToolMatches('web search', registry())).toEqual(['WebSearch'])
    expect(builtInToolMatches('web_search', registry())).toEqual(['WebSearch'])
    expect(builtInToolMatches('WebSearch', registry())).toEqual(['WebSearch'])
    // 正对照：不相关的查询一个都不命中。
    expect(builtInToolMatches('kubernetes', registry())).toEqual([])
  })

  it('零命中时回复说「已可用、直接调用」，而不是只说没有匹配', async () => {
    stubEmptyServer()

    const res = await toolSearchTool.execute!({ query: 'web search' }, ctxWith(registry()))

    expect(res.success).toBe(true)
    expect(res.content).toContain('No tools matching')
    expect(res.content).toContain('already available')
    expect(res.content).toContain('`WebSearch`')
  })

  it('对照：同样的零命中，查询不是内置工具时**不得**出现「已可用」', async () => {
    stubEmptyServer()

    const res = await toolSearchTool.execute!({ query: 'kubernetes' }, ctxWith(registry()))

    expect(res.content).toContain('No tools matching')
    expect(res.content).not.toContain('already available')
  })

  it('对照：没有 toolRegistry 的老上下文不崩、也不编造提示', async () => {
    stubEmptyServer()

    const res = await toolSearchTool.execute!({ query: 'web search' }, {} as never)

    expect(res.success).toBe(true)
    expect(res.content).not.toContain('already available')
  })
})
