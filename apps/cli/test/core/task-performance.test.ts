import { describe, it, expect } from 'vitest'
import { loadPerformanceTasks } from '../../src/core/task-performance'

describe('loadPerformanceTasks', () => {
  it('加载至少 1 个字段完整的任务', () => {
    const tasks = loadPerformanceTasks()
    expect(tasks.length).toBeGreaterThanOrEqual(1)
    for (const t of tasks) {
      expect(typeof t.id).toBe('string')
      expect(t.category === 'test-driven' || t.category === 'bug-fix').toBe(true)
      expect(typeof t.prompt).toBe('string')
      expect(typeof t.testCode).toBe('string')
    }
  })

  it('任务 id 唯一', () => {
    const tasks = loadPerformanceTasks()
    const ids = tasks.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
