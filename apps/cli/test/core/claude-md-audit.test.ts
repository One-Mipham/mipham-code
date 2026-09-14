import { describe, it, expect } from 'vitest'
import { findDerivableSections } from '../../src/core/claude-md-audit'

describe('findDerivableSections', () => {
  it('flags headings describing content inferable from code', () => {
    const content = ['## 技术栈', '## Monorepo 结构', '## 最近提交', '## 项目一览'].join('\n')

    const result = findDerivableSections(content)
    expect(result.map((r) => r.heading)).toEqual([
      '技术栈',
      'Monorepo 结构',
      '最近提交',
      '项目一览',
    ])
    expect(result.map((r) => r.reason)).toEqual(['tech-stack', 'structure', 'commits', 'catalog'])
  })

  it('ignores headings that carry non-derivable intent', () => {
    const content = ['## 架构设计', '## 关键约束', '## 项目概述', '### 终极愿景'].join('\n')

    expect(findDerivableSections(content)).toEqual([])
  })

  it('matches ## and ### headings but not # or ####', () => {
    const content = ['# 技术栈', '#### 技术栈', '## 技术栈', '### 技术栈'].join('\n')

    expect(findDerivableSections(content).map((r) => r.heading)).toEqual(['技术栈', '技术栈'])
  })

  it('returns empty for content with no derivable headings', () => {
    expect(findDerivableSections('')).toEqual([])
  })

  it('does not flag workflow/deploy-chain headings (submodule workflow, deploy dependency chain)', () => {
    const content = ['## 十五、Git Submodule 工作流', '### 部署依赖链', '## 依赖注入'].join('\n')

    expect(findDerivableSections(content)).toEqual([])
  })

  it('skips a section already disclosed behind a .md pointer', () => {
    const content = [
      '## 最近提交',
      '',
      '| 2026-09-12 | `abc1234` | chore: bump |',
      '',
      '> 完整记录 → [docs/claude-md-history.md](docs/claude-md-history.md)',
    ].join('\n')

    expect(findDerivableSections(content)).toEqual([])
  })

  it('still flags an undisclosed section of the same title', () => {
    const content = [
      '## 修订历史',
      '',
      '| 2.0.0 | 2026-01-01 | 初版 |',
      '| 1.0.0 | 2025-01-01 | |',
    ].join('\n')

    expect(findDerivableSections(content).map((r) => r.heading)).toEqual(['修订历史'])
  })

  it('scopes the pointer guard per section — a link elsewhere does not suppress a match', () => {
    const content = [
      '## 最近提交',
      '| 2026-09-12 | `abc1234` | chore |',
      '',
      '## 技术栈',
      '> 见 [docs/tech-stack.md](docs/tech-stack.md)',
    ].join('\n')

    expect(findDerivableSections(content).map((r) => r.heading)).toEqual(['最近提交'])
  })
})
