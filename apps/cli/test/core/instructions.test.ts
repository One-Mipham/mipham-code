import { describe, it, expect } from 'vitest'
import { InstructionsLoader, stripSections, parsePromptExclude } from '../../src/core/instructions'

describe('InstructionsLoader.buildSystemPrompt', () => {
  it('injects the commit-attribution instruction (AI 署名披露)', () => {
    const prompt = new InstructionsLoader().buildSystemPrompt()
    expect(prompt).toContain('Commit Attribution')
    expect(prompt).toContain('Co-Authored-By: Mipham <noreply@mipham.ai>')
  })
})

describe('stripSections (prompt-exclude)', () => {
  it('strips a section from its heading to the next same-level heading, keeping the rest', () => {
    const doc = `# Rules
- keep this
## Changelog
- drop this
## Architecture
- keep arch`
    const out = stripSections(doc, ['Changelog'])
    expect(out).toContain('keep this')
    expect(out).toContain('keep arch')
    expect(out).not.toContain('drop this')
  })

  it('strips subheadings along with an excluded ## section', () => {
    const doc = `## 下一步计划
### 修订历史
- version table
## Keep
- kept`
    const out = stripSections(doc, ['下一步计划'])
    expect(out).toContain('kept')
    expect(out).not.toContain('version table')
    expect(out).not.toContain('修订历史')
  })

  it('returns the document unchanged when excluded is empty', () => {
    const doc = '## A\n- x\n## B\n- y'
    expect(stripSections(doc, [])).toBe(doc)
  })
})

describe('parsePromptExclude', () => {
  it('normalizes a YAML list, a single string, and absent value', () => {
    expect(parsePromptExclude(['最近提交', '下一步计划'])).toEqual(['最近提交', '下一步计划'])
    expect(parsePromptExclude('修订历史')).toEqual(['修订历史'])
    expect(parsePromptExclude(undefined)).toEqual([])
  })
})
