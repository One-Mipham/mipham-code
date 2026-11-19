/**
 * ELITE（2611.21056）整合算子：多提案 → 兼容子集 → 一个后代。
 *
 * 这里跑的是真 `git merge-file`（与 crsi 的其它用例同一条纪律：判据用真工具，
 * 不用「自己写的桩」证明自己）。夹具都在 tmp 里，不碰仓库。
 */
import { describe, it, expect } from 'vitest'
import { integrateProposals, formatIntegrationSummary } from '../../src/core/proposal-integration'

const BASE = 'a\nb\nc\n'

describe('integrateProposals', () => {
  it('互补：改不同段 ⇒ 两个都收进后代', () => {
    const r = integrateProposals(BASE, [
      { name: 'p1', content: 'A\nb\nc\n' },
      { name: 'p2', content: 'a\nb\nc\nd\n' },
    ])
    expect(r.ok).toBe(true)
    expect(r.merged).toEqual(['p1', 'p2'])
    expect(r.conflicts).toEqual([])
    expect(r.content).toBe('A\nb\nc\nd\n')
  })

  it('冗余：两个提案字节相同 ⇒ 只留一份', () => {
    const r = integrateProposals(BASE, [
      { name: 'p1', content: 'A\nb\nc\n' },
      { name: 'p2', content: 'A\nb\nc\n' },
    ])
    expect(r.ok).toBe(true)
    expect(r.merged).toEqual(['p1'])
    expect(r.redundant).toEqual(['p2'])
    expect(r.content).toBe('A\nb\nc\n')
  })

  it('未改动父本的提案也算冗余（没有机制可整合）', () => {
    const r = integrateProposals(BASE, [
      { name: 'noop', content: BASE },
      { name: 'p2', content: 'A\nb\nc\n' },
    ])
    expect(r.redundant).toEqual(['noop'])
    expect(r.merged).toEqual(['p2'])
  })

  it('冲突：改同一段 ⇒ 单列、默认不 ok；先合并的那个仍留在 content 里', () => {
    const r = integrateProposals(BASE, [
      { name: 'p1', content: 'A\nb\nc\n' },
      { name: 'p2', content: 'B\nb\nc\n' },
    ])
    expect(r.ok).toBe(false)
    expect(r.merged).toEqual(['p1'])
    expect(r.conflicts.map((c) => c.name)).toEqual(['p2'])
    expect(r.conflicts[0]!.conflictCount).toBeGreaterThan(0)
    // 兼容子集仍然可用 —— 是否丢弃冲突提案是调用方的显式选择。
    expect(r.content).toBe('A\nb\nc\n')
  })

  it('少于两个提案 ⇒ 错误（不是「兼容 0 个」）', () => {
    const r = integrateProposals(BASE, [{ name: 'only', content: 'A\n' }])
    expect(r.ok).toBe(false)
    expect(r.error).toContain('至少需要两个提案')
  })

  it('摘要只描述三册', () => {
    const r = integrateProposals(BASE, [
      { name: 'p1', content: 'A\nb\nc\n' },
      { name: 'p2', content: 'a\nb\nc\nd\n' },
    ])
    expect(formatIntegrationSummary(r)).toBe('兼容 2')
  })
})
