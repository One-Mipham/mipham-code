import { describe, it, expect, beforeEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadRunnerTasks, judgeTask, runTask, runTaskN } from '../../src/core/task-runner'
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
  return {
    chat: async function* (req) {
      // 无状态：第一次 chat（尚无 assistant 消息）发起 Write，后续（continueWithTools）纯 stop。
      const alreadyActed = req.messages.some((m) => m.role === 'assistant')
      if (!alreadyActed) {
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

describe('runTaskN', () => {
  it('统计 n 次采样的通过率', async () => {
    const task = loadRunnerTasks()[0]!
    const llm = makeWriterLlm(
      join(RUN_DIR, 'solution.ts'),
      'export function answer(): number { return 42 }\n',
    )
    const stats = await runTaskN(task, llm, 2, { taskDir: RUN_DIR })
    expect(stats.samples).toBe(2)
    expect(stats.passed).toBe(2)
    expect(stats.passRate).toBe(1)
  })
})

function makeCaptureLlm(): { llm: Llm; seen: string[] } {
  const seen: string[] = []
  const llm: Llm = {
    chat: async function* (req) {
      seen.push(req.systemPrompt ?? '')
      yield { type: 'stop' }
    },
  }
  return { llm, seen }
}

describe('runTask systemPrompt 注入', () => {
  it('注入的散文进入 LLM 的 systemPrompt', async () => {
    const { llm, seen } = makeCaptureLlm()
    await runTask(loadRunnerTasks()[0]!, llm, { taskDir: RUN_DIR, systemPrompt: 'CUSTOM-PROSE' })
    expect(seen.some((s) => s.includes('CUSTOM-PROSE'))).toBe(true)
  })

  it('未注入时 systemPrompt 为空', async () => {
    const { llm, seen } = makeCaptureLlm()
    await runTask(loadRunnerTasks()[0]!, llm, { taskDir: RUN_DIR })
    expect(seen.some((s) => s.includes('CUSTOM-PROSE'))).toBe(false)
  })
})
