/**
 * 后台任务完成提示必须在**终端帧**里出现。
 *
 * 曾经 `app.tsx` 把 `◼ <desc> · finished` 写进 `msg.content`，同时把原始输出
 * 写进 `toolMeta.output`；而 `chat.tsx` 先渲染 `output`，`content` 就成了死代码。
 * 这里断言的是渲染结果，不是源码字符串：纯函数绿不代表它落在渲染路径上。
 */
import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { ChatPanel } from '../../src/ui/chat'
import { taskNotificationMessage } from '../../src/ui/app'

function frameOf(msg: ReturnType<typeof taskNotificationMessage>): string {
  const { lastFrame, unmount } = render(
    React.createElement(ChatPanel, { messages: [msg], focusMode: false }),
  )
  const frame = lastFrame() ?? ''
  unmount()
  return frame
}

describe('后台任务通知的渲染', () => {
  it('完成态：显示「finished」而不是裸输出预览', () => {
    const msg = taskNotificationMessage({
      status: 'completed',
      description: 'build',
      content: 'RAW-OUTPUT-XYZ',
    })
    expect(msg.toolMeta?.output).toBeUndefined()
    const frame = frameOf(msg)
    expect(frame).toContain('◼ build · finished')
    expect(frame).not.toContain('RAW-OUTPUT-XYZ')
  })

  it('运行/失败态：仍然显示任务名与预览（信号不能丢）', () => {
    const msg = taskNotificationMessage({
      status: 'failed',
      description: 'build',
      error: 'boom',
    })
    const frame = frameOf(msg)
    expect(frame).toContain('task')
    expect(frame).toContain('boom')
  })
})
