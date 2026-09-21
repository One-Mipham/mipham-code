import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  runEval,
  appendEvalScore,
  getLastEvalScore,
  getContractHistory,
  diffContractHistory,
  renderContractDiff,
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
    expect(report.total).toBe(40)
    expect(report.passed).toBe(40)
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

  it('locks self-report-diagnostic as an anchor: no LLM in the scoring path', () => {
    const report = runEval()
    const contract = report.results.find((r) => r.id === 'self-report-diagnostic')
    expect(contract).toBeDefined()
    // anchor 角色：门（crsi-modify）强制此契约零回退。
    expect(contract!.role).toBe('anchor')
    // 评分路径无 LLM：分数只来自 ground-truth 契约，非模型自报。
    expect(contract!.passed).toBe(true)
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

// ── B1：按契约粒度落盘 ──
// 动机：聚合分数只能回答「总分涨没涨」。落 per-contract 的 {id, passed, role}
// 之后，账本才能回答「是哪条契约翻的」——这正是区分「真回归」与「抖动」的前提。
describe('契约粒度账本', () => {
  it('appendEvalScore 落契约粒度，getContractHistory 读回 id→passed', () => {
    appendEvalScore('mechanism-sentinel', {
      total: 2,
      passed: 1,
      score: 50,
      results: [
        { id: 'a', description: 'a', passed: true, role: 'anchor' as const },
        { id: 'b', description: 'b', passed: false },
      ],
    })
    expect(getContractHistory('mechanism-sentinel')).toEqual([{ a: true, b: false }])
  })

  it('getContractHistory 跳过没有 results 的旧记录（向后兼容）', () => {
    // 旧形态：B1 之前落盘的记录只有聚合分数（本调用不传 results）
    appendEvalScore('mechanism-sentinel', { total: 40, passed: 40, score: 100 })
    appendEvalScore('mechanism-sentinel', {
      total: 1,
      passed: 0,
      score: 0,
      results: [{ id: 'a', description: 'a', passed: false }],
    })
    expect(getContractHistory('mechanism-sentinel')).toEqual([{ a: false }])
  })

  it('getContractHistory 按新→旧返回，且只回最近 n 条', () => {
    for (const p of [true, false, true]) {
      appendEvalScore('r', {
        total: 1,
        passed: p ? 1 : 0,
        score: p ? 100 : 0,
        results: [{ id: 'c', description: 'c', passed: p }],
      })
    }
    expect(getContractHistory('r', 2)).toEqual([{ c: true }, { c: false }])
    expect(getContractHistory('r')).toEqual([{ c: true }, { c: false }, { c: true }])
  })

  it('getContractHistory 按 name 隔离', () => {
    appendEvalScore('a', {
      total: 1,
      passed: 1,
      score: 100,
      results: [{ id: 'x', description: 'x', passed: true }],
    })
    expect(getContractHistory('b')).toEqual([])
  })

  it('diffContractHistory：regressed / fixed / new / gone', () => {
    const current = [
      { id: 'a', passed: false },
      { id: 'b', passed: true },
      { id: 'c', passed: true },
    ]
    const history = [{ a: true, b: false, d: true }]
    expect(diffContractHistory(current, history)).toEqual([
      { id: 'a', delta: 'regressed' },
      { id: 'b', delta: 'fixed' },
      { id: 'c', delta: 'new' },
      { id: 'd', delta: 'gone' },
    ])
  })

  it('diffContractHistory：两次结果都出现过 → flaky 压过 regressed/fixed', () => {
    const current = [{ id: 'x', passed: true }]
    // 上一次 FAIL、本次 PASS —— 若只比相邻两次会误判成 fixed
    expect(diffContractHistory(current, [{ x: false }, { x: true }])).toEqual([
      { id: 'x', delta: 'flaky' },
    ])
  })

  it('diffContractHistory：未变化的契约不出现（只报变化）', () => {
    expect(diffContractHistory([{ id: 'a', passed: true }], [{ a: true }])).toEqual([])
  })

  it('diffContractHistory：history 为空时全部为 new', () => {
    expect(diffContractHistory([{ id: 'a', passed: true }], [])).toEqual([
      { id: 'a', delta: 'new' },
    ])
  })

  it('diffContractHistory 透传 role（供展示层标 anchor）', () => {
    expect(
      diffContractHistory([{ id: 'a', passed: false, role: 'anchor' as const }], [{ a: true }]),
    ).toEqual([{ id: 'a', delta: 'regressed', role: 'anchor' }])
  })

  it('renderContractDiff 五种 delta 各自的文案', () => {
    const lines = renderContractDiff([
      { id: 'r', delta: 'regressed' },
      { id: 'f', delta: 'fixed' },
      { id: 'k', delta: 'flaky' },
      { id: 'n', delta: 'new' },
      { id: 'g', delta: 'gone' },
    ])
    expect(lines).toEqual([
      '❌ r ← 上次 PASS，本次 FAIL（回归）',
      '✅ f ← 上次 FAIL，本次 PASS（已修复）',
      '⚠️ k ← 近几次结果不一致（抖动）',
      '🆕 n ← 本次新增的契约',
      '➖ g ← 本次未出现（已移出契约集）',
    ])
  })

  it('renderContractDiff 给 anchor 契约加标记', () => {
    expect(renderContractDiff([{ id: 'a', delta: 'regressed', role: 'anchor' }])).toEqual([
      '❌ a ← 上次 PASS，本次 FAIL（回归） `anchor`',
    ])
  })

  it('renderContractDiff 无变化时返回空数组', () => {
    expect(renderContractDiff([])).toEqual([])
  })
})
