/**
 * 295-056：正文渲染的行数上限。
 *
 * Ink 每次渲染都对**整段**正文排版，而流式回合在持续重渲染 —— 一条数万行的回复
 * （模型 dump 了个文件、跑飞了的循环）会让每个 chunk 都重排整段，~16fps。这里钉住
 * 「超过上限就截断，且**明说**截了」：静默截断会让用户以为自己看全了。
 *
 * 判据取自 ink 的帧（终端真正收到的那串），不是源码字符串 —— 同
 * `chat-control-chars.test.ts` 的理由：函数对 ≠ 函数在渲染路径上。
 */

import React from 'react'
import { render } from 'ink-testing-library'
import { describe, expect, it } from 'vitest'
import { ChatPanel } from '../../src/ui/chat'
import type { ChatMessage } from '../../src/ui/app'

function frameOf(content: string): string {
  const msg: ChatMessage = { role: 'assistant', content }
  const { lastFrame, unmount } = render(
    React.createElement(ChatPanel, { messages: [msg], focusMode: false }),
  )
  const frame = lastFrame() ?? ''
  unmount()
  return frame
}

const numbered = (n: number) => Array.from({ length: n }, (_, i) => `L${i + 1}`).join('\n')

describe('ChatPanel — 正文行数上限', () => {
  it('短正文整段渲染（对照：上限不是把一切都砍了）', () => {
    const frame = frameOf(numbered(10))
    expect(frame).toContain('L1')
    expect(frame).toContain('L10')
    expect(frame).not.toContain('more line')
  })

  it('恰好 50 行不截 —— 边界是 > 而非 >=', () => {
    const frame = frameOf(numbered(50))
    expect(frame).toContain('L50')
    expect(frame).not.toContain('more line')
  })

  it('超长正文截到 50 行，并留下可见的「还有 N 行」', () => {
    const frame = frameOf(numbered(60))
    expect(frame).toContain('L1')
    expect(frame).toContain('L50')
    expect(frame).not.toContain('L60')
    expect(frame).toContain('10 more lines')
  })

  it('只多一行时说「1 more line」（复数形式随数量）', () => {
    expect(frameOf(numbered(51))).toContain('1 more line')
  })
})
