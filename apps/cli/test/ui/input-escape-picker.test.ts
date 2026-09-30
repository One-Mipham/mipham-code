import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { InputBar } from '../../src/ui/input'

/**
 * Escape 在选择器开着时的归属（一处分派冲突）。
 *
 * Ink 7 的 `useInput` **没有 stopPropagation**：一次按键会跑完所有已注册的监听器。
 * 选择器开着时是两个 —— `CommandPicker` 自己的（Esc ⇒ `onClose()`）与 `InputBar`
 * 那条总处理（Esc ⇒ idle 时清空草稿）。于是两个都对同一次 Escape 下手，而它们要的
 * 结果**正好相反**：前者把草稿留着（`onClose` 的注释写着「Keep the current typed
 * text so user can continue」），后者把它抹掉。
 *
 * 修法是 `InputBar` 那条在 `pickerActive` 时直接 return —— 不是「把清空改成别的」，
 * 而是**这次按键不属于它**。
 *
 * 观测点选两个：① 屏上还有没有 `/loop`；② 随后 Enter 提交出去的值。
 * 主判据是 ②：选择器的**列表里**本来就会有一条名字含 `/loop` 的命令，所以光看屏上
 * 有没有这串字，分不出「草稿保住了」与「列表里恰好列着它」；② 分得出 —— 选择器若
 * 还开着，Enter 走的是选择器那条路。选择器开没开另用它的圆角边框判定（`InputBar`
 * 自己那一层没有边框，见 `input.tsx:543`）。
 */

const ESC = '\x1b'
const ENTER = '\r'

/** ink-testing-library 无 act 包装，交还事件循环让 setState / effect 落定。 */
const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function renderBar(submitted: string[]): ReturnType<typeof render> {
  return render(
    React.createElement(InputBar, {
      onSubmit: (v: string) => submitted.push(v),
      isLoading: false,
      history: [],
      onHistoryAppend: () => {},
      recentMessages: [],
    }),
  )
}

/** 一次性写入整串（等价于一次粘贴）。
 *
 * 逐字符写不行：选择器是**异步挂载**的，`/` 之后紧跟的字符会有一部分落进刚挂上的
 * `CommandPicker` 自己的过滤框（实测 `> /l` + 过滤框 `oop`），草稿被劈成两半 ——
 * 那是测试手法造成的，不是被测行为。一次写入则整串落进 `MiphamTextInput` 的
 * 那一处 `onChange`，选择器再按这个值挂载。 */
async function type(r: ReturnType<typeof render>, text: string): Promise<void> {
  r.stdin.write(text)
  await settle()
}

describe('Escape 在选择器开着时归选择器（共享一次按键的两个监听器）', () => {
  it('Escape 关掉选择器但**保住草稿**，随后的 Enter 把草稿提交出去', async () => {
    const submitted: string[] = []
    const r = renderBar(submitted)

    await type(r, '/loop')
    // 前提：选择器真的开了。判据取它的圆角边框 —— `InputBar` 那一层没有边框，
    // 所以这个字符只会来自 `CommandPicker`。
    expect(r.lastFrame() ?? '', '前提：敲了 / 之后选择器该开着').toContain('╭')

    r.stdin.write(ESC)
    await settle()

    // ① 草稿还在（且边框没了 ⇒ 这一帧是普通输入行，不是选择器）。
    // 认的是 `> /loop` 这个**整串**：斜杠提示里也会出现 `/loop`（它是独立的一行），
    // 只找 `/loop` 会把提示行当成草稿。
    expect(r.lastFrame() ?? '', 'Escape 没把选择器关掉').not.toContain('╭')
    expect(r.lastFrame() ?? '', 'Escape 把草稿一起抹掉了 —— 两个监听器都下手了').toContain(
      '> /loop',
    )

    // ② 提交出去的值就是草稿本身
    r.stdin.write(ENTER)
    await settle()
    expect(submitted).toEqual(['/loop'])
  })

  it('反方向：选择器**没开**时，Escape 照旧清空草稿', async () => {
    // 少了这一条，把 `if (pickerActive) return` 写成无条件 `return`
    // （Escape 彻底失效）也能让上面那条全绿。
    const submitted: string[] = []
    const r = renderBar(submitted)

    await type(r, 'hello world')
    expect(r.lastFrame() ?? '').toContain('hello world')

    r.stdin.write(ESC)
    await settle()

    expect(r.lastFrame() ?? '', '不带 / 的草稿仍然该被 Escape 清掉').not.toContain('hello world')

    // 顺带钉住「清了就是真的清了」：Enter 不该提交出任何东西。
    r.stdin.write(ENTER)
    await settle()
    expect(submitted).toEqual([])
  })
})
