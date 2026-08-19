import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { runEval, appendEvalScore, getLastEvalScore } from '../../src/core/eval-harness'

// Isolate the rewards log from the real ~/.mipham.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-eval-harness`,
  }
})

beforeEach(() => {
  // 清空 rewards 日志，避免跨运行残留（tmpdir 不自动清理）。
  rmSync(join(homedir(), '.mipham', 'crsi', 'eval-scores.jsonl'), { force: true })
})

describe('runEval', () => {
  it('reports a full score after managed rules fill the behavior gaps', () => {
    const report = runEval()
    expect(report.total).toBe(31)
    expect(report.passed).toBe(31)
    expect(report.score).toBe(100)
    // 8 个行为缺口全部翻转 PASS（固化 managed tool-params 规则后），无任何 FAIL
    expect(report.failures).toHaveLength(0)
    // 机制契约仍在
    const ids = report.results.map((r) => r.id)
    expect(ids).toContain('rule-timeout')
    expect(ids).toContain('producer-rule-shape')
    expect(ids).toContain('red-team-zero-gaps')
  })

  it('covers all four CRSI contract dimensions', () => {
    const report = runEval()
    const ids = report.results.map((r) => r.id)
    expect(ids).toContain('rule-timeout')
    expect(ids).toContain('rule-git-force')
    expect(ids).toContain('constitution-facets')
    expect(ids).toContain('sandbox-protected-constitution')
    expect(ids).toContain('red-team-zero-gaps')
  })

  it('covers producer behavior contracts', () => {
    const report = runEval()
    const ids = report.results.map((r) => r.id)
    expect(ids).toContain('producer-rule-shape')
    expect(ids).toContain('producer-rule-idempotent')
  })

  it('includes behavior task results in the report', () => {
    const report = runEval()
    const ids = report.results.map((r) => r.id)
    expect(ids).toContain('behavior-rm-rf')
    expect(ids).toContain('behavior-leak-anthropic')
    expect(ids).toContain('behavior-leak-jwt')
  })
})

describe('rewards log', () => {
  it('getLastEvalScore returns null before any record', () => {
    expect(getLastEvalScore()).toBeNull()
  })

  it('appendEvalScore then getLastEvalScore round-trips the score', () => {
    appendEvalScore({ total: 10, passed: 8, score: 80, results: [], failures: [] })
    expect(getLastEvalScore()).toBe(80)
  })
})
