import { describe, it, expect } from 'vitest'
import { prefilterProposal, type ProducerProposal } from '../../src/core/proposal-guard'
import { MANAGED_RULE_MARKER } from '../../src/core/crsi-producer'
import { isProtectedPath } from '../../src/core/crsi-sandbox'

const VALID_SKILL = `---
name: foo
description: does foo
version: 1.0.0
---

# Foo

body
`

function skillProposal(overrides: Partial<ProducerProposal> = {}): ProducerProposal {
  return {
    id: 'p1',
    filePath: 'apps/cli/skills/standard/foo.SKILL.md',
    kind: 'skill',
    newContent: VALID_SKILL,
    ...overrides,
  }
}

describe('PROTECTED_PATHS 补洞（评估机制自保护）', () => {
  it('评估机制自身路径均受保护', () => {
    for (const p of [
      'apps/cli/src/core/eval-harness.ts',
      'apps/cli/src/core/behavior-tasks.ts',
      'apps/cli/src/core/behavior-tasks.json',
      'apps/cli/src/core/crsi-producer.ts',
      'apps/cli/src/core/proposal-guard.ts',
    ]) {
      expect(isProtectedPath(p)).toBe(true)
    }
  })
})

describe('prefilterProposal — 受保护路径与自引用', () => {
  it('拒绝受保护路径（宪法）', () => {
    const v = prefilterProposal(
      skillProposal({ filePath: 'apps/cli/src/core/alignment-vocabulary.json' }),
    )
    expect(v.pass).toBe(false)
    expect(v.reasons.join(' ')).toContain('protected')
  })

  it('拒绝自引用（eval-harness）', () => {
    const v = prefilterProposal(skillProposal({ filePath: 'apps/cli/src/core/eval-harness.ts' }))
    expect(v.pass).toBe(false)
  })

  it('拒绝自引用（behavior-tasks.json）', () => {
    const v = prefilterProposal(
      skillProposal({ filePath: 'apps/cli/src/core/behavior-tasks.json' }),
    )
    expect(v.pass).toBe(false)
  })

  it('拒绝自引用（crsi-producer）', () => {
    const v = prefilterProposal(skillProposal({ filePath: 'apps/cli/src/core/crsi-producer.ts' }))
    expect(v.pass).toBe(false)
  })

  it('拒绝自引用（proposal-guard 自身）', () => {
    const v = prefilterProposal(skillProposal({ filePath: 'apps/cli/src/core/proposal-guard.ts' }))
    expect(v.pass).toBe(false)
  })
})

describe('prefilterProposal — 目标范围', () => {
  it('拒绝非 skill 非 managed-rule 目标', () => {
    const v = prefilterProposal(
      skillProposal({ filePath: 'apps/cli/src/core/rule-engine.ts', kind: 'skill' }),
    )
    expect(v.pass).toBe(false)
    expect(v.reasons.join(' ')).toContain('out of scope')
  })

  it('拒绝 kind 与文件后缀不匹配', () => {
    const v = prefilterProposal(
      skillProposal({
        filePath: 'apps/cli/src/core/crsi-managed-rules.ts',
        kind: 'skill',
      }),
    )
    expect(v.pass).toBe(false)
  })
})

describe('prefilterProposal — 结构不变量', () => {
  it('拒绝缺失 frontmatter', () => {
    const v = prefilterProposal(skillProposal({ newContent: '# no frontmatter' }))
    expect(v.pass).toBe(false)
    expect(v.reasons.join(' ')).toContain('frontmatter')
  })

  it('拒绝 YAML 非法的 frontmatter', () => {
    const v = prefilterProposal(skillProposal({ newContent: '---\nname: [unclosed\n---\nbody' }))
    expect(v.pass).toBe(false)
  })

  it('拒绝 name 缺失', () => {
    const v = prefilterProposal(skillProposal({ newContent: '---\ndescription: hi\n---\nbody' }))
    expect(v.pass).toBe(false)
  })

  it('拒绝 description 缺失', () => {
    const v = prefilterProposal(skillProposal({ newContent: '---\nname: foo\n---\nbody' }))
    expect(v.pass).toBe(false)
  })

  it('拒绝 managed-rule 丢 marker', () => {
    const v = prefilterProposal({
      id: 'p2',
      filePath: 'apps/cli/src/core/crsi-managed-rules.ts',
      kind: 'managed-rule',
      newContent: 'export const MANAGED_RULES = []\n',
    })
    expect(v.pass).toBe(false)
    expect(v.reasons.join(' ')).toContain('marker')
  })
})

describe('prefilterProposal — 合法通过', () => {
  it('合法 skill 通过', () => {
    const v = prefilterProposal(skillProposal())
    expect(v.pass).toBe(true)
    expect(v.reasons).toHaveLength(0)
  })

  it('合法 mipham skill 通过', () => {
    const v = prefilterProposal(
      skillProposal({ filePath: 'apps/cli/skills/mipham/foo.mipham-skill.md' }),
    )
    expect(v.pass).toBe(true)
  })

  it('合法 managed-rule 通过', () => {
    const v = prefilterProposal({
      id: 'p3',
      filePath: 'apps/cli/src/core/crsi-managed-rules.ts',
      kind: 'managed-rule',
      newContent: `// ...\n${MANAGED_RULE_MARKER}\n  { id: 'managed-x', source: 'managed' },\n`,
    })
    expect(v.pass).toBe(true)
  })
})
