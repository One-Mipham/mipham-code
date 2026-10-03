/**
 * `chat.tsx` 的 `display()` —— 不受信文本变成终端输出的**唯一**一道口。
 *
 * 为什么必须在这一层钉：`stripControlCharsForDisplay` 是纯函数，
 * `test/shared/sanitize.test.ts` 已经把它逐条钉住 —— 但「净化器是对的」推不出
 * 「净化器在渲染路径上」。`chat.tsx` 里 `display(...)` 只要绕过一个字段，那个字段的
 * 控制字符就直达终端，而纯函数测试**照样全绿**。这与 D7 记的形态同族：纯函数绿 /
 * 源码字符串绿，都不能推出功能可用。
 *
 * 判据取自 ink 自己。实测 ink 7.1.1：裸 CSI（`\x1b[2J`）它丢掉，但 CR / BS / BEL /
 * VT / FF / DEL / NUL 原样穿过，且它**解析** SGR —— `\x1b[8m`（隐藏）被改写成
 * `\x1b[28m` 照发。所以「Ink 会处理」不能替代这道口，下面第一条就是那个形状。
 */

import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { ChatPanel } from '../../src/ui/chat'
import type { ChatMessage } from '../../src/ui/app'

const cp = (...cps: number[]) => String.fromCodePoint(...cps)

/** 渲染单条消息，取回终端帧。帧就是**终端真正收到的那串**。 */
function frameOf(msg: ChatMessage): string {
  const { lastFrame, unmount } = render(
    React.createElement(ChatPanel, { messages: [msg], focusMode: false }),
  )
  const frame = lastFrame() ?? ''
  unmount()
  return frame
}

describe('ChatPanel — 不受信文本不许把控制字符送进终端', () => {
  it('工具输出里的 CR 不落进帧（`printf` 覆盖整行的那个形状）', () => {
    const frame = frameOf({
      role: 'system',
      content: '',
      toolMeta: { name: 'Bash', input: 'printf X', output: 'safe.txt\rrm -rf /', collapsed: true },
    })
    expect(frame).not.toContain('\r')
    // 剩下的文字仍在 —— 是**去掉**控制符，不是丢掉内容。
    expect(frame).toContain('safe.txtrm -rf /')
  })

  it('工具参数（文件名 / 命令）里的 ESC 不落进帧', () => {
    const frame = frameOf({
      role: 'system',
      content: '',
      toolMeta: {
        name: 'Bash',
        input: `echo ${cp(0x1b)}[8mhidden`,
        output: 'ok',
        collapsed: true,
      },
    })
    expect(frame).not.toContain(cp(0x1b))
  })

  it('普通消息正文里的 BEL / DEL 不落进帧', () => {
    const frame = frameOf({ role: 'assistant', content: `done${cp(0x07)}${cp(0x7f)}` })
    expect(frame).not.toContain(cp(0x07))
    expect(frame).not.toContain(cp(0x7f))
  })

  // 正向对照。没有这两条，一个「把正文整个删掉」的实现在上面三条下同样全绿 ——
  // 而那正是把工具输出弄成空白的坏法。
  it('换行仍然分行（工具输出本来是多行的）', () => {
    const frame = frameOf({
      role: 'system',
      content: '',
      toolMeta: { name: 'Bash', input: 'x', output: 'line1\nline2', collapsed: true },
    })
    expect(frame).toContain('line1')
    expect(frame).toContain('line2')
  })

  it('正常正文原样可见', () => {
    const frame = frameOf({ role: 'assistant', content: '构建完成' })
    expect(frame).toContain('构建完成')
  })
})
