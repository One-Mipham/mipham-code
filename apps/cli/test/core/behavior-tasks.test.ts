import { describe, it, expect } from 'vitest'
import { loadBehaviorTasks } from '../../src/core/behavior-tasks'

describe('loadBehaviorTasks', () => {
  it('loads a non-empty task list with unique ids', () => {
    const tasks = loadBehaviorTasks()
    expect(tasks.length).toBeGreaterThan(0)
    const ids = tasks.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length) // id 唯一
  })

  it('every task has a layer and an expect semantic', () => {
    for (const t of loadBehaviorTasks()) {
      expect(t.layer).toBe('constraint')
      expect(['warn-or-fix', 'masked-or-blocked', 'tests-pass', 'red-to-green']).toContain(t.expect)
    }
  })

  it('param-fix tasks carry tool + params; content-safety tasks carry content', () => {
    for (const t of loadBehaviorTasks()) {
      if (t.category === 'param-fix') {
        expect(t.tool).toBeTruthy()
        expect(t.params).toBeTruthy()
      }
      if (t.category === 'content-safety') {
        expect(t.content).toBeTruthy()
      }
    }
  })
})
