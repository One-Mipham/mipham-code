/**
 * 奖励闸附注的**落点**（`CrsiModificationResult.rewardNote`）。
 *
 * 病根不是渲染，是**缺席**：`rewardNote` 是一个「闸自称施加了、实际没施加」的声明，
 * 若没有任何界面读它，它就与「闸真的全绿」在外部读数上同形 —— 声明的价值恰好等于它被看见的次数。
 *
 * 两件事一起钉：
 *   1. 行为 —— 走过真 `/crsi modify` handler，附注确实出现在回执里；
 *   2. 完整性 —— commands.ts 里**每一个** `runCrsiModification` 调用点之后
 *      （到下一个调用点之前）都必须出现 `renderGateNote`。
 *
 * 第 2 条是机械的、且被证明过会咬人：本笔按「4 个成功分支」手写，
 * 而 `--prose` 那条是第 5 个 —— 漏掉它，那条路径就静默退化成「附注永不显示」。
 * 逐处手拼迟早漏一个，所以这里不数人头，只断言区间性质。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

vi.mock('../../src/core/crsi-modify', () => ({
  runCrsiModification: vi.fn(),
  approvePending: vi.fn(() => ({ success: true, message: '' })),
  rejectPending: vi.fn(() => ({ success: true, message: '' })),
  hasPending: vi.fn(() => false),
}))

// 测量是可选的第二步；本文件只关心闸那一段，故让它恒空（不跑 LLM、不写账本）。
vi.mock('../../src/core/task-performance', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/task-performance')>()),
  measureSkillDeltaRepeated: vi.fn(async () => null),
}))

vi.mock('../../src/core/improvement-track', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/core/improvement-track')>()),
  readImprovements: vi.fn(() => []),
}))

const { getCommand } = (await import('../../src/ui/commands')) as unknown as {
  getCommand: (
    name: string,
  ) => ((ctx: unknown, args: string[]) => Promise<{ content: string }>) | undefined
}
const { runCrsiModification } = await import('../../src/core/crsi-modify')

const mkCtx = () =>
  ({ engine: { getLlm: () => undefined, getRegistry: () => undefined } }) as unknown

const NOTE = 'reward-fn 不提供逐契约结果 ⇒ anchor 闸未施加'

beforeEach(() => {
  vi.mocked(runCrsiModification).mockReset()
})

describe('rewardNote 的落点', () => {
  it('无附注 ⇒ 回执与从前逐字相同（附注是纯增量，不改既有排版）', async () => {
    vi.mocked(runCrsiModification).mockResolvedValue({
      phase: 'passed',
      applied: true,
      diff: 'DIFF',
    } as never)

    const cmd = getCommand('/crsi modify')!
    const { content } = await cmd(mkCtx(), ['改动说明', 'a.ts', 'x'])

    expect(content).toContain('DIFF')
    expect(content).not.toContain('奖励闸附注')
    // 附注不带空行插入：头行与 diff 之间仍恰好一个空行。
    expect(content).toContain('审阅下方 diff：\n\nDIFF\n')
  })

  it('有附注 ⇒ 出现在回执里（从此这个声明有人看见）', async () => {
    vi.mocked(runCrsiModification).mockResolvedValue({
      phase: 'passed',
      applied: true,
      diff: 'DIFF',
      rewardNote: NOTE,
    } as never)

    const cmd = getCommand('/crsi modify')!
    const { content } = await cmd(mkCtx(), ['改动说明', 'a.ts', 'x'])

    expect(content).toContain('⚠️ 奖励闸附注：')
    expect(content).toContain(NOTE)
    // 落在 diff 之前 —— 它是「这份 diff 过闸时闸没全施加」的前提，不是事后感想。
    expect(content.indexOf('奖励闸附注')).toBeLessThan(content.indexOf('DIFF'))
  })

  it('闸失败时走既有失败文案，不打附注（附注只描述「过闸」这一态）', async () => {
    vi.mocked(runCrsiModification).mockResolvedValue({
      phase: 'failed',
      applied: true,
      error: 'Harness unavailable (x): 空契约集',
      rewardNote: NOTE,
    } as never)

    const cmd = getCommand('/crsi modify')!
    const { content } = await cmd(mkCtx(), ['改动说明', 'a.ts', 'x'])

    expect(content).toContain('Harness unavailable')
    expect(content).not.toContain('奖励闸附注')
  })
})

describe('完整性：每个闸调用点都必须渲染附注（区间性质，不数人头）', () => {
  it('commands.ts 的每个 await runCrsiModification(...) 之后都能找到 renderGateNote', () => {
    const src = readFileSync(
      join(import.meta.dirname, '..', '..', 'src', 'ui', 'commands.ts'),
      'utf-8',
    )
    // 只切真调用点；`import { runCrsiModification }` 那行不含 `await`，天然不入选。
    const segments = src.split('await runCrsiModification(')
    const callSites = segments.slice(1)

    // 正对照：调用点确实存在且不止一个（切法错了这里会立刻红，而不是静默全绿）。
    expect(callSites.length).toBeGreaterThanOrEqual(5)

    const missing = callSites
      .map((seg, i) => ({ i, seg }))
      .filter(({ seg }) => !seg.includes('renderGateNote('))
      .map(({ i }) => i)

    expect(missing, `第 ${missing.join(', ')} 个调用点之后没有 renderGateNote`).toEqual([])
  })
})
