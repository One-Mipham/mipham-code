import { describe, it, expect } from 'vitest'
import { loadPerformanceTasks, judgeGeneratedCode } from '../../src/core/task-performance'

/**
 * 任务电池完整性守卫。
 *
 * 两条都是「仪器自证」：题数不对 ⇒ 捕获率的分母变了；参考解过不了自己的冻结测试
 * ⇒ 上界不是 100，`(on−off)/(100−off)` 悄悄变成一个错的数。
 */
describe('任务电池完整性', () => {
  const tasks = loadPerformanceTasks({ pool: 'all' })

  it('共 15 题，id 唯一', () => {
    expect(tasks).toHaveLength(15)
    expect(new Set(tasks.map((t) => t.id)).size).toBe(15)
  })

  it('每组 5 题（safe-coding / tdd / 无标签）', () => {
    const counts = new Map<string, number>()
    for (const t of tasks) {
      const key = t.skill ?? 'untagged'
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
    expect(Object.fromEntries(counts)).toEqual({ untagged: 5, 'safe-coding': 5, tdd: 5 })
  })

  it('每题都带 oracleCode，且参考解能过自己的冻结测试', () => {
    for (const t of tasks) {
      expect(typeof t.oracleCode, t.id).toBe('string')
      expect(t.oracleCode.length, t.id).toBeGreaterThan(0)
      const verdict = judgeGeneratedCode(t.testCode, t.oracleCode)
      expect(verdict.passed, `${t.id}: ${verdict.detail ?? ''}`).toBe(true)
    }
  })
})

describe('sealed 池与选择路径隔离', () => {
  it('缺省只返回 gate 池；sealed 不在其中', () => {
    const gate = loadPerformanceTasks()
    const sealed = loadPerformanceTasks({ pool: 'sealed' })
    expect(sealed.length).toBeGreaterThanOrEqual(1)
    const gateIds = new Set(gate.map((t) => t.id))
    expect(sealed.some((t) => gateIds.has(t.id))).toBe(false)
  })

  it('每组 4 gate + 1 sealed', () => {
    for (const group of [undefined, 'safe-coding', 'tdd']) {
      const gate = loadPerformanceTasks().filter((t) => t.skill === group)
      const sealed = loadPerformanceTasks({ pool: 'sealed' }).filter((t) => t.skill === group)
      expect(gate, String(group)).toHaveLength(4)
      expect(sealed, String(group)).toHaveLength(1)
    }
  })
})
