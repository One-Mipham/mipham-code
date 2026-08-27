import { describe, it, expect } from 'vitest'
import type { Llm } from '../../src/providers/llm'
import {
  loadPerformanceTasks,
  judgeGeneratedCode,
  stripCodeFences,
  runTaskPerformance,
} from '../../src/core/task-performance'

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

describe('judgeGeneratedCode', () => {
  it('通过：解法满足冻结测试', () => {
    const solution = 'export function double(x: number): number { return x * 2 }'
    const test =
      "import { test, expect } from 'bun:test'\nimport { double } from './solution'\ntest('double', () => { expect(double(2)).toBe(4) })"
    const verdict = judgeGeneratedCode(test, solution)
    expect(verdict.passed).toBe(true)
  })

  it('失败：解法错误', () => {
    const solution = 'export function double(x: number): number { return x }'
    const test =
      "import { test, expect } from 'bun:test'\nimport { double } from './solution'\ntest('double', () => { expect(double(2)).toBe(4) })"
    const verdict = judgeGeneratedCode(test, solution)
    expect(verdict.passed).toBe(false)
  })

  it('超时：死循环被 timeout 杀掉', () => {
    const solution = 'export function hang(): number { while (true) {} return 1 }'
    const test =
      "import { test, expect } from 'bun:test'\nimport { hang } from './solution'\ntest('hang', () => { expect(hang()).toBe(1) })"
    const verdict = judgeGeneratedCode(test, solution, { timeoutMs: 1000 })
    expect(verdict.passed).toBe(false)
  })
})

describe('stripCodeFences', () => {
  it('剥掉 markdown 代码块', () => {
    const input = '```typescript\nexport function f() { return 1 }\n```'
    const out = stripCodeFences(input)
    expect(out).toContain('export function f()')
    expect(out).not.toContain('```')
  })
})

describe('runTaskPerformance', () => {
  it('对 mock LLM 生成的代码打分', async () => {
    const mockLlm: Llm = {
      chat: async function* () {
        yield {
          type: 'text',
          content:
            'export function quicksort(arr: number[]): number[] { return [...arr].sort((a, b) => a - b) }',
        }
      },
    }
    const report = await runTaskPerformance(mockLlm)
    expect(report.total).toBeGreaterThan(0)
    expect(report.passed).toBeGreaterThanOrEqual(0)
    expect(report.passed).toBeLessThanOrEqual(report.total)
    expect(report.score).toBe(Math.round((report.passed / report.total) * 100))
    expect(report.results.length).toBe(report.total)
  })
})
