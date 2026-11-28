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
  it('提供最新的 Claude 型号（Opus 5.5 / Fable 5.1 / Fable 5.2）', () => {
    const anthropic = DEFAULT_PROVIDERS.find((p) => p.id === 'anthropic')
    expect(anthropic).toBeDefined()

    const ids = anthropic!.models.map((m) => m.id)
    expect(ids).toContain('claude-opus-5-5')
    expect(ids).toContain('claude-fable-5-1')
    expect(ids).toContain('claude-fable-5-2')
  })
})

/**
 * DeepSeek 官方价页（2026-11-27 版）把正式模型名改为 `deepseek-flash`：
 * `deepseek-v4-flash` 是「仍可调用、但对应模型已下线、请求由 V4.1-Flash-1017
 * 服务并按 Flash 价计费」的旧名。目录若只留旧名，用户按官方文档写
 * `defaultModel: deepseek-flash` 就会落到「未知模型 ⇒ 128K 上下文」分支
 * （`index.tsx` 的 `MIPHAM_DISABLE_UNKNOWN_MODEL_WINDOW_ENFORCEMENT` 那条），
 * 从 1M 掉到 128K —— 这两条测试钉的就是这件事。
 */
describe('DeepSeek 模型目录', () => {
  const deepseek = DEFAULT_PROVIDERS.find((p) => p.id === 'deepseek')!

  it('正式名 deepseek-flash 在目录里，且带 1M 上下文', () => {
    const m = deepseek.models.find((x) => x.id === 'deepseek-flash')
    expect(m).toBeDefined()
    expect(m!.status).toBe('active')
    expect(m!.contextWindow).toBe(1_000_000)
    expect(m!.maxOutput).toBe(384_000)
  })

  it('旧名 deepseek-v4-flash 仍留在目录里（老配置照样解析得到窗口），但不进选择器', () => {
    const legacy = deepseek.models.find((x) => x.id === 'deepseek-v4-flash')
    expect(legacy).toBeDefined()
    expect(legacy!.status).toBe('deprecated')
    expect(legacy!.contextWindow).toBe(1_000_000)
  })

  it('默认模型指向正式名', async () => {
    const { DEFAULT_CONFIG } = await import('../../src/config/defaults')
    expect(DEFAULT_CONFIG.defaultModel).toBe('deepseek-flash')
  })
})
