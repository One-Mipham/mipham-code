import { describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadRunnerTasks, judgeTask, runTask } from '../../src/core/task-runner'
import type { Llm } from '../../src/providers/llm'

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

const RUN_DIR = join(process.cwd(), '.mipham', 'task-runner-test')

function makeWriterLlm(targetFile: string, content: string): Llm {
  let calls = 0
  return {
    chat: async function* () {
      calls++
      if (calls === 1) {
        yield {
          type: 'tool_use',
          toolUse: {
            type: 'tool_use',
            id: 'call_1',
            name: 'Write',
            input: { file_path: targetFile, content },
          },
        }
      }
      yield { type: 'stop' }
    },
  }
}

describe('runTask', () => {
  it('mock Llm 写正确内容则通过', async () => {
    rmSync(RUN_DIR, { recursive: true, force: true })
    const task = loadRunnerTasks()[0]!
    const llm = makeWriterLlm(
      join(RUN_DIR, 'solution.ts'),
      'export function answer(): number { return 42 }\n',
    )
    const result = await runTask(task, llm, { taskDir: RUN_DIR })
    expect(result.passed).toBe(true)
  })

  it('mock Llm 写错误内容则失败', async () => {
    rmSync(RUN_DIR, { recursive: true, force: true })
    const task = loadRunnerTasks()[0]!
    const llm = makeWriterLlm(join(RUN_DIR, 'solution.ts'), 'export const x = 1\n')
    const result = await runTask(task, llm, { taskDir: RUN_DIR })
    expect(result.passed).toBe(false)
  })
})
