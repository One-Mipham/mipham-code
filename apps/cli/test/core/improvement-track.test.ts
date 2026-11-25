import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'
import { rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/mipham-test-improvement-track` }
})

import {
  computeMinEffect,
  classifyDelta,
  buildImprovementReport,
  formatCostLine,
  formatNullModelLine,
  formatRsiTaxLine,
  normalizeProblemKey,
  groupImprovementsByProblem,
  renderSimBlock,
  renderProblemHistory,
  measurementTaxSummary,
  wilsonInterval,
  improvementRate,
  improvementSignalStrong,
  predictionHit,
  predictionHitRate,
  appendImprovement,
  readImprovements,
  setPendingVerdict,
  getPendingVerdict,
  shouldBlockApproval,
  MIN_EFFECT_FLOOR,
  NOISE_K,
} from '../../src/core/improvement-track'
import type { ImprovementRecord } from '../../src/core/improvement-track'

beforeEach(() => {
  rmSync(join(homedir(), '.mipham', 'crsi', 'improvements.jsonl'), { force: true })
  setPendingVerdict(null)
})

describe('computeMinEffect', () => {
  it('噪声 0 → 固定下限', () => {
    expect(computeMinEffect(0)).toBe(MIN_EFFECT_FLOOR)
  })
  it('噪声大 → NOISE_K × noise', () => {
    expect(computeMinEffect(50)).toBe(NOISE_K * 50)
  })
})

describe('classifyDelta', () => {
  it('三分支边界（含等号）', () => {
    expect(classifyDelta(-21, 20)).toBe('regressed')
    expect(classifyDelta(-20, 20)).toBe('regressed')
    expect(classifyDelta(0, 20)).toBe('inconclusive')
    expect(classifyDelta(19, 20)).toBe('inconclusive')
    expect(classifyDelta(20, 20)).toBe('improved')
    expect(classifyDelta(30, 20)).toBe('improved')
  })
})

describe('buildImprovementReport', () => {
  it('强 skill 单组件 → delta 正、improved、causal true', () => {
    const report = buildImprovementReport(
      { skillName: 'safe-coding', baselineScores: [0, 0, 0], postScores: [100, 100, 100] },
      ['apps/cli/skills/standard/safe-coding.SKILL.md'],
    )
    expect(report.deltaMean).toBe(100)
    expect(report.noise).toBe(0)
    expect(report.minEffect).toBe(MIN_EFFECT_FLOOR)
    expect(report.verdict).toBe('improved')
    expect(report.causal).toBe(true)
  })
  it('多组件 → causal false；零位移 → inconclusive', () => {
    const report = buildImprovementReport(
      { skillName: 'safe-coding', baselineScores: [50, 50, 50], postScores: [50, 50, 50] },
      ['apps/cli/skills/standard/safe-coding.SKILL.md', 'apps/cli/src/foo.ts'],
    )
    expect(report.causal).toBe(false)
    expect(report.verdict).toBe('inconclusive')
  })
})

describe('代价维（B2）：只记录，不进闸', () => {
  const withCost = {
    skillName: 's',
    baselineScores: [50, 50],
    postScores: [70, 70],
    baselineDurations: [100, 120],
    postDurations: [300, 340],
  }

  it('耗时数组原样进报告', () => {
    const r = buildImprovementReport(withCost, ['f.md'])
    expect(r.baselineDurations).toEqual([100, 120])
    expect(r.postDurations).toEqual([300, 340])
  })

  it('判定与统计量完全不受耗时影响 —— 同一组分数，有无耗时逐字相同', () => {
    // 这是「不进闸」的机械判据：代价维一旦渗进 verdict / deltaMean / noise / minEffect，
    // 两条报告就不再相等。注意断言比的是**这些量本身**，不是整对象
    // ——整对象当然不等（耗时数组必然不同），那会把这个判据变成永远为真的仪式。
    const without = buildImprovementReport(
      { skillName: 's', baselineScores: [50, 50], postScores: [70, 70] },
      ['f.md'],
    )
    const with_ = buildImprovementReport(withCost, ['f.md'])
    expect(with_.verdict).toBe(without.verdict)
    expect(with_.deltaMean).toBe(without.deltaMean)
    expect(with_.noise).toBe(without.noise)
    expect(with_.minEffect).toBe(without.minEffect)
    expect(with_.causal).toBe(without.causal)
  })

  it('样本没有耗时 → 报告里两个键都不出现（缺席，而非空数组）', () => {
    // 与 B1 的 results 键同一条承重判据：写成 [] 会让「本次没测代价」与
    // 「本次测了、代价为零次采样」不可区分。旧记录本就没有这两个键。
    const r = buildImprovementReport(
      { skillName: 's', baselineScores: [50, 50], postScores: [70, 70] },
      ['f.md'],
    )
    expect('baselineDurations' in r).toBe(false)
    expect('postDurations' in r).toBe(false)
  })
})

describe('formatCostLine（代价维的只读展示）', () => {
  const base = { skillName: 's', baselineScores: [50, 50], postScores: [70, 70] }

  it('有代价 → 打印前/后均值，并给出倍数', () => {
    const r = buildImprovementReport(
      { ...base, baselineDurations: [1000, 1200], postDurations: [3000, 3400] },
      ['f.md'],
    )
    expect(formatCostLine(r)).toBe('⏱️ 代价: 均值 1100ms → 3200ms（×2.9）')
  })

  it('缺席 → null（调用方据此整行不打印，而不是打一行空/NaN）', () => {
    expect(formatCostLine(buildImprovementReport(base, ['f.md']))).toBeNull()
  })

  it('基线均值为 0 → 不给倍数，不出现 Infinity/NaN', () => {
    const r = buildImprovementReport(
      { ...base, baselineDurations: [0, 0], postDurations: [100, 100] },
      ['f.md'],
    )
    const line = formatCostLine(r)!
    expect(line).toBe('⏱️ 代价: 均值 0ms → 100ms')
    expect(line).not.toMatch(/Infinity|NaN|×/)
  })
})

describe('predictionHit', () => {
  it('真值表：达到预测算命中、未达不算、缺席恒 false', () => {
    expect(predictionHit(10, 20)).toBe(true) // 实际 20 ≥ 预测 10
    expect(predictionHit(50, 20)).toBe(false) // 实际 20 < 预测 50
    expect(predictionHit(20, 20)).toBe(true) // 等号算命中（贴线达成）
    expect(predictionHit(undefined, 20)).toBe(false)
  })

  it('不叠加 minEffect：负 delta 对上负预测照样算命中', () => {
    // ε 是提交者自己写下的数，判据就是「达到没达到」。
    // 若这里叠一层 minEffect(20)，(−5, −10) 会被判 false —— 那是把两个数打架。
    expect(predictionHit(-10, -5)).toBe(true)
  })
})

describe('predictionHitRate', () => {
  function rec(predictedDelta?: number, hit?: boolean): ImprovementRecord {
    return {
      skillName: 's',
      changeSet: ['f.md'],
      causal: true,
      baselineScores: [50],
      postScores: [70],
      deltaMean: 20,
      noise: 0,
      minEffect: 20,
      verdict: 'improved',
      id: 'x',
      timestamp: '2026-09-20T00:00:00.000Z',
      ...(predictedDelta !== undefined ? { predictedDelta, predictionHit: hit } : {}),
    }
  }

  it('分母只数有预测的记录，缺席既不入分子也不入分母', () => {
    const r = predictionHitRate([rec(10, true), rec(50, false), rec()])
    expect(r.total).toBe(2)
    expect(r.hits).toBe(1)
    expect(r.rate).toBe(0.5)
  })

  it('全部缺席 → total 0、rate 0，不除零', () => {
    const r = predictionHitRate([rec(), rec()])
    expect(r.total).toBe(0)
    expect(r.rate).toBe(0)
    expect(r.lo).toBe(0)
  })
})

describe('buildImprovementReport 带预测', () => {
  const SAMPLE = { skillName: 's', baselineScores: [50, 50], postScores: [70, 70] }

  it('给了预测 → 两个字段都写上', () => {
    const r = buildImprovementReport(SAMPLE, ['f.md'], 10)
    expect(r.deltaMean).toBe(20)
    expect(r.predictedDelta).toBe(10)
    expect(r.predictionHit).toBe(true) // 20 ≥ 10
  })

  it('没给预测 → 两个字段都不出现（而非 false）', () => {
    const r = buildImprovementReport(SAMPLE, ['f.md'])
    // 关键：缺席必须缺席。写成 predictionHit: false 会让「无预测」被算进分母，
    // 命中率就被「我们没预测」稀释成 0。
    expect('predictedDelta' in r).toBe(false)
    expect('predictionHit' in r).toBe(false)
  })
})

describe('wilsonInterval', () => {
  it('n=0 → 不除零，返回 0', () => {
    expect(wilsonInterval(0, 0)).toEqual({ lo: 0, hi: 0 })
  })
  it('全 improved → lo > 0', () => {
    const { lo, hi } = wilsonInterval(5, 5)
    expect(lo).toBeGreaterThan(0)
    expect(hi).toBeGreaterThanOrEqual(lo)
  })
})

describe('improvementRate / improvementSignalStrong', () => {
  it('空台账 → total 0', () => {
    expect(improvementRate([]).total).toBe(0)
  })
  it('全 inconclusive → signal 弱', () => {
    expect(improvementSignalStrong([mkRecord('inconclusive'), mkRecord('inconclusive')])).toBe(
      false,
    )
  })
  it('全 improved → signal 强', () => {
    expect(
      improvementSignalStrong([mkRecord('improved'), mkRecord('improved'), mkRecord('improved')]),
    ).toBe(true)
  })
})

describe('台账 append/read', () => {
  it('append → read 往返一致', () => {
    const rec = mkRecord('improved')
    appendImprovement(rec)
    const all = readImprovements()
    expect(all).toHaveLength(1)
    expect(all[0]!.id).toBe(rec.id)
    expect(all[0]!.verdict).toBe('improved')
  })
  it('append-only：追加后旧记录不变', () => {
    const r1 = mkRecord('improved')
    appendImprovement(r1)
    appendImprovement(mkRecord('regressed'))
    const all = readImprovements()
    expect(all).toHaveLength(2)
    expect(all[0]!.id).toBe(r1.id)
  })
})

describe('pending 闸', () => {
  it('set → get 往返', () => {
    setPendingVerdict('regressed')
    expect(getPendingVerdict()).toBe('regressed')
  })
  it('shouldBlockApproval 只拦 regressed', () => {
    expect(shouldBlockApproval('regressed')).toBe(true)
    expect(shouldBlockApproval('improved')).toBe(false)
    expect(shouldBlockApproval('inconclusive')).toBe(false)
  })
})

describe('④ 原子激活 — 台账原子写', () => {
  it('撕裂/坏行被 readImprovements 跳过，不抛', () => {
    const dir = join(homedir(), '.mipham', 'crsi')
    mkdirSync(dir, { recursive: true })
    const good = mkRecord('improved')
    writeFileSync(
      join(dir, 'improvements.jsonl'),
      JSON.stringify(good) + '\n{"torn": tru\n',
      'utf-8',
    )
    const all = readImprovements()
    expect(all).toHaveLength(1)
    expect(all[0]!.id).toBe(good.id)
  })

  it('append 走 temp+rename，无 .tmp 残留', () => {
    appendImprovement(mkRecord('improved'))
    expect(existsSync(join(homedir(), '.mipham', 'crsi', 'improvements.jsonl.tmp'))).toBe(false)
  })

  it('append 后账本自愈：坏行被重写剔除', () => {
    const dir = join(homedir(), '.mipham', 'crsi')
    mkdirSync(dir, { recursive: true })
    const good = mkRecord('improved')
    writeFileSync(join(dir, 'improvements.jsonl'), JSON.stringify(good) + '\n{bad\n', 'utf-8')
    appendImprovement(mkRecord('regressed'))
    const all = readImprovements()
    expect(all).toHaveLength(2)
    expect(all.every((r) => r.id && r.verdict)).toBe(true)
  })
})

describe('④ 原子激活 — pending 指针 manifest', () => {
  it('set 写入 manifest 文件，get 从文件读回', () => {
    setPendingVerdict('regressed')
    expect(existsSync(join(homedir(), '.mipham', 'crsi', 'pending-verdict.json'))).toBe(true)
    expect(getPendingVerdict()).toBe('regressed')
  })

  it('set(null) 原子清除 manifest', () => {
    setPendingVerdict('regressed')
    setPendingVerdict(null)
    expect(existsSync(join(homedir(), '.mipham', 'crsi', 'pending-verdict.json'))).toBe(false)
    expect(getPendingVerdict()).toBeNull()
  })

  it('manifest 坏内容 → get 返回 null 不抛', () => {
    const dir = join(homedir(), '.mipham', 'crsi')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'pending-verdict.json'), '{broken', 'utf-8')
    expect(getPendingVerdict()).toBeNull()
  })
})

function mkRecord(verdict: ImprovementRecord['verdict']): ImprovementRecord {
  return {
    id: Math.random().toString(36).slice(2),
    timestamp: new Date().toISOString(),
    skillName: 'safe-coding',
    changeSet: ['apps/cli/skills/standard/safe-coding.SKILL.md'],
    causal: true,
    baselineScores: [0, 0, 0],
    postScores: [100, 100, 100],
    deltaMean: 100,
    noise: 0,
    minEffect: 20,
    verdict,
  }
}

describe('空模型闸：空程序能过的题，不能算作模型的改进', () => {
  const base = { skillName: 'safe-coding', baselineScores: [0, 0, 0], postScores: [100, 100, 100] }

  it('claimed improved + 空模型有通过 → 降级为 inconclusive，并留读数', () => {
    const r = buildImprovementReport({ ...base, nullModelPassed: 1, nullModelTotal: 1 }, [
      'apps/cli/skills/standard/safe-coding.SKILL.md',
    ])
    expect(r.verdict).toBe('inconclusive')
    expect(r.nullModelPassed).toBe(1)
    expect(r.nullModelTotal).toBe(1)
    expect(r.nullModelGate).toBe('failed')
  })

  it('空模型 0 通过 → improved 保留，闸记为 passed', () => {
    const r = buildImprovementReport({ ...base, nullModelPassed: 0, nullModelTotal: 1 }, [
      'apps/cli/skills/standard/safe-coding.SKILL.md',
    ])
    expect(r.verdict).toBe('improved')
    expect(r.nullModelGate).toBe('passed')
  })

  it('regressed 不被空模型闸洗白 —— 闸只拦「假赢」，不改写真输', () => {
    const r = buildImprovementReport(
      {
        skillName: 's',
        baselineScores: [100, 100, 100],
        postScores: [0, 0, 0],
        nullModelPassed: 1,
        nullModelTotal: 1,
      },
      ['f.md'],
    )
    expect(r.verdict).toBe('regressed')
    expect(r.nullModelGate).toBe('failed')
  })

  it('样本未带空模型读数 → 报告里三个键都不出现（旧记录兼容）', () => {
    const r = buildImprovementReport(base, ['f.md'])
    expect('nullModelPassed' in r).toBe(false)
    expect('nullModelTotal' in r).toBe(false)
    expect('nullModelGate' in r).toBe(false)
  })
})

describe('formatNullModelLine', () => {
  it('闸失败时点明「空程序也能过」的题数', () => {
    const r = buildImprovementReport(
      {
        skillName: 'safe-coding',
        baselineScores: [0, 0, 0],
        postScores: [100, 100, 100],
        nullModelPassed: 2,
        nullModelTotal: 3,
      },
      ['f.md'],
    )
    const line = formatNullModelLine(r)
    expect(line).toContain('空模型')
    expect(line).toContain('2/3')
  })

  it('闸通过时不出声（不占一行）', () => {
    const r = buildImprovementReport(
      {
        skillName: 'safe-coding',
        baselineScores: [0, 0, 0],
        postScores: [100, 100, 100],
        nullModelPassed: 0,
        nullModelTotal: 1,
      },
      ['f.md'],
    )
    expect(formatNullModelLine(r)).toBeNull()
  })
})

describe('SIM：问题分组与理由（只记录，不进判定）', () => {
  const base = { skillName: 'safe-coding', baselineScores: [50, 50], postScores: [70, 70] }

  it('context 两键原样进报告；判定不受影响', () => {
    const plain = buildImprovementReport(base, ['f.md'])
    const tagged = buildImprovementReport(base, ['f.md'], undefined, {
      problemKey: normalizeProblemKey('  Tool  Timeout  '),
      rationale: 'tool timeout 反复出现',
    })
    expect(tagged.problemKey).toBe('tool timeout')
    expect(tagged.rationale).toBe('tool timeout 反复出现')
    expect(tagged.verdict).toBe(plain.verdict)
    expect(tagged.deltaMean).toBe(plain.deltaMean)
  })

  it('缺席 → 键不出现（旧记录形态不变）', () => {
    const r = buildImprovementReport(base, ['f.md'])
    expect('problemKey' in r).toBe(false)
    expect('rationale' in r).toBe(false)
  })

  it('两键各自独立：只有理由也能写', () => {
    const r = buildImprovementReport(base, ['f.md'], undefined, { rationale: 'why' })
    expect(r.rationale).toBe('why')
    expect('problemKey' in r).toBe(false)
  })

  it('按问题聚合：无键记录不进组，但仍留在总台账', () => {
    const rec = (
      problemKey: string | undefined,
      verdict: 'improved' | 'regressed' | 'inconclusive',
      deltaMean: number,
    ): ImprovementRecord => ({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      skillName: 's',
      changeSet: ['f.md'],
      causal: true,
      baselineScores: [0],
      postScores: [deltaMean],
      deltaMean,
      noise: 0,
      minEffect: 20,
      verdict,
      ...(problemKey ? { problemKey } : {}),
    })
    const records = [
      rec('a', 'improved', 30),
      rec('a', 'regressed', -25),
      rec('b', 'improved', 40),
      rec(undefined, 'improved', 50),
    ]
    const groups = groupImprovementsByProblem(records)
    expect(groups.map((g) => [g.key, g.total, g.improved])).toEqual([
      ['a', 2, 1],
      ['b', 1, 1],
    ])
    expect(groups[0]!.meanDelta).toBe(2.5)
  })
})

describe('RSI Tax：测量 token（只记录，不进闸）', () => {
  const base = { skillName: 's', baselineScores: [50, 50], postScores: [70, 70] }

  it('两个数组同生同灭地进报告', () => {
    const r = buildImprovementReport(
      { ...base, baselineTokens: [100, 120], postTokens: [200, 240] },
      ['f.md'],
    )
    expect(r.baselineTokens).toEqual([100, 120])
    expect(r.postTokens).toEqual([200, 240])
    expect(formatRsiTaxLine(r)).toBe('💸 验证 token（RSI Tax）: 前 220 → 后 440（合计 660）')
  })

  it('缺席 → 键不出现、展示行 null（不打 0 或 NaN）', () => {
    const r = buildImprovementReport(base, ['f.md'])
    expect('baselineTokens' in r).toBe(false)
    expect(formatRsiTaxLine(r)).toBeNull()
  })

  it('汇总只统计带 token 的记录，均值四舍五入', () => {
    const mk = (b?: number[], p?: number[]): ImprovementRecord => ({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      skillName: 's',
      changeSet: ['f.md'],
      causal: true,
      baselineScores: [0],
      postScores: [0],
      deltaMean: 0,
      noise: 0,
      minEffect: 20,
      verdict: 'inconclusive',
      ...(b && p ? { baselineTokens: b, postTokens: p } : {}),
    })
    const s = measurementTaxSummary([mk([100], [50]), mk([10], [10]), mk()])
    expect(s.records).toBe(2)
    expect(s.totalTokens).toBe(170)
    expect(s.meanTokens).toBe(85)
  })
})

describe('命令面：两条渲染路径都接了空模型闸', () => {
  it('commands.ts 至少两处调用（手工路径 + prose 路径）', () => {
    // 只接一条就是本仓库记过的「局部正确全局遗漏」：另一条路径照旧把降级判定
    // 当普通结果展示，用户看不到它为什么变 inconclusive。
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'src', 'ui', 'commands.ts'),
      'utf8',
    )
    const hits = src.match(/formatNullModelLine\(report\)/g) ?? []
    expect(hits.length).toBeGreaterThanOrEqual(2)
  })
})

describe('SIM 读侧：renderSimBlock（注入给提议者）', () => {
  const rec = (
    problemKey: string | undefined,
    verdict: 'improved' | 'regressed' | 'inconclusive',
    deltaMean: number,
    timestamp: string,
    extra: { rationale?: string; predictedDelta?: number; predictionHit?: boolean } = {},
  ): ImprovementRecord => ({
    id: randomUUID(),
    timestamp,
    skillName: 's',
    changeSet: ['f.md'],
    causal: true,
    baselineScores: [0],
    postScores: [deltaMean],
    deltaMean,
    noise: 0,
    minEffect: 20,
    verdict,
    ...(problemKey ? { problemKey } : {}),
    ...extra,
  })

  it('空台账 → 空串（不注入只有标题的空块）', () => {
    expect(renderSimBlock([])).toBe('')
  })

  it('只有无问题键的旧记录 → 空串（分组是视图，但没有组可写）', () => {
    expect(renderSimBlock([rec(undefined, 'improved', 30, '2026-11-20T00:00:00Z')])).toBe('')
  })

  it('按问题分组：组按最近尝试倒序，组内最近在前，含理由/预测/实测/结论', () => {
    const block = renderSimBlock([
      rec('完成门', 'regressed', -8, '2026-11-19T00:00:00Z', { rationale: '再加一层完成检查' }),
      rec('解析器', 'improved', 30, '2026-11-18T00:00:00Z', { rationale: '旧' }),
      rec('完成门', 'improved', 12.5, '2026-11-20T00:00:00Z', {
        rationale: '完成前须验执行证据',
        predictedDelta: 20,
        predictionHit: true,
      }),
    ])
    const lines = block.split('\n')
    expect(lines[0]).toBe('## SIM（Self-Improvement Memory）')
    expect(lines[2]).toBe('- 完成门（2 次，1 improved）')
    expect(lines[3]).toBe(
      '  - [improved] 2026-11-20 · 理由: 完成前须验执行证据 · 预测 20 → 实测 +12.5（命中）',
    )
    expect(lines[4]).toBe('  - [regressed] 2026-11-19 · 理由: 再加一层完成检查 · 实测 -8.0')
    expect(lines[5]).toBe('- 解析器（1 次，1 improved）')
    expect(lines[6]).toBe('  - [improved] 2026-11-18 · 理由: 旧 · 实测 +30.0')
  })

  it('预测未命中照实打印（预测与实测并列，不掩盖）', () => {
    const block = renderSimBlock([
      rec('x', 'inconclusive', 2, '2026-11-20T00:00:00Z', {
        predictedDelta: 20,
        predictionHit: false,
      }),
    ])
    expect(block).toContain('预测 20 → 实测 +2.0（未命中）')
  })

  it('超出组上限 → 显式写「另有 K 组未注入」', () => {
    const records = Array.from({ length: 11 }, (_, i) =>
      rec(`p${i}`, 'improved', 30, `2026-11-${String(i + 10).padStart(2, '0')}T00:00:00Z`),
    )
    const block = renderSimBlock(records)
    expect(block).toContain(`… 另有 3 组未注入（共 11 组）`)
  })

  it('超出次数上限 → 显式写「该组另有 K 次更早尝试未列出」', () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      rec('same', 'improved', 30, `2026-11-${String(i + 10).padStart(2, '0')}T00:00:00Z`),
    )
    const block = renderSimBlock(records)
    expect(block).toContain('… 该组另有 2 次更早尝试未列出')
    // 最近的在前：5 号（11-14）必须出现，1 号（11-10）必须被省略
    expect(block).toContain('2026-11-14')
    expect(block).not.toContain('2026-11-10')
  })

  it('无问题键的记录数在尾行显式标注（缺席不等于没有问题）', () => {
    const block = renderSimBlock([
      rec('k', 'improved', 30, '2026-11-20T00:00:00Z'),
      rec(undefined, 'improved', 30, '2026-11-20T00:00:00Z'),
      rec(undefined, 'regressed', -30, '2026-11-20T00:00:00Z'),
    ])
    expect(block).toContain('… 另有 2 条无问题键的记录未纳入')
  })

  it('理由过长被截断，且带省略号（预算可算）', () => {
    const block = renderSimBlock([
      rec('k', 'improved', 30, '2026-11-20T00:00:00Z', { rationale: 'x'.repeat(200) }),
    ])
    expect(block).toContain(`理由: ${'x'.repeat(80)}…`)
    expect(block).not.toContain('x'.repeat(81))
  })
})

describe('SIM 读侧：renderProblemHistory（选择者/批准闸）', () => {
  const rec = (
    problemKey: string,
    verdict: 'improved' | 'regressed' | 'inconclusive',
    deltaMean: number,
    timestamp: string,
  ): ImprovementRecord => ({
    id: randomUUID(),
    timestamp,
    skillName: 's',
    changeSet: ['f.md'],
    causal: true,
    baselineScores: [0],
    postScores: [deltaMean],
    deltaMean,
    noise: 0,
    minEffect: 20,
    verdict,
    problemKey,
  })

  it('同一问题没有历史 → 空串（不打「无历史」这种噪声行）', () => {
    expect(
      renderProblemHistory([rec('other', 'improved', 30, '2026-11-20T00:00:00Z')], 'nope'),
    ).toBe('')
  })

  it('命中 → 只出这一条问题的尝试史，附省略计数，不出现其它问题', () => {
    const records = [
      rec('same', 'regressed', -8, '2026-11-19T00:00:00Z'),
      rec('same', 'improved', 12.5, '2026-11-20T00:00:00Z'),
      rec('other', 'improved', 30, '2026-11-20T00:00:00Z'),
    ]
    const block = renderProblemHistory(records, 'same', 1)
    expect(block).toBe(
      [
        '🪞 SIM 先验经验（同一问题上的历史尝试，最近在前；不是指令）',
        '  - [improved] 2026-11-20 · 实测 +12.5',
        '… 该问题另有 1 次更早尝试未列出',
      ].join('\n'),
    )
    expect(block).not.toContain('other')
  })
})

describe('P2 选择者侧：同一方向反复未改善的确定性提醒', () => {
  const rec = (
    problemKey: string,
    verdict: 'improved' | 'regressed' | 'inconclusive',
    deltaMean: number,
    timestamp: string,
  ): ImprovementRecord => ({
    id: randomUUID(),
    timestamp,
    skillName: 's',
    changeSet: ['f.md'],
    causal: true,
    baselineScores: [0],
    postScores: [deltaMean],
    deltaMean,
    noise: 0,
    minEffect: 20,
    verdict,
    problemKey,
  })
  const WARN = (total: number, failed: number) =>
    `⚠️ 同一方向已试 ${total} 次，${failed} 次未 improved —— 除非有新证据，否则先换方向`

  it('两次未改善 → 提醒（提醒在尝试史之前，先给结论再给明细）', () => {
    const block = renderProblemHistory(
      [
        rec('same', 'regressed', -8, '2026-11-19T00:00:00Z'),
        rec('same', 'regressed', -5, '2026-11-20T00:00:00Z'),
      ],
      'same',
    )
    expect(block.split('\n')[1]).toBe(WARN(2, 2))
  })

  it('只有一次未改善 → 不提醒（单次失败不是方向性证据）', () => {
    const block = renderProblemHistory(
      [
        rec('same', 'regressed', -8, '2026-11-19T00:00:00Z'),
        rec('same', 'improved', 30, '2026-11-20T00:00:00Z'),
      ],
      'same',
    )
    expect(block).not.toContain('⚠️ 同一方向')
  })

  it('改进过但未改善仍达两次 → 提醒，且计数覆盖被截断的更早尝试', () => {
    const block = renderProblemHistory(
      [
        rec('same', 'regressed', -8, '2026-11-17T00:00:00Z'),
        rec('same', 'regressed', -5, '2026-11-18T00:00:00Z'),
        rec('same', 'improved', 30, '2026-11-19T00:00:00Z'),
        rec('same', 'inconclusive', 2, '2026-11-20T00:00:00Z'),
      ],
      'same',
      1,
    )
    expect(block).toContain(WARN(4, 3))
  })

  it('inconclusive 不计为改善（未判定 ≠ 有证据）', () => {
    const block = renderProblemHistory(
      [
        rec('same', 'inconclusive', 2, '2026-11-19T00:00:00Z'),
        rec('same', 'inconclusive', 3, '2026-11-20T00:00:00Z'),
      ],
      'same',
    )
    expect(block).toContain(WARN(2, 2))
  })
})
