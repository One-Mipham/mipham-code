import { describe, it, expect } from 'vitest'
import { ExperienceRuleExtractor } from '../../src/agent/experience-rules.js'
import type { ExperienceRule } from '../../src/agent/experience-rules.js'

function makeExperience(failures: string[]): string {
  const header = `# Agent Experience — test-agent

## Success Patterns

- [2026-08-07] Fixed import cycle by glob scanning
  **When to apply:** cross-module PR review

## Failure Patterns
`
  const footer = `
## Stats
- 总执行: 10 次 | 成功: 7 | 失败: 3
`
  return (
    header +
    failures
      .map(
        (f, i) => `- [2026-08-0${7 - i}] ${f}
  **When to avoid:** auto-generated`,
      )
      .join('\n') +
    footer
  )
}

describe('ExperienceRuleExtractor', () => {
  const extractor = new ExperienceRuleExtractor()

  it('returns empty array for empty experience content', () => {
    expect(extractor.extract('', 'test-agent')).toEqual([])
    expect(
      extractor.extract(
        '# Agent Experience — test-agent\n\n## Success Patterns\n\n## Failure Patterns\n\n## Stats\n- 总执行: 0 次 | 成功: 0 | 失败: 0\n',
        'test-agent',
      ),
    ).toEqual([])
  })

  it('does not generate rules for single failures', () => {
    const exp = makeExperience(['npm install timeout at 120s'])
    const rules = extractor.extract(exp, 'test-agent')
    expect(rules).toEqual([])
  })

  it('generates warning rule for 2 failures of same category', () => {
    const exp = makeExperience(['npm install timeout at 120s', 'pnpm install timeout at 120s'])
    const rules = extractor.extract(exp, 'test-agent')
    expect(rules.length).toBeGreaterThanOrEqual(1)
    const timeoutRule = rules.find((r) => r.category === 'timeout')
    expect(timeoutRule).toBeDefined()
    expect(timeoutRule!.type).toBe('warning')
    expect(timeoutRule!.evidence.failureCount).toBe(2)
  })

  it('generates mandatory rule for 3+ failures of same category', () => {
    const exp = makeExperience([
      'npm install timeout at 120s',
      'docker build timeout at 120s',
      'pnpm install timeout at 120s',
    ])
    const rules = extractor.extract(exp, 'test-agent')
    const timeoutRule = rules.find((r) => r.category === 'timeout')
    expect(timeoutRule).toBeDefined()
    expect(timeoutRule!.type).toBe('mandatory')
    expect(timeoutRule!.evidence.failureCount).toBe(3)
  })

  it('categorizes MODULE_NOT_FOUND as import', () => {
    const exp = makeExperience(['MODULE_NOT_FOUND for ./foo', 'MODULE_NOT_FOUND for ./bar'])
    const rules = extractor.extract(exp, 'test-agent')
    const importRule = rules.find((r) => r.category === 'import')
    expect(importRule).toBeDefined()
  })

  it('categorizes grep/token errors as search', () => {
    const exp = makeExperience([
      'Grep returned 450K tokens — overflow',
      'Grep search scope too large — 300K tokens',
    ])
    const rules = extractor.extract(exp, 'test-agent')
    const searchRule = rules.find((r) => r.category === 'search')
    expect(searchRule).toBeDefined()
  })

  it('assigns unique IDs to each rule', () => {
    const exp = makeExperience([
      'npm install timeout at 120s',
      'npm install timeout at 120s',
      'npm install timeout at 120s',
      'MODULE_NOT_FOUND for ./foo',
      'MODULE_NOT_FOUND for ./foo',
    ])
    const rules = extractor.extract(exp, 'test-agent')
    const ids = rules.map((r) => r.id)
    expect(new Set(ids).size).toBe(ids.length) // all unique
  })

  it('formatForInjection produces correct markdown', () => {
    const rules: ExperienceRule[] = [
      {
        id: 'rule-timeout-abc',
        type: 'mandatory',
        condition: 'npm/docker commands',
        action: 'set timeout ≥ 300s',
        evidence: {
          failureCount: 3,
          lastFailure: '2026-08-07',
          examples: ['npm install timeout at 120s'],
        },
        category: 'timeout',
        source: 'agent-experience',
        agentName: 'test-agent',
        createdAt: '2026-08-08',
      },
    ]
    const formatted = extractor.formatForInjection(rules)
    expect(formatted).toContain('## ⚠️ Active Mandatory Rules')
    expect(formatted).toContain('[timeout]')
    expect(formatted).toContain('Evidence: 3 failures')
    expect(formatted).toContain('npm install timeout at 120s')
  })

  it('prioritize orders mandatory before warning', () => {
    const rules: ExperienceRule[] = [
      {
        id: 'r1',
        type: 'warning',
        category: 'search',
        condition: '',
        action: '',
        evidence: { failureCount: 2, lastFailure: '', examples: [] },
        source: 'agent-experience',
        agentName: 'x',
        createdAt: '',
      },
      {
        id: 'r2',
        type: 'mandatory',
        category: 'timeout',
        condition: '',
        action: '',
        evidence: { failureCount: 3, lastFailure: '', examples: [] },
        source: 'agent-experience',
        agentName: 'x',
        createdAt: '',
      },
    ]
    const prioritized = extractor.prioritize(rules)
    expect(prioritized[0]!.type).toBe('mandatory')
    expect(prioritized[1]!.type).toBe('warning')
  })
})
