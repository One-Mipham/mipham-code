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
})
