import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/mipham-test-probation` }
})

import {
  openProbation,
  settleProbation,
  readProbations,
  formatProbationLines,
  recordNoInstrument,
  PROBATION_WINDOW,
} from '../../src/core/probation'

const open = () =>
  openProbation({
    filePath: 'apps/cli/skills/standard/safe-coding.SKILL.md',
    skillName: 'safe-coding',
    commitHash: 'deadbeef',
    baselineScores: [100, 100],
    poolSize: 4,
  })

beforeEach(() => {
  rmSync(join(homedir(), '.mipham'), { recursive: true, force: true })
})

describe('试用期生命周期', () => {
  it('开窗后 checks 为空、verdict 缺席（不是 inconclusive）', () => {
    open()
    const [rec] = readProbations()
    expect(rec!.checks).toEqual([])
    expect('verdict' in rec!).toBe(false)
  })

  it('未结窗口在 stats 里显示 0/3 —— 「没开窗」与「开了没读数」不同形', () => {
    open()
    const lines = formatProbationLines().join('\n')
    expect(lines).toContain('safe-coding')
    expect(lines).toContain(`0/${PROBATION_WINDOW}`)
  })

  it('窗口未满不写 verdict', () => {
    open()
    settleProbation('safe-coding', 100)
    settleProbation('safe-coding', 100)
    expect('verdict' in readProbations()[0]!).toBe(false)
  })

  it('三次同分 ⇒ inconclusive（噪声为 0，地板仍是两题步长）', () => {
    open()
    settleProbation('safe-coding', 100)
    settleProbation('safe-coding', 100)
    const rec = settleProbation('safe-coding', 100)
    expect(rec!.verdict).toBe('inconclusive')
  })

  it('单题翻转（−25 分）不判退化', () => {
    open()
    settleProbation('safe-coding', 75)
    settleProbation('safe-coding', 75)
    const rec = settleProbation('safe-coding', 75)
    expect(rec!.verdict).toBe('inconclusive')
  })

  it('两题翻转（−50 分）⇒ regressed，且只打印回退命令不执行', () => {
    open()
    settleProbation('safe-coding', 50)
    settleProbation('safe-coding', 50)
    const rec = settleProbation('safe-coding', 50)
    expect(rec!.verdict).toBe('regressed')
    const lines = formatProbationLines().join('\n')
    expect(lines).toContain('git revert deadbeef')
  })

  it('没有未结窗口时结算返回 null', () => {
    expect(settleProbation('safe-coding', 100)).toBe(null)
  })
})

describe('没有随机信号的合并', () => {
  it('登记 noInstrument ⇒ stats 明说没有仪器，而不是静默缺席', () => {
    recordNoInstrument({ filePath: 'apps/cli/src/core/foo.ts', commitHash: 'cafebabe' })
    const lines = formatProbationLines().join('\n')
    expect(lines).toContain('no stochastic instrument for this merge')
    expect(lines).toContain('apps/cli/src/core/foo.ts')
  })

  it('noInstrument 记录不参与结算', () => {
    recordNoInstrument({ filePath: 'apps/cli/src/core/foo.ts', commitHash: 'cafebabe' })
    expect(settleProbation('core/foo.ts', 100)).toBe(null)
    expect(readProbations()[0]!.checks).toEqual([])
  })
})
