/**
 * `mipham agents` 独立面板的 Enter 落点。
 *
 * 缺陷形状（对标档 280 · 附带发现）：`index.tsx` 给 AgentViewDashboard 传的是
 * `onAttach={() => {}}`，而页脚**无条件**广告「Enter attach」⇒ 按键有反应、世界不变
 * —— 比「这个键不存在」更坏。`app.tsx` 那条路早已修好（把会话交给只读视图），
 * 独立面板这条路被落在后面。
 *
 * 断言落在**屏幕上换了什么**：Enter 之后必须出现只读会话视图，Esc 之后必须回到列表。
 * 只断「页脚印着 Enter attach」是假绿 —— 页脚从来就印着它（id 也印在列表里，同理不可作判据）。
 */

import React from 'react'
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render } from 'ink-testing-library'

import { AgentsStandalone } from '../../src/agent-view/agents-standalone'
import { AgentViewManager } from '../../src/agent-view/agent-view-manager'

const ENTER = '\r'
const ESC = '\x1b'

/** ink-testing-library 无 act 包装，交还事件循环让 setState / effect 落定。 */
const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 只读会话视图独有的一句（列表页脚永远不印它）。 */
const SESSION_VIEW_MARKER = 'read-only transcript'

afterEach(() => {
  vi.restoreAllMocks()
})

describe('独立 agents 面板的 Enter 落点', () => {
  it('Enter 进入只读会话视图，Esc 回到列表', async () => {
    const manager = new AgentViewManager()
    manager.create('A', 'Task A')
    const onExit = vi.fn()

    const { stdin, lastFrame } = render(React.createElement(AgentsStandalone, { manager, onExit }))

    // 前置：起手停在列表（不是「一上来就是会话视图」而让断言恰好成立）
    expect(lastFrame()).not.toContain(SESSION_VIEW_MARKER)

    stdin.write(ENTER)
    await settle()

    expect(lastFrame()).toContain(SESSION_VIEW_MARKER)

    stdin.write(ESC)
    await settle()

    expect(lastFrame()).not.toContain(SESSION_VIEW_MARKER)
  })
})
