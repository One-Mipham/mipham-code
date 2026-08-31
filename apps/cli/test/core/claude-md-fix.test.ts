import { describe, it, expect } from 'vitest'
import { applyPromptExclude } from '../../src/core/claude-md-fix'
import { parseFrontmatter, parsePromptExclude } from '../../src/core/instructions'

/** Extract the normalized prompt-exclude list from a document's frontmatter. */
function excluded(content: string): string[] {
  const { data } = parseFrontmatter(content)
  return parsePromptExclude(data['prompt-exclude'])
}

describe('applyPromptExclude', () => {
  it('creates frontmatter when none exists', () => {
    const body = '## 概述\n这是正文。\n'
    const { content, added } = applyPromptExclude(body, ['技术栈', '项目一览'])

    expect(added).toEqual(['技术栈', '项目一览'])
    expect(excluded(content)).toEqual(['技术栈', '项目一览'])
    // Body is preserved verbatim, only wrapped with new frontmatter.
    expect(parseFrontmatter(content).content).toBe(body)
  })

  it('merges with an existing list without duplicating', () => {
    const src = '---\nprompt-exclude:\n  - 技术栈\n---\n## 概述\n'
    const { content, added } = applyPromptExclude(src, ['技术栈', '项目一览'])

    expect(added).toEqual(['项目一览'])
    expect(excluded(content)).toEqual(['技术栈', '项目一览'])
  })

  it('returns content unchanged when nothing new to add', () => {
    const src = '---\nprompt-exclude:\n  - 技术栈\n---\n正文'
    const { content, added } = applyPromptExclude(src, ['技术栈'])

    expect(added).toEqual([])
    expect(content).toBe(src)
  })

  it('preserves other frontmatter fields', () => {
    const src = '---\nprivacy: private\n---\n正文'
    const { content } = applyPromptExclude(src, ['技术栈'])

    const { data } = parseFrontmatter(content)
    expect(data['privacy']).toBe('private')
    expect(excluded(content)).toEqual(['技术栈'])
  })

  it('upgrades a single-string prompt-exclude to a list', () => {
    const src = '---\nprompt-exclude: 技术栈\n---\n正文'
    const { content, added } = applyPromptExclude(src, ['项目一览'])

    expect(added).toEqual(['项目一览'])
    expect(excluded(content)).toEqual(['技术栈', '项目一览'])
  })

  it('deduplicates repeated input headings', () => {
    const body = '正文'
    const { content, added } = applyPromptExclude(body, ['技术栈', '技术栈'])

    expect(added).toEqual(['技术栈'])
    expect(excluded(content)).toEqual(['技术栈'])
  })
})
