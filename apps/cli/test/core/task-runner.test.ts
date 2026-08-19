import { describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadRunnerTasks, judgeTask } from '../../src/core/task-runner'

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

const JUDGE_DIR = join(tmpdir(), 'mipham-task-runner-judge')

beforeEach(() => {
  rmSync(JUDGE_DIR, { recursive: true, force: true })
  mkdirSync(JUDGE_DIR, { recursive: true })
})

describe('judgeTask', () => {
  it('命中所有子串则通过', () => {
    writeFileSync(
      join(JUDGE_DIR, 'solution.ts'),
      'export function answer(): number { return 42 }\n',
    )
    const task = loadRunnerTasks()[0]!
    expect(judgeTask(task, JUDGE_DIR).passed).toBe(true)
  })

  it('缺失子串则失败', () => {
    writeFileSync(join(JUDGE_DIR, 'solution.ts'), 'export const x = 1\n')
    const task = loadRunnerTasks()[0]!
    const v = judgeTask(task, JUDGE_DIR)
    expect(v.passed).toBe(false)
  })

  it('文件不存在则失败', () => {
    const task = loadRunnerTasks()[0]!
    const v = judgeTask(task, JUDGE_DIR)
    expect(v.passed).toBe(false)
    expect(v.detail).toContain('not found')
  })
})
