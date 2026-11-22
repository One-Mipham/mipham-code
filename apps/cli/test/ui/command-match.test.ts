/**
 * 斜杠命令排序：/memory 回车必须执行 /memory，而不是描述里含 "memory" 的 /dream。
 */
import { describe, it, expect } from 'vitest'
import {
  getCommand,
  getCommandList,
  rankCommandMatches,
  type CommandEntry,
} from '../../src/ui/commands'

const cmds: CommandEntry[] = [
  { name: '/dream', description: 'Background memory consolidation' },
  { name: '/memory', description: 'View stored memories' },
  { name: '/model', description: 'Show current model' },
  { name: '/model-picker', description: 'Open the model picker' },
  { name: '/models', description: 'List all available models' },
  { name: '/fork', description: 'fork the conversation into a new session' },
]

describe('rankCommandMatches', () => {
  it('精确名压过描述匹配（/memory ≠ /dream）', () => {
    const ranked = rankCommandMatches(cmds, 'memory')
    expect(ranked[0]!.name).toBe('/memory')
  })

  it('精确名压过前缀（/model 在 /model-picker、/models 之前）', () => {
    const ranked = rankCommandMatches(cmds, 'model')
    expect(ranked[0]!.name).toBe('/model')
    expect(
      ranked
        .slice(1)
        .map((c) => c.name)
        .sort(),
    ).toEqual(['/model-picker', '/models'])
  })

  it('名前缀压过描述匹配', () => {
    const ranked = rankCommandMatches(cmds, 'fork')
    expect(ranked[0]!.name).toBe('/fork')
  })

  it('只命中描述的命令仍会出现，排在名字命中之后', () => {
    const ranked = rankCommandMatches(cmds, 'model')
    // 描述里有 "model" 的条目一个都不能丢
    const names = ranked.map((c) => c.name)
    expect(names).toContain('/models')
    expect(names).toContain('/model-picker')
  })

  it('空查询按原序返回（GET / 的默认列表不受影响）', () => {
    expect(rankCommandMatches(cmds, '').map((c) => c.name)).toEqual(cmds.map((c) => c.name))
  })

  it('真实注册表：/memory 排第一（回归用例，用的是生产命令表）', () => {
    const ranked = rankCommandMatches(getCommandList(), 'memory')
    expect(ranked[0]!.name).toBe('/memory')
  })
})

describe('/settings 别名', () => {
  it('指向与 /config 同一个处理器，且出现在命令表里', () => {
    expect(getCommand('/settings')).toBe(getCommand('/config'))
    expect(getCommandList().some((c) => c.name === '/settings')).toBe(true)
  })
})
