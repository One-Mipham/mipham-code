import { describe, it, expect } from 'vitest'
import { shrinkAgentMessages, isToolResultMessage } from '../../src/agent/auto-compact'
import { ContextManager } from '../../src/core/context'
import type { Message } from '../../src/shared/index.ts'

// 真估计器：走 manager 的公共桥，与子代理循环读的是**同一个数**（不是第二份估计）。
const mgr = new ContextManager({ maxTokens: 100_000, compactionThreshold: 0.85 })
const est = (m: Message[]) => mgr.estimateTokensForMessages(m)

const fat = (n: number) => 'x'.repeat(n) // latin ≈ 4 chars/token
const task = (): Message => ({ role: 'user', content: 'THE TASK' })

/** 复刻子代理循环每轮的形状：A(text) → A(tool_use) → U(tool_result) */
function turnPair(i: number, chars: number): Message[] {
  return [
    { role: 'assistant', content: 'Executing tools...' },
    {
      role: 'assistant',
      content: [{ type: 'tool_use', id: String(i), name: 'Bash', input: {} }],
    },
    {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: String(i), content: fat(chars) }],
    },
  ]
}

describe('shrinkAgentMessages', () => {
  it('未超窗 ⇒ 原样返回（同一个引用，不产生无谓拷贝）', () => {
    const msgs: Message[] = [
      task(),
      { role: 'assistant', content: 'a' },
      { role: 'user', content: 'b' },
    ]
    expect(shrinkAgentMessages(msgs, 100_000, est)).toBe(msgs)
  })

  it('窗口大 ⇒ 无论多少轮都不动', () => {
    const msgs = [task()]
    for (let i = 0; i < 40; i++) msgs.push(...turnPair(i, 400))
    expect(shrinkAgentMessages(msgs, 10_000_000, est)).toBe(msgs)
  })

  it('超窗 ⇒ 收缩，且任务始终钉在 [0]', () => {
    const msgs = [task()]
    for (let i = 0; i < 30; i++) msgs.push(...turnPair(i, 400))
    const out = shrinkAgentMessages(msgs, 100, est)
    expect(out.length).toBeLessThan(msgs.length)
    expect(out[0]!.content).toBe('THE TASK')
  })

  it('收缩后头部不留孤立 tool_result（其 tool_use 已被切掉）', () => {
    const msgs = [task()]
    for (let i = 0; i < 30; i++) msgs.push(...turnPair(i, 400))
    const out = shrinkAgentMessages(msgs, 100, est)
    // 断言这次收缩**确实**把边界切在 U 上（否则本用例是空转）
    expect(isToolResultMessage(msgs[msgs.length - 10]!)).toBe(true)
    expect(isToolResultMessage(out[1]!)).toBe(false)
  })

  it('（对照）任务本身不被当作可丢的中间轮 —— 它就是 [0]', () => {
    const msgs = [task()]
    for (let i = 0; i < 30; i++) msgs.push(...turnPair(i, 400))
    const out = shrinkAgentMessages(msgs, 100, est)
    expect(out.filter((m) => m.content === 'THE TASK')).toHaveLength(1)
    expect(out[0]).toBe(msgs[0])
  })
})

describe('isToolResultMessage', () => {
  it('user + tool_result 块 ⇒ true', () => {
    const m: Message = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: '1', content: 'x' }],
    }
    expect(isToolResultMessage(m)).toBe(true)
  })

  it('（对照）纯文本 user 轮 ⇒ false', () => {
    expect(isToolResultMessage({ role: 'user', content: 'hi' })).toBe(false)
  })

  it('（对照）带 tool_use 的 assistant 轮 ⇒ false', () => {
    const m: Message = {
      role: 'assistant',
      content: [{ type: 'tool_use', id: '1', name: 'Bash', input: {} }],
    }
    expect(isToolResultMessage(m)).toBe(false)
  })
})
