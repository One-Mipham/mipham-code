import React, { useState } from 'react'
import { render } from 'ink-testing-library'
import { Text } from 'ink'
import { describe, expect, it } from 'vitest'
import { InputBar } from '../../src/ui/input'

/**
 * 上下键历史导航的**接线层**测试（ROADMAP D7）。
 *
 * 为什么需要这一层：`navigateHistory` 是纯函数、且 `test/ui/input-edit.test.ts`
 * 已经把它逐条钉住 —— 但 D7 记的正是「纯函数已正确、问题在接线层」。
 * 纯函数绿**不能**推出功能可用：历史数组活在哪个组件里、那个组件会不会被卸载，
 * 纯函数一无所知。此前 `test/ui/` 17 个文件里**没有一条**渲染 `InputBar`。
 *
 * ink 的按键走的是 raw 序列 —— 与真终端同一条路径（不是直接调 handler）。
 *
 * `Harness` **刻意持有 history state** —— 它复刻 app.tsx 的形状：
 * `app.tsx:1279` 的 `pickerOpen ? <ModelPicker/> : <Box>…<InputBar/>…</Box>`
 * 三元两支组件类型不同 ⇒ React 卸载 InputBar 而非复用；同形的还有
 * `:1159` 的 `if (apiKeyPrompt)` 整棵早退与 `:1226` 的 Ctrl+G。
 * 历史由**上层**持有，正是这三条路径下系统仍能工作的充要条件。
 */
const UP = '\u001B[A'
const DOWN = '\u001B[B'
const ENTER = '\r'

/** ink-testing-library 无 act 包装，交还事件循环让 setState / effect 落定。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 30))

const noop = (): void => {}

function Harness({
  pickerOpen,
  onSubmit = noop,
}: {
  pickerOpen: boolean
  onSubmit?: (v: string) => void
}) {
  const [history, setHistory] = useState<string[]>([])
  return pickerOpen
    ? React.createElement(Text, null, 'PICKER')
    : React.createElement(InputBar, {
        onSubmit,
        isLoading: false,
        history,
        onHistoryAppend: (v: string) => setHistory((prev) => [...prev, v]),
      })
}

function renderBar(onSubmit: (v: string) => void = noop) {
  return render(React.createElement(Harness, { pickerOpen: false, onSubmit }))
}

describe('InputBar 上下键历史导航 —— 接线层（D7）', () => {
  it('提交一条后按 ↑ 能调回它', async () => {
    const { stdin, lastFrame } = renderBar()
    stdin.write('hello')
    await settle()
    stdin.write(ENTER)
    await settle()
    expect(lastFrame()).not.toContain('hello') // 提交后输入行已清空

    stdin.write(UP)
    await settle()
    expect(lastFrame()).toContain('hello')
  })

  it('↑ 之后按 ↓ 回到空草稿（不留在历史里）', async () => {
    const { stdin, lastFrame } = renderBar()
    stdin.write('hello')
    await settle()
    stdin.write(ENTER)
    await settle()
    stdin.write(UP)
    await settle()
    stdin.write(DOWN)
    await settle()
    expect(lastFrame()).not.toContain('hello')
  })

  it('无历史时按 ↑ 是无操作（不崩、不写进输入行）', async () => {
    const { stdin, lastFrame } = renderBar()
    stdin.write(UP)
    await settle()
    expect(lastFrame()).not.toContain(UP)
  })
})

describe('InputBar 历史与卸载 —— 接线层（D7 的真缺口）', () => {
  it('开/关一次浮层后，↑ 仍应调回刚才提交的那条', async () => {
    const { stdin, lastFrame, rerender } = render(
      React.createElement(Harness, { pickerOpen: false }),
    )
    stdin.write('hello')
    await settle()
    stdin.write(ENTER)
    await settle()

    rerender(React.createElement(Harness, { pickerOpen: true })) // InputBar 被卸载
    await settle()
    rerender(React.createElement(Harness, { pickerOpen: false })) // InputBar 重新挂载
    await settle()

    stdin.write(UP)
    await settle()
    expect(lastFrame()).toContain('hello')
  })

  // 正对照：证明上面那条的绿**不是**「rerender 次数」或「settle 够久」带来的，
  // 而是历史确实活在上层。同样的重渲染次数、同样的 stdin 序列，
  // 唯一差别是不切到会被换掉的另一支。
  it('（对照）同样重渲染但不卸载时，↑ 能调回', async () => {
    const { stdin, lastFrame, rerender } = render(
      React.createElement(Harness, { pickerOpen: false }),
    )
    stdin.write('hello')
    await settle()
    stdin.write(ENTER)
    await settle()

    rerender(React.createElement(Harness, { pickerOpen: false }))
    await settle()
    rerender(React.createElement(Harness, { pickerOpen: false }))
    await settle()

    stdin.write(UP)
    await settle()
    expect(lastFrame()).toContain('hello')
  })
})
