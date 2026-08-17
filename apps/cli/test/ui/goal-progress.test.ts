import { describe, it, expect } from 'vitest'
import { summarizeTasks, formatTokens } from '../../src/ui/goal-progress.js'
import { getTasks, taskTool } from '../../src/tools/exec/task.js'
import type { Task } from '../../src/tools/exec/task.js'

function makeTask(id: string, status: Task['status']): Task {
  return {
    id,
    subject: `task-${id}`,
    description: '',
    status,
    blocks: [],
    blockedBy: [],
    createdAt: '2026-08-18T00:00:00.000Z',
  }
}

describe('summarizeTasks', () => {
  it('counts done/total and ignores deleted', () => {
    const tasks = [
      makeTask('1', 'completed'),
      makeTask('2', 'completed'),
      makeTask('3', 'in_progress'),
      makeTask('4', 'pending'),
      makeTask('5', 'failed'),
      makeTask('6', 'deleted'),
    ]

    const s = summarizeTasks(tasks)

    expect(s.total).toBe(5)
    expect(s.done).toBe(2)
    expect(s.inProgress).toBe(1)
    expect(s.pending).toBe(1)
    expect(s.failed).toBe(1)
  })

  it('returns zero counts for an empty list', () => {
    expect(summarizeTasks([])).toEqual({
      total: 0,
      done: 0,
      inProgress: 0,
      pending: 0,
      failed: 0,
    })
  })
})

describe('formatTokens', () => {
  it('formats raw counts under 1000', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(500)).toBe('500')
    expect(formatTokens(999)).toBe('999')
  })

  it('formats thousands as K', () => {
    expect(formatTokens(1000)).toBe('1.0K')
    expect(formatTokens(1234)).toBe('1.2K')
    expect(formatTokens(89000)).toBe('89.0K')
  })
})

describe('getTasks', () => {
  it('returns only non-deleted tasks', async () => {
    await taskTool.execute({ action: 'create', subject: 'keep' }, {} as never)
    await taskTool.execute({ action: 'create', subject: 'drop' }, {} as never)

    const drop = getTasks().find((t) => t.subject === 'drop')
    expect(drop).toBeDefined()
    expect(getTasks().filter((t) => t.subject === 'keep' || t.subject === 'drop')).toHaveLength(2)

    await taskTool.execute({ action: 'delete', taskId: drop!.id }, {} as never)

    expect(getTasks().filter((t) => t.subject === 'drop')).toHaveLength(0)
    expect(getTasks().filter((t) => t.subject === 'keep')).toHaveLength(1)
  })
})
