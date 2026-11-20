import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'
import { rmSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/mipham-test-probation-wiring` }
})

import {
  runCrsiModification,
  setPendingProbation,
  approvePending,
  rejectPending,
} from '../../src/core/crsi-modify'
import type { CrsiSandbox } from '../../src/core/crsi-sandbox'
import { readProbations, settleProbation, formatProbationLines } from '../../src/core/probation'

function fakeSandbox(): CrsiSandbox {
  return {
    createWorktree: () => {},
    applyModification: (m: unknown) => ({ applied: true, phase: 'passed', modification: m }),
    runTests: () => ({ passed: true }),
    rollback: () => ({ success: true, message: 'rolled back' }),
    getDiff: () => '',
    merge: () => ({ success: true, message: 'merged', commitHash: 'deadbeef' }),
    finalize: () => {},
  } as unknown as CrsiSandbox
}

const stubReward = {
  name: 'stub',
  description: 'stub',
  evaluate: async () => ({ score: 100, total: 40, passed: 40, failures: [] }),
}

beforeEach(() => {
  rmSync(join(homedir(), '.mipham'), { recursive: true, force: true })
})

describe('approve 后开试用期', () => {
  it('合并成功且有一次测量 ⇒ 台账里出现带 commitHash 的试用期', async () => {
    const r = await runCrsiModification(
      {
        description: 'tweak',
        filePath: 'apps/cli/skills/standard/safe-coding.SKILL.md',
        newContent: 'x',
        originalContent: 'y',
        blastRadius: ['apps/cli/skills/standard/safe-coding.SKILL.md'],
      },
      fakeSandbox(),
      { rewardFn: stubReward },
    )
    expect(r.phase).toBe('passed')

    setPendingProbation({
      filePath: 'apps/cli/skills/standard/safe-coding.SKILL.md',
      skillName: 'safe-coding',
      baselineScores: [100, 100, 100],
      poolSize: 4,
    })
    const approved = approvePending()
    expect(approved.success).toBe(true)
    expect(approved.probationOpened).toBe(true)

    const [rec] = readProbations()
    expect(rec!.commitHash).toBe('deadbeef')
    expect(rec!.skillName).toBe('safe-coding')
  })

  it('三次重测后 stats 里出现裁定', async () => {
    await runCrsiModification(
      {
        description: 'tweak',
        filePath: 'apps/cli/skills/standard/safe-coding.SKILL.md',
        newContent: 'x',
        originalContent: 'y',
        blastRadius: ['apps/cli/skills/standard/safe-coding.SKILL.md'],
      },
      fakeSandbox(),
      { rewardFn: stubReward },
    )
    setPendingProbation({
      filePath: 'apps/cli/skills/standard/safe-coding.SKILL.md',
      skillName: 'safe-coding',
      baselineScores: [100, 100, 100],
      poolSize: 4,
    })
    approvePending()
    settleProbation('safe-coding', 100)
    settleProbation('safe-coding', 100)
    settleProbation('safe-coding', 100)
    expect(formatProbationLines().join('\n')).toContain('inconclusive')
  })

  it('reject 不留下试用期', async () => {
    await runCrsiModification(
      {
        description: 'tweak',
        filePath: 'apps/cli/skills/standard/safe-coding.SKILL.md',
        newContent: 'x',
        originalContent: 'y',
        blastRadius: ['apps/cli/skills/standard/safe-coding.SKILL.md'],
      },
      fakeSandbox(),
      { rewardFn: stubReward },
    )
    setPendingProbation({
      filePath: 'apps/cli/skills/standard/safe-coding.SKILL.md',
      skillName: 'safe-coding',
      baselineScores: [100, 100, 100],
      poolSize: 4,
    })
    rejectPending()
    expect(readProbations()).toEqual([])
  })
})
