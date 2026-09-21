/**
 * `/crsi eval` 的契约粒度差异展示（B1）。
 *
 * 这一层测的是**接线**，不是纯函数语义 —— `getContractHistory` / `diffContractHistory` /
 * `renderContractDiff` 各自的含义由 `test/core/eval-harness.test.ts` 覆盖。这里只钉一件事：
 * 调用点必须**先读后写**。把两行对调，`prev` 就读到了刚写进去的那条 ⇒ 差异恒为空 ⇒
 * 「与上次相比」整段消失 ⇒ 本文件红。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'

// 账本会真的落盘 —— 必须压在 tmpdir 里，别碰用户的 ~/.mipham。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => `${actual.tmpdir()}/mipham-test-crsi-eval-diff` }
})

vi.mock('node:child_process', () => ({ execSync: vi.fn() }))
vi.mock('../../src/core/session-store', () => ({
  SessionStore: {
    getLatest: vi.fn(() => null),
    load: vi.fn(() => null),
    list: vi.fn(() => []),
    delete: vi.fn(() => false),
  },
}))

const { getCommand } = (await import('../../src/ui/commands')) as {
  getCommand: (
    name: string,
  ) => ((ctx: unknown, args: string[]) => Promise<{ content: string }>) | undefined
}
const { appendEvalScore, getContractHistory } = await import('../../src/core/eval-harness')

const mkCtx = () =>
  ({
    engine: { getLlm: () => undefined, getRegistry: () => undefined },
  }) as unknown

beforeEach(() => {
  rmSync(join(homedir(), '.mipham', 'crsi', 'eval-scores.jsonl'), { force: true })
})

describe('/crsi eval 契约粒度差异', () => {
  it('先读后写：与上一次落盘的态比对，且本次结果已写回', async () => {
    // 上一次：一条真契约 FAIL、一条本次已不存在的契约
    appendEvalScore('mechanism-sentinel', {
      score: 95,
      passed: 38,
      total: 40,
      results: [
        { id: 'rule-timeout', description: 'x', passed: false },
        { id: 'ghost-contract', description: 'x', passed: true },
      ],
    })

    const cmd = getCommand('/crsi eval')
    expect(cmd).toBeDefined()
    const { content } = await cmd!(mkCtx(), [])

    expect(content).toContain('### 与上次相比')
    expect(content).toContain('✅ rule-timeout ← 上次 FAIL，本次 PASS（已修复）')
    expect(content).toContain('➖ ghost-contract ← 本次未出现（已移出契约集）')

    // 写回已发生：最新一条快照是本次全量 40 条
    const latest = getContractHistory('mechanism-sentinel')[0]!
    expect(Object.keys(latest)).toHaveLength(40)
  })

  it('连跑两次：第二次把「上一次 FAIL、上上次也 FAIL」之外的历史读成抖动', async () => {
    appendEvalScore('mechanism-sentinel', {
      score: 95,
      passed: 38,
      total: 40,
      results: [{ id: 'rule-timeout', description: 'x', passed: false }],
    })
    const cmd = getCommand('/crsi eval')!
    await cmd(mkCtx(), [])
    const { content } = await cmd(mkCtx(), [])

    // 窗口里 PASS 与 FAIL 都出现过 ⇒ 抖动，不是「已修复」
    expect(content).toContain('⚠️ rule-timeout ← 近几次结果不一致（抖动）')
    expect(content).not.toContain('✅ rule-timeout ←')
  })
})
