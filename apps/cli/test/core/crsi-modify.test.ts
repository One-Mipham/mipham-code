import { describe, it, expect, afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { join } from 'node:path'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { CrsiSandbox } from '../../src/core/crsi-sandbox'
import { LESSONS_FILE } from '../../src/core/crsi-producer'
import {
  runCrsiModification,
  approvePending,
  rejectPending,
  hasPending,
} from '../../src/core/crsi-modify'
import type { CrsiProposal } from '../../src/core/crsi-modify'
import { appendEvalScore, runEval } from '../../src/core/eval-harness'

// Isolate the sandbox report dir (matching crsi-sandbox.test.ts).
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-crsi-modify`,
  }
})

// Repo-root-relative path inside the worktree (worktree = full monorepo copy).
const WORKTREE_FILE = 'apps/cli/README.md'

/**
 * 夹具是一棵**自建的临时仓库**（同 `crsi-sandbox.test.ts` 的理由）：
 * `CrsiSandbox` 只接受「自己那棵工作树的根」，而进程 cwd 是 `apps/cli`（真仓库的子目录）
 * ⇒ 拿 cwd 构造会被形状闸拒绝；更要紧的是，此前这些 `createWorktree()` 全都在**真仓库**
 * 上建 worktree / 建分支，那是本文件不该有的副作用。
 */
function initSandboxRepo(): string {
  // realpathSync：macOS 的 /var 是指向 /private/var 的链接，而 git 回的是物理路径。
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'crsi-modify-repo-')))
  mkdirSync(join(root, 'apps', 'cli'), { recursive: true })
  writeFileSync(join(root, WORKTREE_FILE), 'crsi-modify fixture body\n')
  const git = (args: string) => execSync(`git ${args}`, { cwd: root, stdio: 'ignore' })
  git('init -q')
  git('config user.email crsi-modify@test.invalid')
  git('config user.name crsi-modify-test')
  // 关掉签名，否则继承本机的 commit.gpgsign 会去要钥匙。
  git('config commit.gpgsign false')
  git('add -A')
  git('commit -q -m fixture')
  return root
}

let sandboxRepo: string

beforeAll(() => {
  sandboxRepo = initSandboxRepo()
})

afterAll(() => {
  rmSync(sandboxRepo, { recursive: true, force: true })
})

beforeEach(() => {
  // 清空 rewards 日志，避免跨运行残留的旧分数（如 gap 表上线前的 100）触发假退化。
  rmSync(join(homedir(), '.mipham', 'crsi', 'eval-scores.jsonl'), { force: true })
})

afterEach(() => {
  // 安全清理：reject = 回滚 worktree，不触碰真实仓库。
  if (hasPending()) rejectPending()
})

describe('runCrsiModification', () => {
  it('rejects protected paths without running tests', async () => {
    const sandbox = new CrsiSandbox(sandboxRepo)
    const result = await runCrsiModification(
      {
        description: 'blocked',
        filePath: 'apps/cli/test/foo.test.ts',
        newContent: '{}',
        blastRadius: ['apps/cli/test/foo.test.ts'],
      },
      sandbox,
    )
    expect(result.phase).toBe('failed')
    expect(result.error).toContain('Protected path')
    expect(hasPending()).toBe(false)
  })

  it('tests pass → phase passed + diff + pending', async () => {
    const sandbox = new CrsiSandbox(sandboxRepo)
    vi.spyOn(sandbox, 'runTests').mockReturnValue({
      passed: true,
      totalTests: 0,
      failedTests: 0,
      output: '',
    })
    const result = await runCrsiModification(
      {
        description: 'safe change',
        filePath: WORKTREE_FILE,
        newContent: 'crsi-modify-test\n',
        blastRadius: [WORKTREE_FILE],
      },
      sandbox,
    )
    expect(result.phase).toBe('passed')
    expect(result.diff).toContain('crsi-modify-test')
    expect(hasPending()).toBe(true)
  })

  it('tests fail → phase failed + auto-rollback (no pending)', async () => {
    const sandbox = new CrsiSandbox(sandboxRepo)
    vi.spyOn(sandbox, 'runTests').mockReturnValue({
      passed: false,
      totalTests: 1,
      failedTests: 1,
      output: '',
    })
    const result = await runCrsiModification(
      {
        description: 'failing',
        filePath: WORKTREE_FILE,
        newContent: '{}',
        blastRadius: [WORKTREE_FILE],
      },
      sandbox,
    )
    expect(result.phase).toBe('failed')
    expect(hasPending()).toBe(false)
  })

  it('rejects a proposal without declared blast radius (完整覆盖闸)', async () => {
    const sandbox = new CrsiSandbox(sandboxRepo)
    const result = await runCrsiModification(
      { description: 'no blast radius', filePath: WORKTREE_FILE, newContent: '{}' },
      sandbox,
    )
    expect(result.phase).toBe('failed')
    expect(result.error).toContain('blast radius')
    expect(hasPending()).toBe(false)
  })

  it('custom rewardFn low score → gate rolls back (regression)', async () => {
    const sandbox = new CrsiSandbox(sandboxRepo)
    vi.spyOn(sandbox, 'runTests').mockReturnValue({
      passed: true,
      totalTests: 0,
      failedTests: 0,
      output: '',
    })
    appendEvalScore('custom-reward', { score: 90, passed: 9, total: 10 })
    const result = await runCrsiModification(
      {
        description: 'regress',
        filePath: WORKTREE_FILE,
        newContent: '{}',
        blastRadius: [WORKTREE_FILE],
      },
      sandbox,
      {
        rewardFn: {
          name: 'custom-reward',
          description: 'test',
          evaluate: () => ({ total: 10, passed: 0, score: 0, failures: ['all'] }),
        },
      },
    )
    expect(result.phase).toBe('failed')
    expect(result.error).toContain('Reward regression')
    expect(hasPending()).toBe(false)
  })

  it('custom rewardFn score >= last → passes (no regression)', async () => {
    const sandbox = new CrsiSandbox(sandboxRepo)
    vi.spyOn(sandbox, 'runTests').mockReturnValue({
      passed: true,
      totalTests: 0,
      failedTests: 0,
      output: '',
    })
    appendEvalScore('custom-reward', { score: 50, passed: 5, total: 10 })
    const result = await runCrsiModification(
      {
        description: 'good',
        filePath: WORKTREE_FILE,
        newContent: '{}',
        blastRadius: [WORKTREE_FILE],
      },
      sandbox,
      {
        rewardFn: {
          name: 'custom-reward',
          description: 'test',
          evaluate: () => ({ total: 10, passed: 8, score: 80, failures: ['a', 'b'] }),
        },
      },
    )
    expect(result.phase).toBe('passed')
    expect(hasPending()).toBe(true)
  })

  // ── GUARD 方向性非回归门（2611.23476） ──
  // 有逐契约历史且契约集合未变时，判定看「收益是否超过回归」而不是标量分数。
  const passTests = (sandbox: CrsiSandbox) =>
    vi.spyOn(sandbox, 'runTests').mockReturnValue({
      passed: true,
      totalTests: 0,
      failedTests: 0,
      output: '',
    })

  const runWith = (sandbox: CrsiSandbox, name: string, results: Array<Record<string, unknown>>) =>
    runCrsiModification(
      {
        description: 'gate',
        filePath: WORKTREE_FILE,
        newContent: '{}',
        blastRadius: [WORKTREE_FILE],
      },
      sandbox,
      {
        rewardFn: {
          name,
          description: 'test',
          evaluate: () => ({
            total: results.length,
            passed: results.filter((r) => r.passed === true).length,
            score: Math.round(
              (results.filter((r) => r.passed === true).length / results.length) * 100,
            ),
            failures: [],
            results: results as never,
          }),
        },
      },
    )

  it('方向性闸：修好 1 条、弄坏 1 条 ⇒ 拒（标量分数同分，旧闸会放行）', async () => {
    const sandbox = new CrsiSandbox(sandboxRepo)
    passTests(sandbox)
    appendEvalScore('dir-equal', {
      score: 50,
      passed: 1,
      total: 2,
      results: [
        { id: 'a', description: 'a', passed: false },
        { id: 'b', description: 'b', passed: true },
      ],
    })
    const result = await runWith(sandbox, 'dir-equal', [
      { id: 'a', description: 'a', passed: true },
      { id: 'b', description: 'b', passed: false },
    ])
    expect(result.phase).toBe('failed')
    expect(result.error).toContain('Directional regret gate')
    expect(result.error).toContain('收益未超过回归')
  })

  it('方向性闸：修好 2 条、弄坏 1 条 ⇒ 放行，并显示两侧读数', async () => {
    const sandbox = new CrsiSandbox(sandboxRepo)
    passTests(sandbox)
    appendEvalScore('dir-gain', {
      score: 33,
      passed: 1,
      total: 3,
      results: [
        { id: 'a', description: 'a', passed: false },
        { id: 'b', description: 'b', passed: true },
        { id: 'c', description: 'c', passed: false },
      ],
    })
    const result = await runWith(sandbox, 'dir-gain', [
      { id: 'a', description: 'a', passed: true },
      { id: 'b', description: 'b', passed: false },
      { id: 'c', description: 'c', passed: true },
    ])
    expect(result.phase).toBe('passed')
    expect(result.regretNote).toBe('新破坏 1 · 新修复 2 · 仍未解决 0')
  })

  it('方向性闸：契约集合变了 ⇒ 退回标量分数闸（分母不可比）', async () => {
    const sandbox = new CrsiSandbox(sandboxRepo)
    passTests(sandbox)
    appendEvalScore('dir-set', {
      score: 100,
      passed: 1,
      total: 1,
      results: [{ id: 'a', description: 'a', passed: true }],
    })
    const result = await runWith(sandbox, 'dir-set', [
      { id: 'a', description: 'a', passed: true },
      { id: 'new', description: 'new', passed: false },
    ])
    expect(result.phase).toBe('failed')
    expect(result.error).toContain('Reward regression')
    expect(result.error).not.toContain('Directional regret')
  })

  it('方向性闸：只有新修复、零新破坏 ⇒ 放行且不误报回归', async () => {
    const sandbox = new CrsiSandbox(sandboxRepo)
    passTests(sandbox)
    appendEvalScore('dir-fix', {
      score: 50,
      passed: 1,
      total: 2,
      results: [
        { id: 'a', description: 'a', passed: false },
        { id: 'b', description: 'b', passed: true },
      ],
    })
    const result = await runWith(sandbox, 'dir-fix', [
      { id: 'a', description: 'a', passed: true },
      { id: 'b', description: 'b', passed: true },
    ])
    expect(result.phase).toBe('passed')
    expect(result.regretNote).toBe('新破坏 0 · 新修复 1 · 仍未解决 0')
  })

  it('anchor regression rejects even when aggregate score does not drop', async () => {
    const sandbox = new CrsiSandbox(sandboxRepo)
    vi.spyOn(sandbox, 'runTests').mockReturnValue({
      passed: true,
      totalTests: 0,
      failedTests: 0,
      output: '',
    })
    const result = await runCrsiModification(
      {
        description: 'anchor-break',
        filePath: WORKTREE_FILE,
        newContent: '{}',
        blastRadius: [WORKTREE_FILE],
      },
      sandbox,
      {
        rewardFn: {
          name: 'anchor-test',
          description: 'test',
          evaluate: () => ({
            total: 2,
            passed: 1,
            score: 50,
            failures: [],
            results: [
              { id: 'constitution-facets', description: 'x', passed: false, role: 'anchor' },
              { id: 'other', description: 'x', passed: true },
            ],
          }),
        },
      },
    )
    expect(result.phase).toBe('failed')
    expect(result.error).toContain('Anchor regression')
    expect(hasPending()).toBe(false)
  })

  it('合并型净增被 fail-closed 拒绝，且不创建 worktree（收敛闸）', async () => {
    const sandbox = new CrsiSandbox(sandboxRepo)
    const spy = vi.spyOn(sandbox, 'createWorktree')
    const result = await runCrsiModification(
      {
        description: 'grow',
        filePath: LESSONS_FILE,
        originalContent: '## a: 1\n',
        newContent: '## a: 1\n\n## b: 2\n',
        blastRadius: [LESSONS_FILE],
        merge: true,
      },
      sandbox,
    )
    expect(result.applied).toBe(false)
    expect(result.phase).toBe('failed')
    expect(result.error).toContain('必须收敛')
    // 闸的位置由 spy 钉住：createWorktree 一次都没被调用 ⇒ 零副作用。
    // getDiff() 返回 '' 只是 worktreePath 未设的结果 —— 建了再 removeWorktree 回滚
    // 也会把它置回 undefined，两种情形同样为 '' ⇒ 它不证据位置，别拿它当判据。
    expect(spy).not.toHaveBeenCalled()
    expect(sandbox.getDiff()).toBe('')
  })
})

describe('pending registry', () => {
  it('approve/reject with no pending returns failure', () => {
    expect(approvePending().success).toBe(false)
    expect(rejectPending().success).toBe(false)
  })

  it('reject clears pending after a passed modification', async () => {
    const sandbox = new CrsiSandbox(sandboxRepo)
    vi.spyOn(sandbox, 'runTests').mockReturnValue({
      passed: true,
      totalTests: 0,
      failedTests: 0,
      output: '',
    })
    await runCrsiModification(
      {
        description: 'pending',
        filePath: WORKTREE_FILE,
        newContent: 'pending-test\n',
        blastRadius: [WORKTREE_FILE],
      },
      sandbox,
    )
    expect(hasPending()).toBe(true)
    const r = rejectPending()
    expect(r.success).toBe(true)
    expect(hasPending()).toBe(false)
  })
})

describe('CrsiProposal ε 字段（类型面）', () => {
  it('expectedEffect / risk / merge 均为可选，缺席时对象仍合法', () => {
    const bare: CrsiProposal = {
      description: 'd',
      filePath: 'apps/cli/src/foo.ts',
      newContent: 'x',
      blastRadius: ['apps/cli/src/foo.ts'],
    }
    expect(bare.expectedEffect).toBeUndefined()
    const full: CrsiProposal = { ...bare, expectedEffect: 12, risk: '可能变慢' }
    expect(full.expectedEffect).toBe(12)
    expect(full.risk).toBe('可能变慢')
    const merged: CrsiProposal = { ...bare, merge: true }
    expect(merged.merge).toBe(true)
  })
})

// 判据自身可信：`evaluate()` 出事时**不得**被当成「候选变差了」。
// 三态区分：判了它差 / 判了它好 / **没能判**。第三态此前不存在 ——
// 抛错会穿出本函数（worktree 不回收），残缺报告会被当成退化。
describe('量具不可用时不得记成「判它差」', () => {
  const okTests = (sandbox: CrsiSandbox) =>
    vi.spyOn(sandbox, 'runTests').mockReturnValue({
      passed: true,
      totalTests: 0,
      failedTests: 0,
      output: '',
    })

  const run = (sandbox: CrsiSandbox, evaluate: () => never | unknown, minContracts?: number) =>
    runCrsiModification(
      {
        description: 'x',
        filePath: WORKTREE_FILE,
        newContent: '{}',
        blastRadius: [WORKTREE_FILE],
      },
      sandbox,
      {
        rewardFn: {
          name: 'broken',
          description: 'test',
          minContracts,
          evaluate: evaluate as never,
        },
      },
    )

  it('evaluate 抛错 ⇒ 不抛出、回滚、明说 Harness unavailable（今天这条路径会穿出去且不回收 worktree）', async () => {
    const sandbox = new CrsiSandbox(sandboxRepo)
    okTests(sandbox)
    const rollback = vi.spyOn(sandbox, 'rollback')

    const result = await run(sandbox, () => {
      throw new Error('sandbox 进程被 killed')
    })

    expect(result.phase).toBe('failed')
    expect(result.error).toContain('Harness unavailable')
    expect(result.error).toContain('sandbox 进程被 killed')
    // 关键措辞：不得把量具故障说成候选缺陷。
    expect(result.error).not.toContain('Reward regression')
    expect(rollback).toHaveBeenCalled()
    expect(hasPending()).toBe(false)
  })

  it('契约集为空 ⇒ Harness unavailable（该情形 score 恰为 100，会被当成满分放行）', async () => {
    const sandbox = new CrsiSandbox(sandboxRepo)
    okTests(sandbox)
    const rollback = vi.spyOn(sandbox, 'rollback')

    const result = await run(sandbox, () => ({
      total: 0,
      passed: 0,
      score: 100,
      failures: [],
      results: [],
    }))

    expect(result.phase).toBe('failed')
    expect(result.error).toContain('Harness unavailable')
    expect(rollback).toHaveBeenCalled()
    expect(hasPending()).toBe(false)
  })

  const tinyResults = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `c${i}`, description: 'x', passed: true }))

  it('声明的下限没跑满 ⇒ Harness unavailable（量具缩水读作「全绿」）', async () => {
    const sandbox = new CrsiSandbox(sandboxRepo)
    okTests(sandbox)
    const n = 3
    const result = await run(
      sandbox,
      () => ({ total: n, passed: n, score: 100, failures: [], results: tinyResults(n) }),
      40,
    )
    expect(result.phase).toBe('failed')
    expect(result.error).toContain('Harness unavailable')
    expect(result.error).toContain('40')
    expect(hasPending()).toBe(false)
  })

  it('未声明下限的奖励源报少量契约 ⇒ 不判量具故障（下限是电池主人的主张，不能强加给可插拔奖励源）', async () => {
    const sandbox = new CrsiSandbox(sandboxRepo)
    okTests(sandbox)
    const n = 2
    const result = await run(sandbox, () => ({
      total: n,
      passed: n,
      score: 100,
      failures: [],
      results: tinyResults(n),
    }))
    // 少量契约**不是**量具故障 —— 只是这条奖励源本来就只有两条契约。
    expect(result.phase).toBe('passed')
    expect(result.rewardNote).toBeUndefined()
  })

  it('rewardFn 不提供逐契约结果 ⇒ 过，但明说 anchor 闸未施加（不静默跳过）', async () => {
    const sandbox = new CrsiSandbox(sandboxRepo)
    okTests(sandbox)
    const result = await run(sandbox, () => ({
      total: 10,
      passed: 10,
      score: 100,
      failures: [],
    }))
    expect(result.phase).toBe('passed')
    expect(result.rewardNote).toBeDefined()
    expect(result.rewardNote).toContain('anchor')
    expect(result.rewardNote).toContain('broken')
  })

  it('正对照：正常量具路径不产生 rewardNote', async () => {
    const sandbox = new CrsiSandbox(sandboxRepo)
    okTests(sandbox)
    const result = await runCrsiModification(
      { description: 'x', filePath: WORKTREE_FILE, newContent: '{}', blastRadius: [WORKTREE_FILE] },
      sandbox,
      {
        rewardFn: {
          name: 'healthy',
          description: 'test',
          evaluate: () => runEval(),
        },
      },
    )
    expect(result.phase).toBe('passed')
    expect(result.rewardNote).toBeUndefined()
  })
})
