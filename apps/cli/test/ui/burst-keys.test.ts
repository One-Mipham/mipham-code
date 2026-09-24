/**
 * 一次刷进来的按键（burst）必须作用在**它自己算出来的**那一行上。
 *
 * 远端/远程控制等场景下，一组按键会在同一个 chunk 里到达（Ink 的输入解析器把
 * 转义序列打头的 chunk 切开逐个派发），于是「↓ 然后 Enter」会在 React 提交第一次
 * 状态之前就跑到第二个回调里 —— 回调闭包里的 index 还是**按下 ↓ 之前**那个。
 * 表现是「按了 Enter，切到的是上一个 provider / 上一行命令」：按键有反应，世界
 * 却是上一拍的。
 *
 * 判据一律落在「世界变了什么」上 —— `onSelect` 收到的实参、模型列表面板实际
 * 渲染出谁 —— 而不是落在「光标画在哪」上（那是渲染，渲染本来就是对的）。
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { Box, Text, useInput } from 'ink'
import { render } from 'ink-testing-library'
import { ModelPicker } from '../../src/ui/picker'
import { CommandPicker } from '../../src/ui/command-picker'
import { ConfigWizard } from '../../src/ui/config-wizard'
import { getCommandList } from '../../src/ui/commands'
import { DEFAULT_PROVIDERS } from '../../src/shared/constants'
import { DEFAULT_CONFIG } from '../../src/config/defaults'
import { getActiveModels } from '../../src/config/wizard-config'
import type { MiphamConfig, ProviderConfig } from '../../src/shared/types'

const DOWN = '\x1b[B'
const ENTER = '\r'

/** ink-testing-library 无 act 包装，交还事件循环让 setState / effect 落定。 */
const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// ═══════════════════════════════════════════
// 前提：一次写入确实会派发成多个按键事件
// ═══════════════════════════════════════════

function KeyProbe({ onKey }: { onKey: (kind: string) => void }): React.ReactElement {
  useInput((_input, key) => {
    if (key.downArrow) onKey('down')
    else if (key.return) onKey('enter')
  })
  return React.createElement(Box, null, React.createElement(Text, null, 'probe'))
}

describe('前提：burst 会被拆成多次按键回调', () => {
  it('一次写入「↓ Enter」派发两个事件', async () => {
    const seen: string[] = []
    const { stdin } = render(React.createElement(KeyProbe, { onKey: (k) => seen.push(k) }))
    stdin.write(DOWN + ENTER)
    await settle()
    expect(seen).toEqual(['down', 'enter'])
  })

  it('一次写入「↓ ↓ Enter」派发三个事件', async () => {
    const seen: string[] = []
    const { stdin } = render(React.createElement(KeyProbe, { onKey: (k) => seen.push(k) }))
    stdin.write(DOWN + DOWN + ENTER)
    await settle()
    expect(seen).toEqual(['down', 'down', 'enter'])
  })
})

// ═══════════════════════════════════════════
// 模型选择器
// ═══════════════════════════════════════════

describe('模型选择器（Ctrl+P）', () => {
  const providers: ProviderConfig[] = DEFAULT_PROVIDERS.filter(
    (p) => p.id === 'google' || p.id === 'deepseek',
  ).map((p) => ({ ...p, apiKey: 'sk-test' }))
  const config: MiphamConfig = { ...DEFAULT_CONFIG, providers }

  function renderPicker(onSelect = vi.fn()) {
    const utils = render(
      React.createElement(ModelPicker, {
        config,
        currentProvider: 'google',
        currentModel: 'gemini-3.0-flash',
        onSelect,
        onClose: vi.fn(),
      }),
    )
    return { onSelect, ...utils }
  }

  it('provider 面板上「↓ Enter」切到的是光标停下的那个 provider', async () => {
    const { onSelect, stdin } = renderPicker()

    stdin.write(DOWN + ENTER) // 一次写入：↓ 之后立刻 Enter
    await settle()
    stdin.write(ENTER) // 第二级：确认模型
    await settle()

    expect(onSelect).toHaveBeenCalledWith('deepseek', 'deepseek-v4-flash')
  })

  it('model 面板上「↓ Enter」选中的是光标停下的那个模型', async () => {
    const { onSelect, stdin } = renderPicker()

    stdin.write(ENTER) // provider → model 面板
    await settle()
    stdin.write(DOWN + ENTER)
    await settle()

    expect(onSelect).toHaveBeenCalledWith('google', 'gemini-3.0-pro')
  })

  it('model 面板上「↓ ↓ Enter」走两步，不是把两次 ↓ 都算在同一个起点上', async () => {
    const { onSelect, stdin } = renderPicker()

    stdin.write(ENTER)
    await settle()
    stdin.write(DOWN + DOWN + ENTER)
    await settle()

    expect(onSelect).toHaveBeenCalledWith('google', 'gemini-2.5-pro')
  })
})

// ═══════════════════════════════════════════
// 命令选择器（/skills 那一类行列表）
// ═══════════════════════════════════════════

describe('命令选择器（/ 唤起的行列表）', () => {
  it('「↓ Enter」选中的是光标停下的那一行', async () => {
    const all = getCommandList()
    const onSelect = vi.fn()
    const { stdin } = render(
      React.createElement(CommandPicker, { initialFilter: '/', onSelect, onClose: vi.fn() }),
    )

    stdin.write(DOWN + ENTER)
    await settle()

    expect(onSelect).toHaveBeenCalledWith(all[1]!.name)
    expect(onSelect).not.toHaveBeenCalledWith(all[0]!.name)
  })
})

// ═══════════════════════════════════════════
// 首装向导
// ═══════════════════════════════════════════

describe('首装向导', () => {
  it('provider 步「↓ Enter」进的是光标停下的那个 provider 的模型列表', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(ConfigWizard, { onComplete: vi.fn(), onSkip: vi.fn() }),
    )

    stdin.write(ENTER) // welcome → mode
    await settle()
    stdin.write(ENTER) // mode（cloud）→ provider
    await settle()
    stdin.write(DOWN + ENTER)
    await settle()

    const frame = lastFrame() ?? ''
    expect(frame).toContain(getActiveModels('deepseek')[0]!.id)
    expect(frame).not.toContain(getActiveModels('anthropic')[0]!.id)
  })
})
