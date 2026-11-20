import { describe, it, expect } from 'vitest'
import type { Llm } from '../../src/providers/llm'
import { loadPerformanceTasks } from '../../src/core/task-performance'
import { measureCapture } from '../../src/core/capture-measure'

/** 没有 systemPrompt（off 臂）就交垃圾；有（on 臂）就交该题参考解。 */
const armSplitLlm: Llm = {
  chat: async function* (req) {
    const prompt = String(req.messages[0]?.content ?? '')
    if (req.systemPrompt) {
      const oracle =
        loadPerformanceTasks({ pool: 'all' }).find((t) => t.prompt === prompt)?.oracleCode ?? ''
      yield { type: 'text', content: oracle }
    } else {
      yield { type: 'text', content: 'export const nothing = 1' }
    }
  },
}

describe('measureCapture', () => {
  it('off/on 跑同一批 gate 题，oracle 本地判定', async () => {
    const res = await measureCapture(armSplitLlm, {
      skillName: 'safe-coding',
      skillText: '校验输入',
      k: 1,
    })
    expect(res.off).toHaveLength(1)
    expect(res.on).toHaveLength(1)
    expect(res.off[0]!.total).toBe(4) // safe-coding 的 gate 题，不含 sealed
    expect(res.on[0]!.total).toBe(4)
    expect(res.oraclePassed).toBe(true)
    expect(res.capture.tasksTotal).toBe(4)
    expect(res.capture.tasksUsed).toBe(4)
  })

  it('off 全错 / on 全对 ⇒ 捕获率 = 1（吃满上界）', async () => {
    const res = await measureCapture(armSplitLlm, {
      skillName: 'safe-coding',
      skillText: '校验输入',
      k: 1,
    })
    expect(res.capture.rate).toBeCloseTo(1, 6)
  })

  it('正对照：同一臂喂给两侧 ⇒ controlRate 必须为 0', async () => {
    const res = await measureCapture(armSplitLlm, {
      skillName: 'safe-coding',
      skillText: '校验输入',
      k: 1,
    })
    expect(res.controlRate).toBe(0)
  })

  it('sealed 与 gate 并排给出（缺省 gate 之外的唯一读数）', async () => {
    const res = await measureCapture(armSplitLlm, {
      skillName: 'safe-coding',
      skillText: '校验输入',
      k: 1,
    })
    expect(res.sealed).not.toBeUndefined()
    expect(res.sealed.capture.tasksTotal).toBe(1)
    expect(res.sealed.capture.rate).toBeCloseTo(1, 6)
    expect(res.sealed.oraclePassed).toBe(true)
  })
})
