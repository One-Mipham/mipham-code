import { describe, it, expect } from 'vitest'
import type { Llm } from '../../src/providers/llm'
import { runTaskPerformance, measureSkillDeltaRepeated } from '../../src/core/task-performance'

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
    expect(r.measurable).toBe(false) // 但这个 100 不许被当成「满分」
    expect(r.results.every((x) => x.uncertain === true && x.passed === false)).toBe(true)
  })

  it('零文本 + 有 usage ⇒ 记 fail，不算 uncertain', async () => {
    const r = await runTaskPerformance(toastedLlm)
    expect(r.uncertain).toBe(0)
    expect(r.score).toBe(0)
    expect(r.measurable).toBe(true)
    expect(r.results.some((x) => x.passed === false)).toBe(true)
  })

  it('一次没测到的臂 ⇒ measureSkillDeltaRepeated 返回 null（不产出 100 的假样本）', async () => {
    const s = await measureSkillDeltaRepeated(
      silentLlm,
      {
        filePath: 'apps/cli/skills/standard/safe-coding.SKILL.md',
        originalContent: '---\nname: safe-coding\n---\nold',
        newContent: '---\nname: safe-coding\n---\nnew',
      },
      { k: 1 },
    )
    expect(s).toBe(null)
  })
})
