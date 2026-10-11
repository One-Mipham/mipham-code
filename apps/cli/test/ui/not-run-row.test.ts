/**
 * 「未运行」行（296-056）。
 *
 * auto 档里，分类器**没有可用的答案**时那次调用被拿住、从未执行。它与「策略拒绝」
 * 在文案层早已分叉（`engine.ts` 走两条 i18n），但在 `tool_result` 里同形：都是
 * `success:false` + 一段错误串 ⇒ 展示层此前把它画成普通的 `⎿ <输出>` 行，
 * 读起来像**工具跑过了并返回了这段话**。
 *
 * ⚠️ 消息一律按**真实形状**给：`app.tsx` 先发工具调用行（带名字），结果行**没有名字**
 * 且只有 `output`。`ChatPanel` 的合并会把结果行的 toolMeta 并进调用行，且**孤儿结果行
 * 直接被丢弃** —— 只喂一条无名结果行的话，帧是空的，断言会在「什么都没渲染」上红。
 * 合并路径是否把标记带过去，正是本文件要钉的第一件事。
 *
 * 判据落在帧上：`notRun` 的行必须带上「未运行」标记，普通工具结果行不得带上
 * —— 只断言「有标记」的话，把标记加到每一行上同样全绿。
 */
import React from 'react'
import { describe, it, expect } from 'vitest'
import { render } from 'ink-testing-library'
import { ChatPanel } from '../../src/ui/chat'
import type { ChatMessage } from '../../src/ui/app'
import { I18nProvider } from '../../src/i18n-context'
import { createT } from '../../src/i18n-core/t'
import enUS from '../../src/i18n-core/locales/en-US.json'
import type { TranslationMap } from '../../src/i18n-core/types'

const MARK = 'Not run'

/**
 * 必须挂 `I18nProvider`：没有 Provider 时 `useI18n()` 的 `t` 是**恒等函数**，
 * 帧里出现的是裸键 `ui.tool.not_run` —— 那样断言「帧里有 Not run」会在键名上红，
 * 而真实运行时用户看到的是译文。这里把真译文接上，判据才对着用户看到的那串。
 */
const t = createT(enUS as TranslationMap, enUS as TranslationMap)

function frameOf(...messages: ChatMessage[]): string {
  // `children` goes in the props object (createElement 的第二参)，与本仓既有写法一致
  // （`test/core/i18n.test.ts`）—— `I18nProvider` 的 props 类型把 children 声明成必填，
  // 走 createElement 的尾随 children 参数会 TS2769。
  const { lastFrame, unmount } = render(
    React.createElement(I18nProvider, {
      locale: 'en-US',
      t,
      children: React.createElement(ChatPanel, { messages, focusMode: false }),
    }),
  )
  const frame = lastFrame() ?? ''
  unmount()
  return frame
}

const toolCall = (name: string): ChatMessage => ({
  role: 'system',
  content: '',
  toolMeta: { name, input: 'ls', collapsed: true },
})

describe('工具结果行 —— 被拿住的调用标为「未运行」', () => {
  it('notRun 行带标记，且**理由**仍可见', () => {
    const reason = 'Tool "bash" was NOT run: classifier unreachable'
    const frame = frameOf(toolCall('Bash'), {
      role: 'system',
      content: reason,
      toolMeta: {
        name: '',
        input: '',
        output: reason,
        collapsed: true,
        originalName: 'Bash',
        notRun: true,
      },
    })
    expect(frame).toContain('Bash')
    expect(frame).toContain(MARK)
    expect(frame).toContain('classifier unreachable')
  })

  it('反方向：普通工具结果不得出现该标记（否则标记不再是区分）', () => {
    const frame = frameOf(toolCall('Bash'), {
      role: 'system',
      content: 'total 12',
      toolMeta: { name: '', input: '', output: 'total 12', collapsed: true, originalName: 'Bash' },
    })
    expect(frame).toContain('total 12')
    expect(frame).not.toContain(MARK)
  })
})
