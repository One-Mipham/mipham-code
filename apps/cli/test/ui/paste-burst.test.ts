/**
 * 输入框的提交渲染次数不得随粘贴字符数线性增长。
 *
 * 背景：`8f535829` 曾用 30fps 节流修过「大段粘贴 → N 次 setState → Ink 写 N 帧 →
 * 事件循环饿死、按键堆积」。此后输入框重写成 `MiphamTextInput`（ref 原子插入，
 * 解决乱序/丢字），那层节流不复存在 —— 很容易据此推断「粘贴洪水回来了」。
 *
 * **实测不是**（2026-11-20，本文件）：4000 字符一次写入 **1 次**提交；分 200 次
 * 写入同样 **1 次**（React 把同一 tick 的 setState 合成一次提交）。所以这里不是
 * 「修粘贴洪水」，而是**把「不是它」钉住**：谁若把 onChange 改成逐字符异步
 * （例如每个字符 await 一次补全），提交次数就会线性增长，这两个用例变红。
 *
 * 量的是提交次数（React Profiler 的 onRender），不是墙上时间 —— 时间随机器浮动，
 * 提交次数是确定性的。
 */
import React, { Profiler } from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { InputBar } from '../../src/ui/input'

const settle = (ms = 60): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function renderMetered(): {
  stdin: { write: (s: string) => void }
  commits: () => number
  reset: () => void
  lastFrame: () => string | undefined
} {
  let commits = 0
  const utils = render(
    React.createElement(
      Profiler,
      {
        id: 'bar',
        onRender: () => {
          commits += 1
        },
      },
      React.createElement(InputBar, {
        onSubmit: () => {},
        isLoading: false,
        history: [],
        onHistoryAppend: () => {},
        recentMessages: [],
      }),
    ),
  )
  return {
    stdin: utils.stdin,
    commits: () => commits,
    reset: () => {
      commits = 0
    },
    lastFrame: utils.lastFrame,
  }
}

describe('粘贴不得逐字符重渲染', () => {
  it('一次写入 4,000 字符：提交次数有上界（不随字符数线性增长）', async () => {
    const m = renderMetered()
    await settle()
    m.reset()

    const text = 'a'.repeat(4000)
    m.stdin.write(text)
    await settle(200)

    const n = m.commits()
    console.log(`[measure] one-write 4000 chars → ${n} commits`)
    expect(n).toBeLessThan(50)
  })

  it('分 200 次写入 4,000 字符：提交次数有上界', async () => {
    const m = renderMetered()
    await settle()
    m.reset()

    for (let i = 0; i < 200; i++) {
      m.stdin.write('b'.repeat(20))
    }
    await settle(500)

    const n = m.commits()
    console.log(`[measure] 200 writes of 20 chars → ${n} commits`)
    expect(n).toBeLessThan(50)
  })
})
