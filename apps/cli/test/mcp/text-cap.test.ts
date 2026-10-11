/**
 * 295-112 / 296-061：一段「给模型看的 MCP 文本」的统一上限。
 *
 * 三个面此前各是各的数字：单个 server 的 instructions 2000、**up-front 工具定义无上限**、
 * tool-search 命中列表 120。无上限那面最危险 —— MCP server 的 `tools/list` 是我们**管不了**的
 * 第三方文本，每次请求都要重新付一遍前缀，一个啰嗦的 server 能靠一段自带 description 把别人的
 * 预算吃光。120 那面则是反过来的错：把「该不该用这个工具」的依据砍到看不见。
 *
 * 这里把三面钉在**同一个** `capMcpText` 上：改它一处，下面三条用例一起红 —— 那正是
 * 「三面共用一个口」这件事的可执行表述。
 */

import { describe, it, expect, afterEach, vi } from 'vitest'

import { capMcpText, MCP_TEXT_CAP, buildMcpInstructionsBlock } from '../../src/mcp/instructions'
import { convertMcpTool } from '../../src/mcp/registry'
import { McpClient } from '../../src/mcp/client'
import { toolSearchTool } from '../../src/tools/system/tool-search'

describe('capMcpText —— 一个口管三面', () => {
  it('未超上限原样返回（不做任何加工）', () => {
    const short = 'Use the batch tool.'
    expect(capMcpText(short)).toBe(short)
  })

  it('恰好等于上限不截（边界是 > 而非 >=）', () => {
    const exact = 'x'.repeat(MCP_TEXT_CAP)
    expect(capMcpText(exact)).toBe(exact)
  })

  it('超过上限：截到 cap、并补一个可见标记 —— 悄悄变短会被当成完整定义信任', () => {
    const out = capMcpText('x'.repeat(MCP_TEXT_CAP + 1))
    expect(out).toContain('truncated')
    // 正文不许超过上限（否则上限只是注释）：切掉 marker 那行再看。
    const body = out
      .split('\n')
      .filter((l) => l.startsWith('x'))
      .join('')
    expect(body.length).toBe(MCP_TEXT_CAP)
  })
})

describe('三面确实都走这个口', () => {
  // ── 面一：server instructions（原有上限，只是换了数字来源）──
  it('server instructions 超长被截', () => {
    const block = buildMcpInstructionsBlock([
      {
        config: { name: 'verbose' },
        status: 'connected',
        tools: [],
        instructions: 'x'.repeat(MCP_TEXT_CAP + 500),
      },
    ])
    expect(block).toContain('truncated')
    expect(
      block
        .split('\n')
        .filter((l) => l.startsWith('x'))
        .join('').length,
    ).toBe(MCP_TEXT_CAP)
  })

  // ── 面二：up-front 工具定义（这里此前**完全无上限**，是最危险的那面）──
  it('convertMcpTool 给一个流氓长 description 加上限', () => {
    const tool = convertMcpTool('rogue', {
      name: 'noisy',
      description: 'y'.repeat(MCP_TEXT_CAP * 3),
      inputSchema: { type: 'object', properties: {} },
    })
    expect(tool.description).toContain('truncated')
    // `[MCP:rogue] ` 前缀 + 截断正文 + 标记，总量必须收在预算内。
    expect(tool.description.length).toBeLessThan(MCP_TEXT_CAP + 64)
  })

  it('（对照）短 description 一字不改', () => {
    const tool = convertMcpTool('my-server', {
      name: 'no-desc',
      description: 'Does a thing',
      inputSchema: { type: 'object', properties: {} },
    })
    expect(tool.description).toBe('[MCP:my-server] Does a thing')
  })
})

describe('tool-search 命中列表不再砍到 120', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function stubServer(description: string): void {
    const client = McpClient.getInstance()
    vi.spyOn(client, 'getConnectedServers').mockReturnValue(['srv'])
    vi.spyOn(client, 'getTools').mockReturnValue([
      { name: 't', description, inputSchema: { type: 'object', properties: {} } },
    ])
  }

  it('一段 3000 字的描述完整到达模型（旧的 .slice(0,120) 会在这里现形）', async () => {
    const long = 'z'.repeat(3000)
    stubServer(long)

    const res = await toolSearchTool.execute!({ query: '' }, {} as never)
    expect(res.content).toContain(long)
    // 旧上限的证据：120 字版本会让这一条红。
    expect(res.content).toContain('z'.repeat(120))
  })

  it('但真正超长的仍受 4096 上限约束', async () => {
    stubServer('z'.repeat(MCP_TEXT_CAP + 1000))

    const res = await toolSearchTool.execute!({ query: '' }, {} as never)
    expect(res.content).toContain('truncated')
    expect(res.content.split('\n').find((l) => l.includes('truncated'))!.length).toBeLessThan(
      MCP_TEXT_CAP + 64,
    )
  })
})
