import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  extractCrsiLessonSummaries,
  buildCrsiLessonsBlock,
  buildCrsiLessonsPointer,
  isAlwaysOnLesson,
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
        severity: 'warning',
      },
      {
        title: 'simplicity: 未要求的功能是负债（违反简洁优先）',
        suggestion: '不添加未被真实用户要求的功能。',
        severity: 'critical',
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

  it('缺 严重度 时默认 critical —— fail-open 到常驻，不静默降级为按需', () => {
    const md = '## no-severity: 没写严重度\n\n- 建议: 照常召回。\n'
    expect(extractCrsiLessonSummaries(md)).toEqual([
      { title: 'no-severity: 没写严重度', suggestion: '照常召回。', severity: 'critical' },
    ])
  })

  it('未知 严重度 取值也按 critical 处理（闭集外的值不倒向按需）', () => {
    const md = '## weird: 严重度写错\n\n- 建议: 照常召回。\n- 严重度: blocker\n'
    expect(extractCrsiLessonSummaries(md)[0]!.severity).toBe('critical')
  })

  it('严重度 行写在 建议 之前也能读到（块级累积，不依赖行序）', () => {
    const md = '## pre: 顺序颠倒\n\n- 严重度: warning\n- 建议: 仍在一条里。\n'
    expect(extractCrsiLessonSummaries(md)).toEqual([
      { title: 'pre: 顺序颠倒', suggestion: '仍在一条里。', severity: 'warning' },
    ])
  })
})

describe('buildCrsiLessonsBlock', () => {
  it('returns an empty string for no lessons', () => {
    expect(buildCrsiLessonsBlock([])).toBe('')
  })

  it('renders a numbered recall block with title + suggestion', () => {
    const summaries: CrsiLessonSummary[] = [
      {
        title: 'simplicity: 未要求的功能是负债',
        suggestion: '不添加未被要求的功能。',
        severity: 'critical',
      },
    ]
    const block = buildCrsiLessonsBlock(summaries)
    expect(block).toContain('CRSI Lessons')
    expect(block).toContain('simplicity: 未要求的功能是负债')
    expect(block).toContain('不添加未被要求的功能。')
  })

  it('只渲染 critical —— warning 级不进常驻块', () => {
    const summaries: CrsiLessonSummary[] = [
      { title: 'c: 常驻', suggestion: '常驻建议。', severity: 'critical' },
      { title: 'w: 按需', suggestion: '按需建议。', severity: 'warning' },
    ]
    const block = buildCrsiLessonsBlock(summaries.filter(isAlwaysOnLesson))
    expect(block).toContain('c: 常驻')
    expect(block).not.toContain('w: 按需')
  })
})

describe('isAlwaysOnLesson', () => {
  it('critical 常驻、warning 不常驻', () => {
    expect(isAlwaysOnLesson({ title: 't', suggestion: 's', severity: 'critical' })).toBe(true)
    expect(isAlwaysOnLesson({ title: 't', suggestion: 's', severity: 'warning' })).toBe(false)
  })
})

describe('buildCrsiLessonsPointer', () => {
  const mixed: CrsiLessonSummary[] = [
    { title: 'c: 常驻', suggestion: '常驻建议。', severity: 'critical' },
    { title: 'w1: 按需', suggestion: '按需建议一。', severity: 'warning' },
    { title: 'w2: 按需', suggestion: '按需建议二。', severity: 'warning' },
  ]

  it('报出未常驻条数与文件路径，使模型有真实召回入口', () => {
    const pointer = buildCrsiLessonsPointer(mixed, '/repo/apps/cli/crsi-lessons.md')
    expect(pointer).toContain('2')
    expect(pointer).toContain('/repo/apps/cli/crsi-lessons.md')
  })

  it('没有 warning 时返回空串（不产生悬空指针）', () => {
    const onlyCritical = mixed.filter(isAlwaysOnLesson)
    expect(buildCrsiLessonsPointer(onlyCritical, '/repo/apps/cli/crsi-lessons.md')).toBe('')
  })

  it('没有 critical 时仍报指针 —— 否则 33 条 warning 会无声消失', () => {
    const onlyWarning = mixed.filter((s) => !isAlwaysOnLesson(s))
    const pointer = buildCrsiLessonsPointer(onlyWarning, '/repo/apps/cli/crsi-lessons.md')
    expect(pointer).toContain('2')
    expect(pointer).toContain('/repo/apps/cli/crsi-lessons.md')
  })

  it('无教训时返回空串', () => {
    expect(buildCrsiLessonsPointer([], '/repo/apps/cli/crsi-lessons.md')).toBe('')
  })
})

describe('InstructionsLoader CRSI lessons recall (integration)', () => {
  it('injects the CRSI Lessons block after loadAll reads crsi-lessons.md', () => {
    const loader = new InstructionsLoader()
    loader.loadAll(process.cwd())
    expect(loader.buildSystemPrompt()).toContain('CRSI Lessons')
  })
})

// 分档后的**注入面**：真文件进真装载器，验「常驻的是哪一份」。
// 每条都带负控（真文件里确实有该档教训），否则严重度解析坏掉时本组会整体空转报绿。
describe('InstructionsLoader 注入的是分档后的一份（真文件）', () => {
  const real = readFileSync(resolve(__dirname, '../../crsi-lessons.md'), 'utf-8')
  const all = extractCrsiLessonSummaries(real)
  const crit = all.filter(isAlwaysOnLesson)
  const warn = all.filter((s) => !isAlwaysOnLesson(s))

  const load = () => {
    const loader = new InstructionsLoader()
    loader.loadAll(process.cwd())
    return loader
  }

  it('负控：真文件里 critical 与 warning 两档都非空', () => {
    expect(crit.length).toBeGreaterThan(0)
    expect(warn.length).toBeGreaterThan(0)
  })

  it('critical 级正文进系统提示', () => {
    const prompt = load().buildSystemPrompt()
    for (const c of crit) expect(prompt).toContain(c.suggestion)
  })

  it('warning 级正文不进系统提示', () => {
    const prompt = load().buildSystemPrompt()
    for (const w of warn) expect(prompt).not.toContain(w.suggestion)
  })

  it('指针给出未常驻条数与文件路径 —— 否则 33 条被无声丢弃', () => {
    const prompt = load().buildSystemPrompt()
    expect(prompt).toContain(String(warn.length))
    expect(prompt).toContain('crsi-lessons.md')
  })

  it('sizeReport 报的字符数 == 实际注入的那一份（含指针），不是整个文件', () => {
    const loader = load()
    const entry = loader.sizeReport().files.find((f) => f.path.endsWith('crsi-lessons.md'))
    expect(entry).toBeDefined()
    const expected = [
      buildCrsiLessonsBlock(crit),
      buildCrsiLessonsPointer(all, entry!.path),
    ].filter(Boolean)
    expect(entry!.chars).toBe(expected.join('\n\n').length)
    // 正对照：全量那一份明显更大 —— 证明这里比的是「分档后」而不是「照旧全量」。
    expect(entry!.chars).toBeLessThan(buildCrsiLessonsBlock(all).length)
  })
})

// 真账本的**完整性**：抽取器会静默丢弃「有标题但 建议 行缺失/格式漂移」的块
// （见上方 'skips a lesson that has a heading but no 建议 line'）—— 而上面那条集成测试
// 只断言 block「存在」、不钉条数，报不出「某条没进去」。此处按「每个 ## 块都必须被抽出」
// 断言，**不钉条数**（钉了以后每加一条就红）。
describe('crsi-lessons.md 真文件完整性（不钉条数）', () => {
  const real = readFileSync(resolve(__dirname, '../../crsi-lessons.md'), 'utf-8')
  const blocks = real.split(/^## /m).slice(1)

  it('每个 ## 块都产出一条非空建议 —— 无一被静默丢弃', () => {
    const got = extractCrsiLessonSummaries(real)
    const orphans = blocks
      .map((b) => (b.split('\n')[0] ?? '').trim())
      .filter((t) => !got.some((s) => s.title === t))
    expect(orphans).toEqual([])
    expect(got).toHaveLength(blocks.length)
  })

  it('负对照：伪造标题在真账本里报未命中', () => {
    const titles = new Set(extractCrsiLessonSummaries(real).map((s) => s.title))
    expect(titles.has('不存在的轴: 这条标题是伪造的')).toBe(false)
  })
})
