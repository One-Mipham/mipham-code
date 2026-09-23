/**
 * Agent View 页脚广告的六个键 —— 逐键测「按下去屏幕上留下什么」。
 *
 * 修之前这六个键里有三个是**装饰**：Enter 的两个分支写的是同一句话、且落点
 * 是 `onAttach={() => {}}`（按键有反应、世界不变）；Ctrl+R 不弹输入框，直接盖
 * 一个 `session-<时间戳>` 上去（广告说 rename，行为是「重新命名成随机名」）；
 * Ctrl+X 只从列表里删行，从不碰那个真的在跑的后台任务（句柄一丢，agent 继续
 * 烧 token 且再也够不着）。
 *
 * 每条断言都要求：**改回去就得红**。所以断言落在「世界变了什么」上 ——
 * manager 里的状态、registry 里的 abort 信号、onAttach 收到的对象 —— 而不是
 * 落在「页脚印着这几个字」上（页脚从来就印着它们）。
 */
import React from 'react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { render } from 'ink-testing-library'
import { AgentViewDashboard } from '../../src/agent-view/dashboard'
import { AgentViewManager } from '../../src/agent-view/agent-view-manager'
import { getBackgroundAgentRegistry } from '../../src/agent/background-registry'

const CTRL_T = '\x14'
const CTRL_R = '\x12'
const CTRL_X = '\x18'
const ENTER = '\r'
const ESC = '\x1b'
const SPACE = ' '

/** ink-testing-library 无 act 包装，交还事件循环让 setState / effect 落定。 */
const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function renderDashboard(
  seed: (m: AgentViewManager) => void = () => {},
  onAttach = vi.fn(),
): {
  manager: AgentViewManager
  onAttach: ReturnType<typeof vi.fn>
  onExit: ReturnType<typeof vi.fn>
  stdin: { write: (s: string) => void }
  lastFrame: () => string | undefined
} {
  const manager = new AgentViewManager()
  seed(manager)
  const onExit = vi.fn()
  const utils = render(React.createElement(AgentViewDashboard, { manager, onAttach, onExit }))
  return { manager, onAttach, onExit, stdin: utils.stdin, lastFrame: utils.lastFrame }
}

afterEach(() => {
  vi.restoreAllMocks()
})

// ═══════════════════════════════════════════
// j / k —— 导航
// ═══════════════════════════════════════════

describe('j / k 移动选择', () => {
  it('j 把选择往下移一格（用 Space 打开谁的 peek 来观测）', async () => {
    const ids: string[] = []
    const { stdin, lastFrame } = renderDashboard((m) => {
      ids.push(m.create('A', 'Task A').id)
      ids.push(m.create('B', 'Task B').id)
      ids.push(m.create('C', 'Task C').id)
    })

    stdin.write('j')
    await settle()
    stdin.write(SPACE)
    await settle()

    // 面板标题栏写着被 peek 的是哪一个 —— 这就是「选择在哪」的可观测量
    expect(lastFrame()).toContain(`Peek: ${ids[1]}`)
    expect(lastFrame()).not.toContain(`Peek: ${ids[0]}`)
  })

  it('k 从第一格往上走是夹住的，不会绕到末尾', async () => {
    const ids: string[] = []
    const { stdin, lastFrame } = renderDashboard((m) => {
      ids.push(m.create('A', 'Task A').id)
      ids.push(m.create('B', 'Task B').id)
    })

    stdin.write('k')
    await settle()
    stdin.write(SPACE)
    await settle()

    expect(lastFrame()).toContain(`Peek: ${ids[0]}`)
  })

  it('j 到底也是夹住的（不绕回第一格）', async () => {
    const ids: string[] = []
    const { stdin, lastFrame } = renderDashboard((m) => {
      ids.push(m.create('A', 'Task A').id)
      ids.push(m.create('B', 'Task B').id)
    })

    stdin.write('j')
    await settle()
    stdin.write('j')
    await settle()
    stdin.write('j')
    await settle()
    stdin.write(SPACE)
    await settle()

    expect(lastFrame()).toContain(`Peek: ${ids[1]}`)
  })
})

// ═══════════════════════════════════════════
// Space —— peek 开/关
// ═══════════════════════════════════════════

describe('Space 开关 peek', () => {
  it('按一次打开、再按一次关掉', async () => {
    const { stdin, lastFrame } = renderDashboard((m) => m.create('A', 'Task A'))

    expect(lastFrame()).not.toContain('Peek:')
    stdin.write(SPACE)
    await settle()
    expect(lastFrame()).toContain('Peek:')

    stdin.write(SPACE)
    await settle()
    expect(lastFrame()).not.toContain('Peek:')
  })

  it('没有会话时给提示而不是凭空打开一个空面板', async () => {
    const { stdin, lastFrame } = renderDashboard()

    stdin.write(SPACE)
    await settle()

    expect(lastFrame()).not.toContain('Peek:')
    expect(lastFrame()).toContain('No sessions to peek')
  })
})

// ═══════════════════════════════════════════
// Enter —— attach
// ═══════════════════════════════════════════

describe('Enter 把手上的会话交出去（attach）', () => {
  it('把选中会话交给 onAttach，并把它的状态推进到 working', async () => {
    const ids: string[] = []
    const { stdin, manager, onAttach } = renderDashboard((m) => {
      ids.push(m.create('A', 'Task A').id)
      ids.push(m.create('B', 'Task B').id)
    })

    stdin.write('j')
    await settle()
    stdin.write(ENTER)
    await settle()

    expect(onAttach).toHaveBeenCalledTimes(1)
    const attached = onAttach.mock.calls[0]![0] as { id: string }
    expect(attached.id).toBe(ids[1])
    // attach 的语义（见 manager 注释）：needs-input → working
    expect(manager.get(ids[1]!)!.status).toBe('working')
  })

  it('没有会话时不调用 onAttach，只给提示', async () => {
    const { stdin, onAttach, lastFrame } = renderDashboard()

    stdin.write(ENTER)
    await settle()

    expect(onAttach).not.toHaveBeenCalled()
    expect(lastFrame()).toContain('No sessions to attach')
  })
})

// ═══════════════════════════════════════════
// Ctrl+T —— 分组
// ═══════════════════════════════════════════

describe('Ctrl+T 换分组口径', () => {
  it('从状态分组切成目录分组（表头变成目录路径）', async () => {
    const { stdin, lastFrame } = renderDashboard((m) => {
      m.create('A', 'Task A', { directory: '/repo/alpha' })
      m.create('B', 'Task B', { directory: '/repo/beta' })
    })

    expect(lastFrame()).toContain('Needs Input (2)')
    expect(lastFrame()).not.toContain('/repo/alpha')

    stdin.write(CTRL_T)
    await settle()

    expect(lastFrame()).toContain('/repo/alpha')
    expect(lastFrame()).toContain('/repo/beta')
    expect(lastFrame()).toContain('Grouped by directory')
  })
})

// ═══════════════════════════════════════════
// Ctrl+R —— 改名（要真的有个输入框）
// ═══════════════════════════════════════════

describe('Ctrl+R 改名', () => {
  it('打开输入框（用当前名字预填），回车写入输入的那串', async () => {
    const ids: string[] = []
    const { stdin, manager, lastFrame } = renderDashboard((m) => {
      ids.push(m.create('A', 'Task A').id)
    })

    stdin.write(CTRL_R)
    await settle()
    expect(lastFrame()).toContain('Rename session')

    stdin.write('X')
    await settle()
    stdin.write(ENTER)
    await settle()

    // 预填 + 输入：'A' + 'X'，而不是旧行为那种 session-<时间戳>
    expect(manager.get(ids[0]!)!.title).toBe('AX')
    expect(lastFrame()).not.toContain('Rename session')
  })

  it('Esc 取消改名，标题不变，且列表键交还回来', async () => {
    const ids: string[] = []
    const { stdin, manager, lastFrame } = renderDashboard((m) => {
      ids.push(m.create('A', 'Task A').id)
      ids.push(m.create('B', 'Task B').id)
    })

    stdin.write(CTRL_R)
    await settle()
    stdin.write('X')
    await settle()
    stdin.write(ESC)
    await settle()

    expect(manager.get(ids[0]!)!.title).toBe('A')
    expect(lastFrame()).not.toContain('Rename session')

    // 框关掉之后 j 立刻恢复导航 —— 否则「输入框吃掉键盘」会一直吃下去
    stdin.write('j')
    await settle()
    stdin.write(SPACE)
    await settle()
    expect(lastFrame()).toContain(`Peek: ${ids[1]}`)
  })

  it('空标题不改名（拒绝，而不是把标题写成空串）', async () => {
    const ids: string[] = []
    const { stdin, manager, lastFrame } = renderDashboard((m) => {
      ids.push(m.create('A', 'Task A').id)
    })

    stdin.write(CTRL_R)
    await settle()
    // 退格清空预填的名字再回车
    for (let i = 0; i < 'A'.length; i++) stdin.write('\x7f')
    await settle()
    stdin.write(ENTER)
    await settle()

    expect(manager.get(ids[0]!)!.title).toBe('A')
    expect(lastFrame()).toContain('Rename cancelled')
  })
})

// ═══════════════════════════════════════════
// Ctrl+X —— 移除（运行中的要先停）
// ═══════════════════════════════════════════

describe('Ctrl+X 移除', () => {
  it('把选中的行从列表里去掉', async () => {
    const ids: string[] = []
    const { stdin, manager, lastFrame } = renderDashboard((m) => {
      ids.push(m.create('A', 'Task A').id)
      ids.push(m.create('B', 'Task B').id)
    })

    stdin.write(CTRL_X)
    await settle()

    expect(manager.get(ids[0]!)).toBeUndefined()
    expect(manager.list().map((s) => s.id)).toEqual([ids[1]])
    expect(lastFrame()).toContain('Removed A')
  })

  it('运行中的会话：先真的停掉后台任务，再删行', async () => {
    const registry = getBackgroundAgentRegistry()
    let aborted = false
    const taskId = registry.spawn(
      'long task',
      'general',
      async (signal) => {
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve()
          else signal.addEventListener('abort', () => resolve())
        })
        aborted = true
        return 'finished anyway'
      },
      'unattended',
    )

    const { stdin, manager, lastFrame } = renderDashboard((m) => {
      m.create('Long', 'Long task').taskId = taskId
    })

    stdin.write(CTRL_X)
    await settle()

    // 真信号：这个任务确实被中止了（不是只把行标成 failed）
    expect(registry.get(taskId)!.abortController.signal.aborted).toBe(true)
    expect(aborted).toBe(true)
    expect(manager.list()).toHaveLength(0)
    expect(lastFrame()).toContain('Stopped + removed Long')
  })

  it('（对照）没有 taskId 的会话不去碰 registry', async () => {
    const registry = getBackgroundAgentRegistry()
    const stop = vi.spyOn(registry, 'stop')

    const { stdin, manager } = renderDashboard((m) => m.create('Plain', 'No task id'))
    stdin.write(CTRL_X)
    await settle()

    expect(stop).not.toHaveBeenCalled()
    expect(manager.list()).toHaveLength(0)
  })
})

// ═══════════════════════════════════════════
// 刷新 —— 面板开着的时候，别人改状态要出现在屏幕上
// ═══════════════════════════════════════════

describe('面板跟着会话动（不是挂载那一刻的快照）', () => {
  it('执行器在面板开着时把会话跑完，表头计数要跟着变', async () => {
    const ids: string[] = []
    const { manager, lastFrame } = renderDashboard((m) => {
      ids.push(m.create('A', 'Task A').id)
      m.updateStatus(ids[0]!, 'working')
    })

    expect(lastFrame()).toContain('1 working')
    expect(lastFrame()).toContain('0 done')

    // 这就是 `/bg` 的执行器做的事：面板还开着，它在另一个微任务里收尾
    manager.addMessage(ids[0]!, { role: 'assistant', content: 'done!' })
    manager.updateStatus(ids[0]!, 'completed')
    await settle()

    expect(lastFrame()).toContain('0 working')
    expect(lastFrame()).toContain('1 done')
  })

  it('peek 开着时新到的那条消息要进面板', async () => {
    const ids: string[] = []
    const { stdin, manager, lastFrame } = renderDashboard((m) => {
      ids.push(m.create('A', 'Task A').id)
    })

    stdin.write(SPACE)
    await settle()
    expect(lastFrame()).not.toContain('arrived later')

    manager.addMessage(ids[0]!, { role: 'assistant', content: 'arrived later' })
    await settle()

    expect(lastFrame()).toContain('arrived later')
  })
})

// ═══════════════════════════════════════════
// 接线层 —— Enter 的落点在 app.tsx 里必须不是空壳
// ═══════════════════════════════════════════

describe('接线层：主界面的 onAttach', () => {
  const appSrc = readFileSync('src/ui/app.tsx', 'utf8')

  it('扫的确实是那份 app.tsx（正对照）', () => {
    expect(appSrc).toContain('AgentViewDashboard')
    expect(appSrc).toContain('onExit={() => setAgentViewOpen(false)}')
  })

  it('不再把 onAttach 接成空函数，而是接上一个会落地的视图', () => {
    expect(appSrc).not.toContain('onAttach={() => {}}')
    expect(appSrc).toContain('setAttachedSessionId(session.id)')
    expect(appSrc).toContain('<AgentSessionView')
  })
})
