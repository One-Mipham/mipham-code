import { describe, it, expect } from 'vitest'
import { mechanismSentinel, taskPerformanceRewardFn, listRewardFns } from '../../src/core/reward-fn'
import { runEval } from '../../src/core/eval-harness'
import { isProtectedPath, PROTECTED_CRITICAL_FILES } from '../../src/core/crsi-sandbox'
import type { Llm } from '../../src/providers/llm'

describe('reward-fn 接口', () => {
  it('mechanismSentinel 同步评估 = runEval 的分数', async () => {
    const fn = mechanismSentinel()
    expect(fn.name).toBe('mechanism-sentinel')
    const report = await fn.evaluate()
    const expected = runEval()
    expect(report.score).toBe(expected.score)
    expect(report.total).toBe(expected.total)
  })

  it('taskPerformanceRewardFn 具名 task-performance', () => {
    const fn = taskPerformanceRewardFn({} as Llm)
    expect(fn.name).toBe('task-performance')
  })

  it('listRewardFns 无 llm 只含机制哨兵；有 llm 含两者', () => {
    expect(listRewardFns().map((f) => f.name)).toEqual(['mechanism-sentinel'])
    expect(listRewardFns({} as Llm).map((f) => f.name)).toEqual([
      'mechanism-sentinel',
      'task-performance',
    ])
  })

  it('reward-fn.ts 已被语义保护（grader 抽象）', () => {
    expect(isProtectedPath('apps/cli/src/core/reward-fn.ts')).toBe(true)
    expect(PROTECTED_CRITICAL_FILES).toContain('apps/cli/src/core/reward-fn.ts')
  })
})
