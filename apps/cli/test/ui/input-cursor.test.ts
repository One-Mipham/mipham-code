import { describe, it, expect } from 'vitest'
import { createElement } from 'react'

/**
 * 输入光标的**渲染**测试。
 *
 * 病根是**缺席**：光标此前写在 placeholder 三元表达式的 `else` 分支里，而
 * `value.length === 0 && placeholder` 在真实使用中永远成立（placeholder 是
 * `t('ui.input.placeholder')` 或加载动词，从不是空串）⇒ **初始状态一个光标都没有**，
 * 而那正是最常看到的状态。逻辑侧（`applyEdit` 的左右移动/退格）在 `input-edit.test.ts`
 * 里覆盖得不差 —— 「纯函数绿」推不出「屏幕上有那个方块」：渲染分支归谁走，纯函数一无所知。
 *
 * ⚠️ **本文件必须设 `FORCE_COLOR=1`**（且必须设在 ink 被加载之前，故这里用动态 import）：
 * vitest 下 stdout 不是 TTY ⇒ chalk 关色 ⇒ 帧里**一个样式码都没有**（实测：不设时连
 * `\e[7m` 都读不到）。不设的话本文件改前改后都绿 —— 是仪式不是证据。
 */

process.env.FORCE_COLOR = '1'
const { render } = await import('ink-testing-library')
const { InputBar } = await import('../../src/ui/input')

/** 显式白底 + 黑字（见 `input.tsx` 里那段注释：刻意**不用** `inverse`）。 */
const BG_WHITE = '\u001b[47m'
const FG_BLACK = '\u001b[30m'
/** 反显。旧画法用这个；本笔之后一帧里都不该再有。 */
const INVERSE = '\u001b[7m'
const DIM = '\u001b[2m'
const LEFT = '\u001b[D'

const props = { onSubmit: () => {}, isLoading: false, history: [], onHistoryAppend: () => {} }
/** ink-testing-library 无 act 包装，交还事件循环让 setState / effect 落定。 */
const settle = (ms = 80): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('输入光标（白色方块）', () => {
  it('空输入也有光标：白块在占位文字**之前**', async () => {
    const { lastFrame } = render(createElement(InputBar, props))
    await settle()
    const frame = lastFrame() ?? ''

    // 正对照：白块真渲染了。缺了这一格，下面的位置断言在「什么都没渲染」时也恒真。
    expect(frame).toContain(BG_WHITE)
    expect(frame).toContain(FG_BLACK)
    // 占位文字是本帧唯一的 dim 段 —— 用它定位，避免依赖具体译文。
    const dimAt = frame.indexOf(DIM)
    expect(dimAt).toBeGreaterThan(-1)
    expect(frame.indexOf(BG_WHITE)).toBeLessThan(dimAt)
  })

  it('有文字时光标在末尾', async () => {
    const { lastFrame, stdin } = render(createElement(InputBar, props))
    await settle()
    stdin.write('abc')
    await settle()
    expect(lastFrame() ?? '').toContain(`abc${BG_WHITE}`)
  })

  it('光标移到字符上时，那个字符被包在白块里', async () => {
    const { lastFrame, stdin } = render(createElement(InputBar, props))
    await settle()
    stdin.write('abc')
    await settle()
    stdin.write(LEFT)
    await settle()
    // 白块挖空一个黑字 —— 与「块在末尾（空格）」是两种形状，必须分别钉住。
    expect(lastFrame() ?? '').toContain(`ab${BG_WHITE}${FG_BLACK}c`)
  })

  it('白是**显式**的，不是反显', async () => {
    const { lastFrame, stdin } = render(createElement(InputBar, props))
    await settle()
    stdin.write('abc')
    await settle()
    const frame = lastFrame() ?? ''
    expect(frame).toContain(BG_WHITE)
    expect(frame).not.toContain(INVERSE)
  })
})
