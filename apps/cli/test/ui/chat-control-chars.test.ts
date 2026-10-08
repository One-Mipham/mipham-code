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
import enUS from '../../src/i18n-core/locales/en-US.json'

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

  // 制表符与 CR/ESC 同族，但机制不同：Ink 不算它宽（`string-width` 记 0 列），却把它
  // 原样写进帧，终端于是推进到下一个制表位、压到下一行。钉在**帧**上，才能证明它在
  // 渲染路径上被中和，而不只是在纯函数里是对的。
  it('工具输出里的制表符不落进帧（终端会把它推进到制表位）', () => {
    const frame = frameOf({
      role: 'system',
      content: '',
      toolMeta: { name: 'Bash', input: 'x', output: 'total\t2', collapsed: true },
    })
    expect(frame).not.toContain('\t')
    expect(frame).toContain('total 2')
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

/**
 * 长回合里的 focus 提示 —— 出现时机与**出口**都要对。
 *
 * 这条提示只在「正有回合在跑」时出现：那是 transcript 长得最快、也最可能有人想
 * 收起来的时刻；写进空闲横幅等于在还没有东西可聚焦之前先说一遍。同时它必须
 * **说出回来的路**，否则试一下就把人卡在里面；focus 模式里也不再重复（那里
 * 自己的横幅已经写着了）。
 */
// 测试里没有 i18n Provider，默认 context 是个**把 key 原样返回**的 no-op ——
// 所以帧里能看到的是 key 本身。这仍然是判据：这个块渲染了，帧里就有它。
const FOCUS_TIP = 'ui.chat.try_focus_tip'
const FOCUS_TIP_EN = (enUS as { ui: { chat: { try_focus_tip: string } } }).ui.chat.try_focus_tip

function chatFrame(props: {
  turnActive?: boolean
  focusMode?: boolean
  messages?: ChatMessage[]
}): string {
  const { lastFrame, unmount } = render(
    React.createElement(ChatPanel, {
      messages: props.messages ?? [{ role: 'assistant', content: '答案是 42' }],
      focusMode: props.focusMode ?? false,
      ...(props.turnActive === undefined ? {} : { turnActive: props.turnActive }),
    }),
  )
  const frame = lastFrame() ?? ''
  unmount()
  return frame
}

describe('ChatPanel — 回合进行中的 focus 提示', () => {
  it('回合在跑时提示出现，且写明怎么切回来', () => {
    const frame = chatFrame({ turnActive: true })
    expect(frame).toContain(FOCUS_TIP)
    // 文案本身要带出口 —— 否则「试一下」就把人卡在 focus 里，那是这条提示
    // 存在的理由，不是装饰。
    expect(FOCUS_TIP_EN).toMatch(/Ctrl\+F/)
    expect(FOCUS_TIP_EN).toMatch(/switch back/i)
  })

  it('正对照：回合没在跑时不出现（它是时机提示，不是常驻文案）', () => {
    expect(chatFrame({ turnActive: false })).not.toContain(FOCUS_TIP)
    expect(chatFrame({})).not.toContain(FOCUS_TIP)
  })

  it('已经在 focus 模式里就不再重复（那儿的横幅已经说了怎么回来）', () => {
    expect(chatFrame({ turnActive: true, focusMode: true })).not.toContain(FOCUS_TIP)
  })

  it('没有任何消息时不出现 —— 还没有东西可聚焦', () => {
    expect(chatFrame({ turnActive: true, messages: [] })).not.toContain(FOCUS_TIP)
  })
})
