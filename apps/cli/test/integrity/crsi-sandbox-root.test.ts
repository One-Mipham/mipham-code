import { describe, it, expect, afterAll, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { CrsiSandbox } from '../../src/core/crsi-sandbox'

// 沙箱构造函数会 mkdir `~/.mipham/crsi-sandbox`（REPORT_DIR 在模块作用域求值）
// ⇒ 与其他两个 crsi 测试同一手法：抢在 import 之前把 homedir 接到临时目录。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-crsi-sandbox-root`,
  }
})

/**
 * 守卫：CRSI 沙箱**不得**把改动写进一棵它没有被交给的仓库。
 *
 * 起因（2026-09-30 受控复现）：跑 `pnpm mutate` 会往**真仓库** cherry-pick 一笔提交。
 * 机制是 `CrsiSandbox` 的 `repoRoot` 取 `process.cwd()`，而变异时 cwd 是
 * `apps/cli/.stryker-tmp/sandbox-*` —— 那是 Stryker 有意**不带 `.git`** 的副本目录
 * ⇒ `git worktree add` / `git cherry-pick` / `git branch -D` 全部静默上溯到**外面那棵
 * 真仓库**（现存的 `crsi-sandbox-*` 残留分支就是那次的痕迹）。
 *
 * 本守卫不跑变异，只把**同一个拓扑**缩到最小重现一遍：外层是真仓库的替身，
 * 内层是「不带 `.git` 的副本目录」。为什么它值得单独立在这里 —— **CI 不跑变异，
 * 所以 CI 不会替你发现这件事**；这条链路上此前一个守卫都没有。
 *
 * 本文件自足（同 `tool-reference-integrity.test.ts` 的约定：守卫之间不抽公共模块）。
 */

const OUTER = realpathSync(mkdtempSync(join(tmpdir(), 'crsi-guard-outer-')))
/** 副本目录：形状照抄 `.stryker-tmp/sandbox-<id>`，**没有** `.git`。 */
const INNER = join(OUTER, '.stryker-tmp', 'sandbox-guard')
const OUTER_FILE = 'apps/cli/README.md'
const BARE = realpathSync(mkdtempSync(join(tmpdir(), 'crsi-guard-bare-')))

/** 走 execFileSync 而不是 `execSync('git ' + args)`：`%(…)` 之类的参数会被 /bin/sh 吃掉。 */
function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

mkdirSync(join(OUTER, 'apps', 'cli'), { recursive: true })
writeFileSync(join(OUTER, OUTER_FILE), 'guard fixture body\n')
// `.stryker-tmp` 在真仓库里是 gitignore 的（沙箱是**副本**，不进版本控制）——
// 照抄这一点，否则夹具里的副本会被 `git add -A` 收进夹具自己的提交里。
writeFileSync(join(OUTER, '.gitignore'), '.stryker-tmp/\n')
mkdirSync(join(INNER, 'apps', 'cli'), { recursive: true })
writeFileSync(join(INNER, OUTER_FILE), 'guard fixture body\n') // 副本里也有这个文件

git(['init', '-q'], OUTER)
git(['config', 'user.email', 'crsi-guard@test.invalid'], OUTER)
git(['config', 'user.name', 'crsi-guard-test'], OUTER)
git(['config', 'commit.gpgsign', 'false'], OUTER)
git(['add', '-A'], OUTER)
git(['commit', '-q', '-m', 'fixture'], OUTER)

/** 外层仓库的工作树条目数（含主工作树）。 */
const worktreeCount = () =>
  git(['worktree', 'list', '--porcelain'], OUTER)
    .split('\n')
    .filter((l) => l.startsWith('worktree ')).length
/** 外层仓库的分支名集合。 */
const branchSet = () =>
  git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], OUTER)
    .trim()
    .split('\n')
    .filter(Boolean)
    .sort()
const head = () => git(['rev-parse', 'HEAD'], OUTER).trim()
const outerFileDigest = () =>
  createHash('sha256')
    .update(readFileSync(join(OUTER, OUTER_FILE)))
    .digest('hex')

const BASELINE_BRANCHES = branchSet()
const BASELINE_HEAD = head()
const BASELINE_FILE = outerFileDigest()

afterAll(() => {
  rmSync(OUTER, { recursive: true, force: true })
  rmSync(BARE, { recursive: true, force: true })
})

describe('CRSI 沙箱根：只能是它自己那棵工作树的根', () => {
  it('前提自证：副本目录确实会静默上溯到外层仓库（否则本守卫是空的）', () => {
    // 这一条不是在测沙箱，是在测**地形**：没有它，下面的「拒绝」可能只是因为
    // git 根本不认那个目录，而不是因为形状闸拦住了。
    expect(git(['rev-parse', '--show-toplevel'], INNER).trim()).toBe(OUTER)
    expect(git(['rev-parse', '--show-toplevel'], OUTER).trim()).toBe(OUTER)
    // 上溯的**原因**：副本目录没有自己的 .git，而 git 会往上找。
    // 钉住它，是为了防止哪天有人在夹具里塞个 .git，让整份地形悄悄失效。
    expect(existsSync(join(INNER, '.git'))).toBe(false)
    // git 给副本目录解析出的 git 目录在**它外面** —— 「落在某个仓库里」与
    // 「是自己那棵仓库的根」在这里是两种输入，而 git 只认前者。
    const innerGitDir = git(['rev-parse', '--absolute-git-dir'], INNER).trim()
    expect(innerGitDir.startsWith(INNER)).toBe(false)
  })

  it('正控：自己那棵工作树的根被接受，且沙箱真的在那棵仓库上干活', () => {
    const sandbox = new CrsiSandbox(OUTER)
    expect(worktreeCount()).toBe(1)

    sandbox.createWorktree()
    // 判据探针自证：它**能**看见工作树（没有这一条，下面「拒绝后仍是 1」恒真）。
    expect(worktreeCount()).toBe(2)
    expect(branchSet()).not.toEqual(BASELINE_BRANCHES)

    sandbox.removeWorktree()
    expect(worktreeCount()).toBe(1)
    expect(branchSet()).toEqual(BASELINE_BRANCHES)
  })

  it('拒绝不带 .git 的副本目录，并在消息里点名外层仓库', () => {
    let message = ''
    expect(() => {
      try {
        new CrsiSandbox(INNER)
      } catch (err) {
        message = err instanceof Error ? err.message : String(err)
        throw err
      }
    }).toThrow()
    // 点名外层仓库：只说「被拒」而不说「被谁拦的」，用户没法自处。
    expect(message).toContain(OUTER)
    expect(message).toContain(INNER)
  })

  it('拒绝仓库子目录（同一棵仓库，但不是它的根）', () => {
    expect(() => new CrsiSandbox(join(OUTER, 'apps'))).toThrow()
  })

  it('拒绝根本不在仓库里的目录', () => {
    expect(() => new CrsiSandbox(BARE)).toThrow()
  })

  it('把副本目录当根**去干活**也不行：外层仓库零痕迹（无新工作树 / 无新分支 / HEAD 未动 / 文件未变）', () => {
    // 隔离性断言，不能只手停在「构造被拒」（那只证了入口）。这里照变异时的用法
    // 真去用它一把 —— 能拦在构造函数就拦在那里；万一哪天改成拦在更晚的一步，
    // 这条判据仍然成立，而下面四行才是那个**不变量本身**。
    let sandbox: CrsiSandbox | null = null
    try {
      sandbox = new CrsiSandbox(INNER)
    } catch {
      sandbox = null
    }
    try {
      sandbox?.createWorktree()
    } catch {
      // 被闸拦住 = 预期路径
    }

    expect(worktreeCount()).toBe(1)
    expect(branchSet()).toEqual(BASELINE_BRANCHES)
    expect(head()).toBe(BASELINE_HEAD)
    expect(outerFileDigest()).toBe(BASELINE_FILE)
  })
})
