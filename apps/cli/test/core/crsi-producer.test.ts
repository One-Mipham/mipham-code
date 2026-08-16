import { describe, it, expect } from 'vitest'
import {
  selectCrsiSignal,
  buildLessonContent,
  produceCrsiProposal,
  LESSONS_FILE,
} from '../../src/core/crsi-producer'
import type { CrsiInsight } from '../../src/core/auto-memory'
import type { MetaRule } from '../../src/core/meta-rule-engine'

function insight(overrides: Partial<CrsiInsight> = {}): CrsiInsight {
  return {
    category: 'timeout',
    description: 'Bash 超时过低',
    severity: 'warning',
    suggestion: '增加 Bash timeout',
    evidence: ['npm install 超时'],
    autoApplicable: true,
    ...overrides,
  }
}

function metaRule(overrides: Partial<MetaRule> = {}): MetaRule {
  return {
    id: 'mr-1',
    category: 'threshold-tuning',
    title: '提高超时阈值',
    description: 'desc',
    recommendation: '调整阈值',
    autoApplicable: true,
    evidence: { sampleSize: 10, metrics: {}, relatedIds: [], summary: '10 次超时' },
    confidence: 'high',
    generatedAt: '2026-08-17T00:00:00Z',
    ...overrides,
  }
}

describe('selectCrsiSignal', () => {
  it('prioritizes critical insight over warning', () => {
    const warning = insight({ severity: 'warning', description: 'warning desc' })
    const critical = insight({ severity: 'critical', description: 'critical desc' })
    const signal = selectCrsiSignal([warning, critical], [])
    expect(signal?.title).toBe('critical desc')
  })

  it('filters out non-autoApplicable insights', () => {
    const nonAuto = insight({ autoApplicable: false, description: 'not auto' })
    const mr = metaRule()
    const signal = selectCrsiSignal([nonAuto], [mr])
    expect(signal?.title).toBe(mr.title) // falls back to meta-rule
  })

  it('falls back to high-confidence autoApplicable meta-rule when no insight', () => {
    const low = metaRule({ confidence: 'low', title: 'low conf' })
    const high = metaRule({ confidence: 'high', title: 'high conf' })
    const signal = selectCrsiSignal([], [low, high])
    expect(signal?.title).toBe('high conf')
  })

  it('returns null when no eligible signal', () => {
    expect(selectCrsiSignal([], [])).toBeNull()
    expect(
      selectCrsiSignal([insight({ autoApplicable: false })], [metaRule({ confidence: 'low' })]),
    ).toBeNull()
  })
})

describe('buildLessonContent', () => {
  it('renders suggestion, severity and evidence', () => {
    const content = buildLessonContent(
      {
        category: 'timeout',
        title: 'Bash 超时',
        severity: 'critical',
        suggestion: '加 timeout',
        evidence: ['e1', 'e2'],
      },
      '2026-08-17T00:00:00Z',
    )
    expect(content).toContain('## timeout: Bash 超时')
    expect(content).toContain('加 timeout')
    expect(content).toContain('critical')
    expect(content).toContain('- e1')
    expect(content).toContain('- e2')
  })
})

describe('produceCrsiProposal', () => {
  it('returns null when no signal', () => {
    expect(produceCrsiProposal([], [], '', 'ts')).toBeNull()
  })

  it('appends a lesson to existing content with correct filePath', () => {
    const existing = '# CRSI Lessons\n\n<!-- lessons below -->\n'
    const proposal = produceCrsiProposal(
      [insight({ description: 'Bash 超时过低', suggestion: '加 timeout' })],
      [],
      existing,
      '2026-08-17T00:00:00Z',
    )
    expect(proposal).not.toBeNull()
    expect(proposal!.filePath).toBe(LESSONS_FILE)
    expect(proposal!.newContent.startsWith(existing.trimEnd())).toBe(true)
    expect(proposal!.newContent).toContain('加 timeout')
    expect(proposal!.originalContent).toBe(existing)
  })

  it('creates content when file is empty', () => {
    const proposal = produceCrsiProposal([insight()], [], '', 'ts')
    expect(proposal).not.toBeNull()
    expect(proposal!.newContent).toContain('## timeout')
  })
})
