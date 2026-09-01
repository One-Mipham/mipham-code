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
  wilsonInterval,
  improvementRate,
  improvementSignalStrong,
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
