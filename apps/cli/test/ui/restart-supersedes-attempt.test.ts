/**
 * 323-251 的等价面：**重试之后，被丢弃的那次尝试不能还留在屏幕上。**
 *
 * 引擎侧的账已经收过：`restart` 一到，`engine.ts:809` / `:1260` 就把那次尝试累积的
 * 正文、推理、工具调用全部清空（不清空的话工具会执行两遍）。但**引擎的累加器不是
 * 屏幕** —— `app.tsx` 的消费循环此前没有 `restart` 分支，于是失败尝试的气泡留在
 * 消息列表里，重试的正文**接在它后面**，用户读到的是一段模型从未写完的回复紧接着
 * 真正的答案。
 *
 * 这里钉的是那个纯函数（按**对象身份**摘气泡，不按位置），以及源码侧的接线——
 * 纯函数绿不能推出「循环确实调了它」（同 `permission-cycle-wiring` 的理由）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { dropSupersededAttempt } from '../../src/ui/app'

type Msg = { role: string; content: string }

const APP_SRC = readFileSync(
  fileURLToPath(new URL('../../src/ui/app.tsx', import.meta.url)),
  'utf-8',
)

describe('dropSupersededAttempt — 重试摘掉被丢弃的那次尝试', () => {
  it('摘掉本次尝试的气泡，其余消息原样保留', () => {
    const failed: Msg = { role: 'assistant', content: 'half an ans' }
    const messages: Msg[] = [{ role: 'user', content: 'q' }, failed]

    const out = dropSupersededAttempt(messages, failed)

    expect(out).toEqual([{ role: 'user', content: 'q' }])
  })

  it('同一句话出现两次时，摘的是本次尝试那个对象，不是更早的那条', () => {
    // 身份而不是内容/位置：`indexOf` 若按值比较，删掉的就是上一轮的回答。
    const earlier: Msg = { role: 'assistant', content: 'ok' }
    const failed: Msg = { role: 'assistant', content: 'ok' }
    const out = dropSupersededAttempt([earlier, failed], failed)

    expect(out).toHaveLength(1)
    expect(out[0]).toBe(earlier)
  })

  it('气泡后面还跟着本次尝试的工具行时，工具行保留', () => {
    // 「删最后一条」的实现会在这里删掉工具结果行、把失败尝试的气泡留下 —— 两处都错。
    const failed: Msg = { role: 'assistant', content: 'let me look' }
    const toolRow: Msg = { role: 'system', content: 'Read src/a.ts' }
    const out = dropSupersededAttempt([failed, toolRow], failed)

    expect(out).toEqual([toolRow])
  })

  it('失败发生在推理阶段（屏幕上还没有气泡）时，消息一条不动', () => {
    const messages: Msg[] = [
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'previous answer' },
    ]
    expect(dropSupersededAttempt(messages, null)).toBe(messages)
  })
})

describe('接线：消费循环的 `restart` 分支确实调了它', () => {
  it('`chunk.restart` 分支里包含 dropSupersededAttempt', () => {
    const start = APP_SRC.indexOf('if (chunk.restart)')
    expect(start).toBeGreaterThan(-1)
    // 分支体到下一个同缩进的 `}` 为止 —— 取一段足够覆盖它的窗口即可。
    const branch = APP_SRC.slice(start, start + 1200)
    expect(branch).toContain('dropSupersededAttempt')
    expect(branch).toContain('isNewTurn = true')
  })

  it('推气泡时把对象存进 turnBubble；工具调用后清空（下一次正文另开气泡）', () => {
    expect(APP_SRC).toContain('turnBubble = bubble')
    // 反方向：`isNewTurn = true` 出现在工具调用分支之后，紧跟 `turnBubble = null`。
    const toolUse = APP_SRC.indexOf("if (chunk.type === 'tool_use'")
    expect(toolUse).toBeGreaterThan(-1)
    expect(APP_SRC.slice(toolUse, toolUse + 2500)).toContain('turnBubble = null')
  })
})
