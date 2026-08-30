import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  runEval,
  appendEvalScore,
  getLastEvalScore,
  regressedAnchors,
} from '../../src/core/eval-harness'

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
    expect(report.total).toBe(37)
    expect(report.passed).toBe(37)
    expect(report.score).toBe(100)
    // 8 个行为缺口全部翻转 PASS（固化 managed tool-params 规则后），无任何 FAIL
    expect(report.failures).toHaveLength(0)
    // 机制契约仍在
    const ids = report.results.map((r) => r.id)
    expect(ids).toContain('rule-timeout')
    expect(ids).toContain('producer-rule-shape')
    expect(ids).toContain('red-team-zero-gaps')
    expect(ids).toContain('blast-radius-gate')
  })

  it('包含语义边界完整性契约（关键机制文件全覆盖）', () => {
    const report = runEval()
    const contract = report.results.find((r) => r.id === 'protection-completeness')
    expect(contract).toBeDefined()
    expect(contract!.passed).toBe(true)
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

  it('includes anchor-gate self-check contract (all anchors green)', () => {
    const report = runEval()
    const contract = report.results.find((r) => r.id === 'anchor-gate')
    expect(contract).toBeDefined()
    expect(contract!.passed).toBe(true)
    // 所有 anchor 契约当前全绿，无任何回退。
    expect(regressedAnchors(report.results)).toEqual([])
  })
})

describe('regressedAnchors', () => {
  it('returns anchor ids that flipped to FAIL, ignoring target/neutral', () => {
    const results = [
      { id: 'anchor-a', description: 'x', passed: false, role: 'anchor' as const },
      { id: 'anchor-b', description: 'x', passed: true, role: 'anchor' as const },
      { id: 'target-a', description: 'x', passed: false, role: 'target' as const },
      { id: 'neutral-a', description: 'x', passed: false },
    ]
    expect(regressedAnchors(results)).toEqual(['anchor-a'])
  })

  it('returns empty when all anchors pass', () => {
    const results = [
      { id: 'anchor-a', description: 'x', passed: true, role: 'anchor' as const },
      { id: 'target-a', description: 'x', passed: false, role: 'target' as const },
    ]
    expect(regressedAnchors(results)).toEqual([])
  })
})

describe('rewards log', () => {
  it('getLastEvalScore returns null before any record', () => {
    expect(getLastEvalScore('mechanism-sentinel')).toBeNull()
  })

  it('appendEvalScore then getLastEvalScore round-trips the score', () => {
    appendEvalScore('mechanism-sentinel', { total: 10, passed: 8, score: 80 })
    expect(getLastEvalScore('mechanism-sentinel')).toBe(80)
  })

  it('ledger keyed by name isolates scores', () => {
    appendEvalScore('a', { score: 80, passed: 8, total: 10 })
    appendEvalScore('b', { score: 40, passed: 4, total: 10 })
    expect(getLastEvalScore('a')).toBe(80)
    expect(getLastEvalScore('b')).toBe(40)
    expect(getLastEvalScore('c')).toBeNull()
  })

  it('same-name records return the latest score (scan-from-end)', () => {
    appendEvalScore('a', { score: 80, passed: 8, total: 10 })
    appendEvalScore('a', { score: 40, passed: 4, total: 10 })
    expect(getLastEvalScore('a')).toBe(40)
  })
})
