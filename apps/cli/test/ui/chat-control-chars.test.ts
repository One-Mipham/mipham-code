/**
 * `chat.tsx` 通往终端的两道口 —— 多行的 `display()` 与单行的 `sanitizeInlineField`。
 *
 * 为什么必须在这一层钉：`stripControlCharsForDisplay` 是纯函数，
 * `test/shared/sanitize.test.ts` 已经把它逐条钉住 —— 但「净化器是对的」推不出
 * 「净化器在渲染路径上」。`chat.tsx` 里任何**绕过**净化器的字段，其控制字符都直达
 * 终端，而纯函数测试**照样全绿**。这与 D7 记的形态同族：纯函数绿 / 源码字符串绿，
 * 都不能推出功能可用。
 *
 * 「`display()` 是唯一一道口」曾写在本文件里，**是错的**：同一文件中工具**名**当初
 * 就是裸内插的（名字来自模型的 `tool_use`，`app.tsx` 的 `toolDisplayName` 对未知工具
 * 原样返回，MCP 服务端给的名字同理）。现已收口到**单行**口 `sanitizeInlineField` ——
 * 不是 `display()`，因为后者为多行正文留着 `\n`，而名字独占一行，一个 `\n` 就伪造出新行。
 *
 * 判据取自 ink 自己。实测 ink 7.1.1：裸 CSI（`\x1b[2J`）它丢掉，但 CR / BS / BEL /
 * VT / FF / DEL / NUL 原样穿过，且它**解析** SGR —— `\x1b[8m`（隐藏）被改写成
 * `\x1b[28m` 照发。所以「Ink 会处理」不能替代这两道口，下面第一条就是那个形状。
 */

import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { ChatPanel, summarizeToolGroup } from '../../src/ui/chat'
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

  // 工具**名**是同一文件里的第二道口，且名字同样来自模型写的字。
  // 探针用 SGR 形状：裸 CSI 会被 Ink 丢掉、那种用例恒绿（见文件头）。
  it('工具**名**里的 ESC / BEL / C1 不落进帧', () => {
    const frame = frameOf({
      role: 'system',
      content: '',
      toolMeta: {
        name: `Bash${cp(0x1b)}[8m_x${cp(0x07)}${cp(0x9b)}`,
        input: 'ls',
        output: 'ok',
        collapsed: true,
      },
    })
    expect(frame).not.toContain(cp(0x1b))
    expect(frame).not.toContain(cp(0x07))
    expect(frame).not.toContain(cp(0x9b))
    // 去掉的是控制符，不是内容。
    expect(frame).toContain('Bash[8m_x')
  })

  // 名字走的是**单行**口而不是 `display()`。后者为多行正文留着 `\n`，而名字独占一行 ——
  // 一个 `\n` 就伪造出终端里的一整行。这条同时钉住「选对了哪一个口」。
  it('工具**名**里的换行不伪造出新的一行', () => {
    const frame = frameOf({
      role: 'system',
      content: '',
      toolMeta: { name: 'Bash\nInjected', input: 'ls', output: 'ok', collapsed: true },
    })
    expect(frame).toContain('BashInjected')
    expect(frame.split('\n').map((l) => l.trim())).not.toContain('Injected')
  })

  it('正对照：正常的工具名照常显示', () => {
    const frame = frameOf({
      role: 'system',
      content: '',
      toolMeta: { name: 'Bash', input: 'ls', output: 'ok', collapsed: true },
    })
    expect(frame).toContain('Bash')
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

/**
 * focus 模式把连续的工具消息折成一行摘要，而那一行里拼着**模型的**工具名字
 * （`tool_use`，MCP 服务端给的名字同理）—— 同一个不受信来源，第三条口。
 *
 * ⚠️ 诚实边界，别把下面第三条当成修复的证据：**今天的渲染路径根本不读那个
 * `content`**。`MessageRow` 走 `toolMeta` 那一支，`output` 非空就赢，而
 * `collapsed: true` 又挡住 `content` 兜底 —— 实测帧里连 `↳` 都不出现（空 output
 * 的那一档也试过，同样不出现）。所以第三条是**给未来的渲染器**留的闸，改前改后
 * 都绿；真正能失败、也因此真正承载这次改动的，是第一条。
 */
describe('summarizeToolGroup — 折叠摘要那一行是单行字段', () => {
  const dirty = `Bash${cp(0x1b)}[8m_x${cp(0x07)}${cp(0x9b)}\nInjected`
  const groupOf = (...names: string[]) =>
    summarizeToolGroup(
      names.map((name) => ({
        role: 'system' as const,
        content: 'x',
        toolMeta: { name, input: 'x', output: 'ok', collapsed: true },
      })),
    )

  it('名字里的换行与控制字符都不进摘要行（这条能失败：改前是红的）', () => {
    const { content } = groupOf(dirty, 'Read\nB')
    // 一行就是一行 —— `display()` 为多行正文留着 `\n`，这里一个都不许有。
    expect(content.split('\n')).toHaveLength(1)
    expect(content).not.toMatch(/[\x00-\x1f\x7f\x80-\x9f]/)
    // 去掉的是控制符，不是内容。
    expect(content).toContain('↳ Bash[8m_xInjected')
  })

  it('正对照：正常的名字照常拼进去（别把摘要整行删掉也当通过）', () => {
    const { content } = groupOf('Bash', 'Read')
    expect(content).toContain('[▶ 2 tools]')
    expect(content).toContain('↳ Bash  ↳ Read')
  })

  it('focus 模式的帧里也没有控制字符、也伪造不出新行（守住未来的渲染器）', () => {
    const frame = chatFrame({
      focusMode: true,
      messages: [
        {
          role: 'system',
          content: 'x',
          toolMeta: { name: dirty, input: 'x', output: 'ok', collapsed: true },
        },
      ],
    })
    expect(frame).not.toContain(cp(0x1b))
    expect(frame).not.toContain(cp(0x07))
    expect(frame).not.toContain(cp(0x9b))
    expect(frame.split('\n').map((l) => l.trim())).not.toContain('Injected')
    // 正对照：那一组确实渲染了（否则上面几条可能只是探针没读到东西）。
    expect(frame).toContain('tools (1)')
  })
})
