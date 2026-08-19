import { describe, it, expect } from 'vitest'
import { loadRunnerTasks } from '../../src/core/task-runner'

describe('loadRunnerTasks', () => {
  it('加载冻结任务集且结构合法', () => {
    const tasks = loadRunnerTasks()
    expect(tasks.length).toBeGreaterThanOrEqual(1)
    const t = tasks[0]!
    expect(typeof t.id).toBe('string')
    expect(typeof t.instruction).toBe('string')
    expect(t.groundTruth.kind).toBe('file-contains')
    expect(typeof t.groundTruth.file).toBe('string')
    expect(Array.isArray(t.groundTruth.contains)).toBe(true)
  })

  it('任务 id 唯一', () => {
    const tasks = loadRunnerTasks()
    const ids = tasks.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
  })
})
