/**
 * 草稿必须活过 InputBar 的卸载。
 *
 * `app.tsx` 在三条路径上整个卸载 InputBar（模型选择器 `pickerOpen` 三元、
 * API-key 提示早退、Ctrl+G 面板）。历史早就为此上提到了 App，草稿没有 ——
 * 写到一半按 Ctrl+P 切模型，输入就被静默吃掉。
 */
import React, { useState } from 'react'
import { Text, useInput } from 'ink'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { InputBar } from '../../src/ui/input'

const settle = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function Harness(): React.ReactElement {
  const [open, setOpen] = useState(true)
  const [draft, setDraft] = useState('')
  useInput((input, key) => {
    if (key.ctrl && input === 'x') setOpen((prev) => !prev)
  })
  return open
    ? React.createElement(InputBar, {
        onSubmit: () => {},
        isLoading: false,
        history: [],
        onHistoryAppend: () => {},
        draft,
        onDraftChange: setDraft,
      })
    : React.createElement(Text, null, '[closed]')
}

describe('InputBar 草稿的跨卸载存活', () => {
  it('输入 → 卸载 → 重新挂载，文本仍在', async () => {
    const { stdin, lastFrame } = render(React.createElement(Harness))

    stdin.write('hello draft')
    await settle()
    expect(lastFrame()).toContain('hello draft')

    stdin.write('\x18') // Ctrl+X → 卸载
    await settle()
    expect(lastFrame()).toContain('[closed]')

    stdin.write('\x18') // Ctrl+X → 重新挂载
    await settle()
    expect(lastFrame()).toContain('hello draft')
  })
})
