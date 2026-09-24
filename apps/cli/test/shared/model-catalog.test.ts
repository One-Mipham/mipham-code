/**
 * 模型目录的**值正确性**测试（对标档 280 · 001）。
 *
 * 为什么它必须单独存在：`shared-vendor-parity.test.ts` 把 `constants.ts` 按
 * `byte` 档守卫 —— 它只能证明「两份副本一致」，**证明不了值是对的**。该文件头部
 * 已明写这条边界（「两份同时被改成同一个错值本文件不会变红，那种缺陷要靠读真源的
 * 正确性测试去抓」）。目录里少一个已发布的型号，正属于这类：两份副本会一起少，
 * 守卫照样全绿。
 *
 * 所以这里钉的是**「最新的 Claude 型号在不在目录里」**，与副本一致性无关。
 */

import { describe, it, expect } from 'vitest'

import { DEFAULT_PROVIDERS } from '../../src/shared/constants'

describe('Anthropic 模型目录', () => {
  it('提供最新的 Claude 型号（Opus 5.5 / Fable 5.1）', () => {
    const anthropic = DEFAULT_PROVIDERS.find((p) => p.id === 'anthropic')
    expect(anthropic).toBeDefined()

    const ids = anthropic!.models.map((m) => m.id)
    expect(ids).toContain('claude-opus-5-5')
    expect(ids).toContain('claude-fable-5-1')
  })
})
