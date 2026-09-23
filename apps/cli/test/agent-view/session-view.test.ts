/**
 * AgentSessionView —— 仪表盘上按 Enter（attach）之后落到的地方。
 *
 * 这个视图存在的理由只有一个：**Enter 得有个落点**。从前那条链断在
 * `app.tsx` 的 `onAttach={() => {}}` 上，六个键里广告得最响的那个按下去什么都
 * 不发生。它只读 —— 会话的活跑在它自己的 `SubAgent` 里，这个 CLI 没有回到那个
 * 循环的通道，收键盘就是骗人。
 */
import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render } from 'ink-testing-library'
import { AgentSessionView } from '../../src/agent-view/session-view'
import { AgentViewManager } from '../../src/agent-view/agent-view-manager'

const ESC = '\x1b'
const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function renderView(seed: (m: AgentViewManager) => string) {
  const manager = new AgentViewManager()
  const sessionId = seed(manager)
  const onDetach = vi.fn()
  const utils = render(React.createElement(AgentSessionView, { manager, sessionId, onDetach }))
  return { ...utils, manager, sessionId, onDetach }
}

describe('AgentSessionView', () => {
  it('把这条会话自己的消息显示出来（不是主对话的消息）', () => {
    const { lastFrame } = renderView((m) => {
      const s = m.create('Fix login', 'Fix the login redirect')
      m.addMessage(s.id, { role: 'user', content: 'start this task' })
      m.addMessage(s.id, { role: 'assistant', content: 'working on the redirect' })
      return s.id
    })

    const frame = lastFrame()
    expect(frame).toContain('start this task')
    expect(frame).toContain('working on the redirect')
    expect(frame).toContain('read-only transcript')
  })

  it('Esc 交还给仪表盘', async () => {
    const { stdin, onDetach } = renderView((m) => m.create('A', 'Task A').id)

    stdin.write(ESC)
    await settle()

    expect(onDetach).toHaveBeenCalledTimes(1)
  })

  it('会话还在跑的时候，新消息要跟着进来', async () => {
    const { manager, sessionId, lastFrame } = renderView((m) => m.create('A', 'Task A').id)

    expect(lastFrame()).not.toContain('finished while you watched')

    manager.addMessage(sessionId, { role: 'assistant', content: 'finished while you watched' })
    await settle()

    expect(lastFrame()).toContain('finished while you watched')
  })

  it('会话已经不在了（比如被别处删掉）就直说，而不是画一个空壳', () => {
    const manager = new AgentViewManager()
    const onDetach = vi.fn()
    const { lastFrame } = render(
      React.createElement(AgentSessionView, {
        manager,
        sessionId: 'agent-999-gone',
        onDetach,
      }),
    )

    expect(lastFrame()).toContain('no longer exists')
  })
})
