import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendSignals,
  readSignals,
  pendingLessonsMarkdown,
  refreshPendingLessons,
  findLessonsFile,
  readPendingLessons,
  pendingToInsights,
  insightsToSignals,
  splitLessonBlocks,
  MAX_PENDING_LESSONS,
} from '../../src/core/crsi-inbox'
import type { CrsiSignal } from '../../src/core/crsi-producer'

function signal(category: string, title: string, severity = 'warning'): CrsiSignal {
  return { category, title, severity, suggestion: `fix ${title}`, evidence: [`evidence: ${title}`] }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crsi-inbox-'))
})

const inbox = () => join(dir, 'signal-inbox.jsonl')
const pending = () => join(dir, 'pending-lessons.md')

describe('appendSignals —— 自动采集且幂等', () => {
  it('按 category|title 去重，返回本次新增条数', () => {
    expect(appendSignals([signal('timeout', 'A'), signal('tool-params', 'B')], inbox())).toBe(2)

    // 同一信号再来一次不重复；新信号照收。
    expect(appendSignals([signal('timeout', 'A'), signal('search', 'C')], inbox())).toBe(1)
    expect(readSignals(inbox()).map((s) => s.title)).toEqual(['A', 'B', 'C'])
  })

  it('文件权限 0600 —— 信号里带工具错误原文', () => {
    appendSignals([signal('timeout', 'A')], inbox())
    expect(statSync(inbox()).mode & 0o777).toBe(0o600)
  })

  it('读侧跳过坏行，不让一行损坏拖垮整个收件箱', () => {
    appendSignals([signal('timeout', 'A')], inbox())
    writeFileSync(inbox(), `not json\n${readFileSync(inbox(), 'utf-8')}`, { mode: 0o600 })
    expect(readSignals(inbox()).map((s) => s.title)).toEqual(['A'])
  })

  it('收件箱不存在时读回空数组', () => {
    expect(readSignals(join(dir, 'nope.jsonl'))).toEqual([])
  })
})

describe('pendingLessonsMarkdown —— 派生视图', () => {
  it('已并入 lessons 的教训不再出现，其余按入箱顺序渲染', () => {
    const md = pendingLessonsMarkdown(
      [signal('timeout', 'A'), signal('search', 'B')],
      '## timeout: A\n\n- 建议: 已并入\n',
      '2026-11-26T00:00:00.000Z',
    )
    expect(md).not.toContain('## timeout: A')
    expect(md).toContain('## search: B')
    expect(md).toContain('- 建议: fix B')
    expect(md).toContain('CRSI inbox (auto-collected)')
  })

  it('同一标题重复出现只渲染一次', () => {
    const md = pendingLessonsMarkdown(
      [signal('timeout', 'A'), signal('timeout', 'A')],
      '',
      '2026-11-26T00:00:00.000Z',
    )
    expect(md.match(/## timeout: A/g)).toHaveLength(1)
  })

  it(`单次最多 ${MAX_PENDING_LESSONS} 条`, () => {
    const many = Array.from({ length: MAX_PENDING_LESSONS + 3 }, (_, i) =>
      signal('timeout', `T${i}`),
    )
    const md = pendingLessonsMarkdown(many, '', '2026-11-26T00:00:00.000Z')
    expect(md.match(/^## /gm)).toHaveLength(MAX_PENDING_LESSONS)
  })

  it('没有新信号时产出空串（不是一段空壳 markdown）', () => {
    expect(pendingLessonsMarkdown([], '', '2026-11-26T00:00:00.000Z')).toBe('')
  })
})

describe('refreshPendingLessons —— 启动时自动生成，无需人操作', () => {
  function makeRepo(withLessons: string): string {
    const root = join(dir, 'repo')
    mkdirSync(join(root, 'apps', 'cli'), { recursive: true })
    writeFileSync(join(root, 'apps', 'cli', 'crsi-lessons.md'), withLessons)
    return root
  }

  it('把收件箱渲染成 pending 文件；并入后再跑会收缩', () => {
    const root = makeRepo('# Lessons\n')
    appendSignals([signal('timeout', 'A'), signal('search', 'B')], inbox())

    const first = refreshPendingLessons(root, {
      inboxPath: inbox(),
      pendingPath: pending(),
      timestamp: '2026-11-26T00:00:00.000Z',
    })
    expect(first.total).toBe(2)
    expect(readPendingLessons(pending())).toContain('## timeout: A')

    // 人批准合并了 A：下一次启动重新派生，只剩 B。
    writeFileSync(
      join(root, 'apps', 'cli', 'crsi-lessons.md'),
      '# Lessons\n\n## timeout: A\n\n- 建议: 已并入\n',
    )
    const second = refreshPendingLessons(root, {
      inboxPath: inbox(),
      pendingPath: pending(),
      timestamp: '2026-11-26T00:00:00.000Z',
    })
    expect(second.total).toBe(1)
    expect(readPendingLessons(pending())).not.toContain('## timeout: A')
    expect(readPendingLessons(pending())).toContain('## search: B')
  })

  // P2 的安全不变量：自动化的是**产出**，不是**合并**。刷新只读 lessons 文件做去重，
  // 任何自动路径都不许改它 —— 合并必须经过沙箱 + 人类批准。
  it('refresh 不碰 crsi-lessons.md（产出 ≠ 合并）', () => {
    const original = '# Lessons\n\n## 已有: 老教训\n'
    const root = makeRepo(original)
    appendSignals([signal('timeout', 'A')], inbox())
    refreshPendingLessons(root, { inboxPath: inbox(), pendingPath: pending() })

    expect(readFileSync(join(root, 'apps', 'cli', 'crsi-lessons.md'), 'utf-8')).toBe(original)
  })

  it('不在 mipham-code 仓库里（无 lessons 文件）⇒ 零产出，不写垃圾', () => {
    const result = refreshPendingLessons(dir, {
      inboxPath: inbox(),
      pendingPath: pending(),
    })
    expect(result.total).toBe(0)
    expect(existsSync(pending())).toBe(false)
  })

  it('findLessonsFile 从子目录向上找到仓库根', () => {
    const root = makeRepo('# Lessons\n')
    expect(findLessonsFile(join(root, 'apps', 'cli'))).toBe(
      join(root, 'apps', 'cli', 'crsi-lessons.md'),
    )
  })
})

describe('insightsToSignals / splitLessonBlocks', () => {
  it('insight 落盘为信号时保留 建议/证据/档位', () => {
    const signals = insightsToSignals([
      {
        category: 'timeout',
        description: 'Bash 失败: timeout',
        severity: 'critical',
        suggestion: '加 timeout',
        evidence: ['e1'],
        autoApplicable: true,
      },
    ])
    expect(signals).toEqual([
      {
        category: 'timeout',
        title: 'Bash 失败: timeout',
        severity: 'critical',
        suggestion: '加 timeout',
        evidence: ['e1'],
      },
    ])
  })

  it('splitLessonBlocks 按顶层 `## ` 切块，前言不混进教训', () => {
    const blocks = splitLessonBlocks('preamble\n\n## a: A\n\n- 建议: x\n\n## b: B\n\n- 建议: y\n')
    expect(blocks).toHaveLength(2)
    expect(blocks[0]!.trimEnd()).toBe('## a: A\n\n- 建议: x')
    expect(blocks[1]!.trimEnd()).toBe('## b: B\n\n- 建议: y')
  })
})

describe('pendingToInsights', () => {
  it('收件箱信号可按 insight 形状喂回 /crsi propose（重启后仍能学习）', () => {
    const insights = pendingToInsights([signal('timeout', 'A', 'critical')])
    expect(insights).toEqual([
      {
        category: 'timeout',
        description: 'A',
        severity: 'critical',
        suggestion: 'fix A',
        evidence: ['evidence: A'],
        autoApplicable: true,
      },
    ])
  })
})
