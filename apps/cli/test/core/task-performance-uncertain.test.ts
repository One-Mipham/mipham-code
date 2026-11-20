import { describe, it, expect } from 'vitest'
import type { Llm } from '../../src/providers/llm'
import { runTaskPerformance } from '../../src/core/task-performance'

const silentLlm: Llm = {
  chat: async function* () {
    yield { type: 'stop' }
  },
}
const toastedLlm: Llm = {
  chat: async function* () {
    yield { type: 'usage', inputTokens: 7, outputTokens: 0 }
    yield { type: 'stop' }
  },
}

describe('uncertain：仪器故障与答错不同形', () => {
  it('零文本 + 无 usage ⇒ 每题 uncertain，且不计入分数', async () => {
    const r = await runTaskPerformance(silentLlm)
    expect(r.uncertain).toBe(r.total)
    expect(r.score).toBe(100) // 没有可评分的题 ⇒ 不是 0
    expect(r.results.every((x) => x.uncertain === true && x.passed === false)).toBe(true)
  })

  it('零文本 + 有 usage ⇒ 记 fail，不算 uncertain', async () => {
    const r = await runTaskPerformance(toastedLlm)
    expect(r.uncertain).toBe(0)
    expect(r.score).toBe(0)
    expect(r.results.some((x) => x.passed === false)).toBe(true)
  })
})
