import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'
import { rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/mipham-test-improvement-track` }
})

import {
  computeMinEffect,
  classifyDelta,
  buildImprovementReport,
  formatCostLine,
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
