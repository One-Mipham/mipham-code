/**
 * MCP server 的 `instructions` 必须到达模型（对标档 280 · 003 附带）。
 *
 * 缺陷形状：`InitializeResult`（`mcp/types.ts:44`）**根本没收**这个字段，
 * `client.ts` 也只读 `serverInfo` + `capabilities.tools` ⇒ server 运维方写的
 * 「这个 server 该怎么用」一个字节都到不了模型（全仓 `rg '\.instructions' src/mcp/` 零命中）。
 *
 * 这是**纯函数**，好让它可单测：上游只给 `ConnectionInfo[]`，不与单例耦合。
 */

import { describe, it, expect } from 'vitest'

import {
  buildMcpInstructionsBlock,
  MCP_INSTRUCTIONS_PER_SERVER_CAP,
} from '../../src/mcp/instructions'
import type { ConnectionInfo } from '../../src/mcp/types'

const conn = (name: string, instructions?: string): ConnectionInfo => ({
  config: { name },
  status: 'connected',
  tools: [],
  ...(instructions === undefined ? {} : { instructions }),
})

describe('buildMcpInstructionsBlock', () => {
  it('点名 server 并带上它的话', () => {
    const block = buildMcpInstructionsBlock([conn('linear', 'Prefer the batch tool.')])

    expect(block).toContain('linear')
    expect(block).toContain('Prefer the batch tool.')
  })

  it('没写 instructions 的 server 整段不出现 —— 不留空标题', () => {
    const block = buildMcpInstructionsBlock([conn('silent')])

    expect(block).toBe('')
    expect(block).not.toContain('silent')
  })

  it('一个 server 的长篇大论被截到上限，且明说截了', () => {
    const rambling = 'x'.repeat(MCP_INSTRUCTIONS_PER_SERVER_CAP + 500)
    const block = buildMcpInstructionsBlock([conn('verbose', rambling)])

    expect(block).toContain('truncated')
    // 正文（去掉标题行后）不许超过上限 —— 否则上限只是个注释
    expect(
      block
        .split('\n')
        .filter((l) => l.startsWith('x'))
        .join('').length,
    ).toBeLessThanOrEqual(MCP_INSTRUCTIONS_PER_SERVER_CAP)
  })

  it('按 server 名排序 —— 两次同样的输入产出同一段（前缀缓存不因连接顺序抖动）', () => {
    const a = buildMcpInstructionsBlock([conn('zeta', 'Z'), conn('alpha', 'A')])
    const b = buildMcpInstructionsBlock([conn('alpha', 'A'), conn('zeta', 'Z')])

    expect(a).toBe(b)
    expect(a.indexOf('alpha')).toBeLessThan(a.indexOf('zeta'))
  })

  it('没有可说的就返回空串（调用方据此整段不注入）', () => {
    expect(buildMcpInstructionsBlock([])).toBe('')
  })
})
