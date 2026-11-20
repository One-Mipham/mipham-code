/**
 * `/crsi bench --capture` 的**裁定资格**。
 *
 * 捕获率是「skill 文本吃到了多少上界」，因此它只有在**三个前提同时成立**时才有意义：
 *   1. 参考解全过自己的冻结测试（否则上界本身是错的）；
 *   2. 正对照为 0（同一臂喂两侧必须得 0，否则臂映射接错了）；
 *   3. 两侧每一轮都 `measurable`（仪器故障的 `score: 100` 不是满分）。
 *
 * 缺任何一条，读数是**真的但不描述被测对象**。此前的落点只判了前半个条件：率算出来了
 * 就顺手 `settleProbation`，于是一次作废的轮次照样推进观察窗 —— 观察窗里因此混进了
 * 与被测改动无关的读数。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const settle = vi.fn()
vi.mock('../../src/core/probation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/probation')>()),
  settleProbation: (skill: string, score: number) => settle(skill, score),
  formatProbationLines: () => [],
}))

const measure = vi.fn()
vi.mock('../../src/core/capture-measure', () => ({
  measureCapture: (...a: unknown[]) => measure(...a),
}))

const { getCommand } = (await import('../../src/ui/commands')) as unknown as {
  getCommand: (
    name: string,
  ) => ((ctx: unknown, args: string[]) => Promise<{ content: string }>) | undefined
}

const mkCtx = () =>
  ({
    engine: {
      getLlm: () => ({ chat: async () => '' }),
      getRegistry: () => ({ chat: async () => '' }),
    },
    skillsLoader: { get: () => ({ body: 'SKILL TEXT' }) },
  }) as unknown

const runStub = (score: number, extra: Record<string, unknown> = {}) => ({
  score,
  total: 1,
  passed: score === 100 ? 1 : 0,
  failures: [],
  measurable: true,
  uncertain: 0,
  results: [],
  tokensUsed: 10,
  ...extra,
})

const captureStub = (rate: number | null, extra: Record<string, unknown> = {}) => ({
  numerator: rate === null ? 0 : 50,
  denominator: rate === null ? 0 : 100,
  rate,
  tasksUsed: rate === null ? 0 : 1,
  tasksTotal: 1,
  noHeadroom: [],
  dropped: [],
  ci: rate === null ? null : { lo: 0.2, hi: 0.8 },
  ...extra,
})

function measurement(over: Record<string, unknown> = {}) {
  return {
    off: [runStub(0), runStub(0), runStub(0)],
    on: [runStub(50), runStub(50), runStub(50)],
    capture: captureStub(0.5),
    oraclePassed: true,
    controlRate: 0,
    sealed: { capture: captureStub(0.25), oraclePassed: true },
    ...over,
  }
}

beforeEach(() => {
  settle.mockReset()
  measure.mockReset()
})

const bench = () => getCommand('/crsi bench')!

describe('捕获率何时有裁定资格', () => {
  it('三项前提全成立 ⇒ 出率、出 sealed 旁证、并推进观察窗一次', async () => {
    measure.mockResolvedValue(measurement())
    const { content } = await bench()(mkCtx(), ['--capture', '--skill', 'safe-coding'])

    expect(content).toContain('50.0%')
    expect(content).toContain('sealed')
    expect(content).toContain('25.0%')
    expect(settle).toHaveBeenCalledTimes(1)
    expect(settle).toHaveBeenCalledWith('safe-coding', 50)
  })

  it('参考解没过 ⇒ 整轮作废，**不**推进观察窗', async () => {
    measure.mockResolvedValue(measurement({ oraclePassed: false }))
    const { content } = await bench()(mkCtx(), ['--capture', '--skill', 'safe-coding'])

    expect(content).toContain('作废')
    expect(settle).not.toHaveBeenCalled()
  })

  it('正对照不为 0 ⇒ 明说臂映射接错了，整轮读数不可信，**不**推进观察窗', async () => {
    measure.mockResolvedValue(measurement({ controlRate: 0.4 }))
    const { content } = await bench()(mkCtx(), ['--capture', '--skill', 'safe-coding'])

    expect(content).toContain('正对照')
    expect(content).toContain('40.0%')
    expect(settle).not.toHaveBeenCalled()
  })

  it('有一臂不可测 ⇒ 该轮不是一次合格重测，**不**推进观察窗', async () => {
    measure.mockResolvedValue(
      measurement({ off: [runStub(0), runStub(0, { measurable: false }), runStub(0)] }),
    )
    const { content } = await bench()(mkCtx(), ['--capture', '--skill', 'safe-coding'])

    expect(settle).not.toHaveBeenCalled()
    expect(content).toContain('不可测')
  })

  it('没有率（无 headroom）⇒ 不推进观察窗（0 与 null 不同形）', async () => {
    measure.mockResolvedValue(measurement({ capture: captureStub(null) }))
    await bench()(mkCtx(), ['--capture', '--skill', 'safe-coding'])

    expect(settle).not.toHaveBeenCalled()
  })
})
