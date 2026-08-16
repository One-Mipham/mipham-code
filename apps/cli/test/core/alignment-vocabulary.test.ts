import { describe, it, expect } from 'vitest'
import alignmentVocabulary from '../../src/core/alignment-vocabulary.json'
import { DEFAULT_CONSTITUTION } from '../../src/core/constitution-loader'

const FACETS = ['karuna', 'prajna', 'vajra'] as const

describe('alignment-vocabulary (vendored)', () => {
  it('has 3 values with the fixed facet ids', () => {
    const values = alignmentVocabulary.values
    expect(values).toHaveLength(3)
    expect(values.map((v) => v.id).sort()).toEqual(['karuna', 'prajna', 'vajra'])
  })

  it('has 8 principles, each facet pointing at a known value', () => {
    expect(alignmentVocabulary.principles).toHaveLength(8)
    for (const p of alignmentVocabulary.principles) {
      expect(FACETS).toContain(p.facet)
    }
  })

  it('exposes the karuna (悲) gap — zero principles operationalize 悲', () => {
    const karunaPrinciples = alignmentVocabulary.principles.filter((p) => p.facet === 'karuna')
    expect(karunaPrinciples).toHaveLength(0)
  })

  it('facet mapping matches the spec (prajna=3, vajra=5)', () => {
    const byFacet = (facet: string) =>
      alignmentVocabulary.principles.filter((p) => p.facet === facet).map((p) => p.id).sort()
    expect(byFacet('prajna')).toEqual(
      ['never-fabricate', 'persist-crsi-learning', 'think-before-coding'].sort(),
    )
    expect(byFacet('vajra')).toEqual(
      [
        'minimal-change',
        'no-credential-leak',
        'no-destructive-without-confirmation',
        'respect-permissions',
        'simplicity-first',
      ].sort(),
    )
  })

  it('every principle enforce is one of block/warn/auto', () => {
    const valid = ['block', 'warn', 'auto'] as const
    for (const p of alignmentVocabulary.principles) {
      expect(valid).toContain(p.enforce)
    }
  })
})

describe('constitution-loader derives from the vocabulary', () => {
  it('DEFAULT_CONSTITUTION principles have a valid enforce', () => {
    const valid = ['block', 'warn', 'auto'] as const
    for (const p of DEFAULT_CONSTITUTION.principles) {
      expect(valid).toContain(p.enforce)
    }
  })

  it('DEFAULT_CONSTITUTION principles carry a facet', () => {
    for (const p of DEFAULT_CONSTITUTION.principles) {
      expect(FACETS).toContain(p.facet)
    }
  })

  it('never-fabricate audit_pattern uses escaped whitespace (\\\\s)', () => {
    const neverFabricate = DEFAULT_CONSTITUTION.principles.find((p) => p.id === 'never-fabricate')
    expect(neverFabricate?.audit_pattern).toContain('\\s')
  })
})
