import { describe, it, expect } from 'vitest'
import {
  extractCrsiLessonSummaries,
  buildCrsiLessonsBlock,
  type CrsiLessonSummary,
} from '../../src/core/crsi-producer'
import { InstructionsLoader } from '../../src/core/instructions'

const SAMPLE = `# CRSI Lessons

本文件由 CRSI producer 自动追加教训。

<!-- CRSI lessons are appended below this line. -->

## security-rule: 命令替换 $() 的 blanket 拦截是误伤

- 建议: 安全规则只拦「具体危险内容」，不拦「合法语法本身」。
- 严重度: warning
- 生成时间: 2026-08-24
- 来源: 会话复盘

### 证据

- \`bash.ts\` 的 \`/\$\(/\` blanket 拦了 \`echo $(pwd)\` 等合法命令

## simplicity: 未要求的功能是负债（违反简洁优先）

- 建议: 不添加未被真实用户要求的功能。
- 严重度: critical
- 生成时间: 2026-08-24
- 来源: 会话复盘

### 证据

- vim 模式无真实用户需求
`

describe('extractCrsiLessonSummaries', () => {
  it('extracts title + suggestion for each lesson, ignoring evidence bullets', () => {
    const out = extractCrsiLessonSummaries(SAMPLE)
    expect(out).toEqual([
      {
        title: 'security-rule: 命令替换 $() 的 blanket 拦截是误伤',
        suggestion: '安全规则只拦「具体危险内容」，不拦「合法语法本身」。',
      },
      {
        title: 'simplicity: 未要求的功能是负债（违反简洁优先）',
        suggestion: '不添加未被真实用户要求的功能。',
      },
    ])
  })

  it('returns [] for empty content', () => {
    expect(extractCrsiLessonSummaries('')).toEqual([])
  })

  it('skips a lesson that has a heading but no 建议 line', () => {
    const md = '## orphan: 没有建议\n\n- 严重度: warning\n'
    expect(extractCrsiLessonSummaries(md)).toEqual([])
  })
})

describe('buildCrsiLessonsBlock', () => {
  it('returns an empty string for no lessons', () => {
    expect(buildCrsiLessonsBlock([])).toBe('')
  })

  it('renders a numbered recall block with title + suggestion', () => {
    const summaries: CrsiLessonSummary[] = [
      { title: 'simplicity: 未要求的功能是负债', suggestion: '不添加未被要求的功能。' },
    ]
    const block = buildCrsiLessonsBlock(summaries)
    expect(block).toContain('CRSI Lessons')
    expect(block).toContain('simplicity: 未要求的功能是负债')
    expect(block).toContain('不添加未被要求的功能。')
  })
})

describe('InstructionsLoader CRSI lessons recall (integration)', () => {
  it('injects the CRSI Lessons block after loadAll reads crsi-lessons.md', () => {
    const loader = new InstructionsLoader()
    loader.loadAll(process.cwd())
    expect(loader.buildSystemPrompt()).toContain('CRSI Lessons')
  })
})
