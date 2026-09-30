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
 * ## 第二半（2026-09-30 续）：命令自己带着根
 *
 * 上面这半条闸拦的是「拿副本目录当根来构造」。可真正漏的那次，沙箱是拿**合法根**
 * 构造的 —— 漏在**变异体**上：`ObjectLiteral` 把 `execSync(cmd, { cwd, timeout, … })`
 * 的整个字面量换成 `{}`，`cwd` 随之消失，子进程落回 `process.cwd()`（= 那个副本目录）
 * ⇒ 每条 git 命令都上溯到外面那棵真仓库。**构造函数那道闸看不见这件事**，它校验的
 * `repoRoot` 一直是合法的。
 *
 * 于是修法把「在哪儿」写进**命令字符串本身**（`git -C <root>` / `cd <root> &&`），
 * 并收成唯一出口 `runIn()`。这条性质**没法用行为测试钉住** —— 不施加变异的话，
 * `cwd:` 本来就是对的，行为测试改前改后都绿（本仓库为这种「改前改后都绿」付过学费：
 * `ink-testing-library` 那格）。所以这里分两段：
 *   · 静态段钉**形状**（对象字面量被抹掉也动不了的那一半）；
 *   · 行为段钉**形状真的管用**（`-C` 的参数序与引号对不对 —— 纯文本扫描看不出来）。
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
/** 某个仓库的分支名集合。 */
const branchSet = (repo: string = OUTER) =>
  git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], repo)
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

// ─────────────────────────────────────────────────────────────────────────────
// 第二半：命令自己带着根（见文件头）
// ─────────────────────────────────────────────────────────────────────────────

const SRC_PATH = join(import.meta.dirname, '..', '..', 'src', 'core', 'crsi-sandbox.ts')

/** 源码里 `execSync(` 的**裸行数** —— 正则漏解析的那些靠它现形（正对照的判据本身）。 */
const countExecSyncLines = (src: string) =>
  src.split('\n').filter((l) => l.includes('execSync(')).length

/** runIn 里把根写进字符串的两条串。写成普通字符串：模板字面量会把 `${…}` 求值掉。 */
const GIT_ROOTED = '`git -C ${shq(root)} ${cmd.slice(4)}`'
const CD_ROOTED = '`cd ${shq(root)} && ${cmd}`'

/**
 * 形状判据 —— 收成纯函数，是为了能拿**故意改坏的文本**反过来喂它一把
 * （只在真源码上断言的话，「这条判据会不会红」是没人验过的）。
 */
function shapeProblems(src: string): string[] {
  const problems: string[] = []
  const bare = countExecSyncLines(src)
  if (bare === 0) problems.push(`源码里一处 execSync( 都没有 —— 下面的断言会全部空转`)
  if (bare !== 1) problems.push(`execSync( 出现在 ${bare} 行；应当是 1 行（只有 runIn 里那一处）`)
  if (!src.includes(GIT_ROOTED)) problems.push(`runIn 未把 -C 写进 git 子命令的字符串里`)
  if (!src.includes(CD_ROOTED)) problems.push(`runIn 未把 cd 写进非 git 命令的字符串里`)
  return problems
}

describe('CRSI 沙箱：目标仓库写在命令字符串里（变异体抹不掉）', () => {
  const SRC = readFileSync(SRC_PATH, 'utf-8')

  it('地形自证：源码在、且 execSync 确实存在（否则下面的断言全是空转）', () => {
    expect(SRC.length).toBeGreaterThan(0)
    expect(countExecSyncLines(SRC)).toBeGreaterThan(0)
    // 前提没变才谈得上「唯一出口」：runIn 还在，且仍被调用。
    expect(SRC).toContain('function runIn(')
    expect(SRC.split('\n').filter((l) => l.includes('runIn(')).length).toBeGreaterThan(1)
  })

  it('形状：runIn 是唯一的 execSync 出口，且根在字符串里', () => {
    expect(shapeProblems(SRC)).toEqual([])
  })

  it('反向对照：把 -C 撤掉 / 绕过 runIn 另开一处 execSync —— 判据都要报红', () => {
    // 若不报红，上面那条「全部合规」就是个仪式（它没有能力失败）。
    const demotedGit = SRC.replace(GIT_ROOTED, '`${cmd}`')
    expect(demotedGit).not.toBe(SRC) // 前件成立：替换真的发生了
    expect(shapeProblems(demotedGit)).toContain('runIn 未把 -C 写进 git 子命令的字符串里')

    const demotedCd = SRC.replace(CD_ROOTED, '`${cmd}`')
    expect(demotedCd).not.toBe(SRC)
    expect(shapeProblems(demotedCd)).toContain('runIn 未把 cd 写进非 git 命令的字符串里')

    // 绕过出口：另起一处直接 execSync（正是这次泄漏的写法）。
    const bypassed = `${SRC}\nexport const _x = () => execSync('git status', { cwd: '/x' })\n`
    expect(shapeProblems(bypassed)).toContain(
      `execSync( 出现在 2 行；应当是 1 行（只有 runIn 里那一处）`,
    )
  })

  it('行为：process.cwd() 是**另一棵真有 .git 的仓库**时，沙箱照样只动交给它的那棵', () => {
    // 为什么这半条不可省：静态段只证明「字符串长得对」，证明不了 `git -C '<path>'`
    // 的参数序与引号真的成立（写成 `-c`、或把 `-C` 放到子命令之后，文本判据都看不出来）。
    // 诱饵**带 .git**，比 Stryker 那个沙箱更强（那里连 .git 都没有）。
    const decoy = realpathSync(mkdtempSync(join(tmpdir(), 'crsi-guard-decoy-')))
    git(['init', '-q'], decoy)
    git(['config', 'user.email', 'crsi-guard@test.invalid'], decoy)
    git(['config', 'user.name', 'crsi-guard-test'], decoy)
    git(['config', 'commit.gpgsign', 'false'], decoy)
    writeFileSync(join(decoy, 'decoy.txt'), 'decoy\n')
    git(['add', '-A'], decoy)
    git(['commit', '-q', '-m', 'decoy'], decoy)
    const decoyBranches = () => branchSet(decoy)

    const cwdBefore = process.cwd()
    const decoyBefore = decoyBranches()
    try {
      process.chdir(decoy)
      // 前件自证：chdir 真的生效了（否则这条测试测的还是 OUTER，白跑）。
      expect(realpathSync(process.cwd())).toBe(decoy)

      const sandbox = new CrsiSandbox(OUTER)
      sandbox.createWorktree()
      expect(worktreeCount()).toBe(2) // 交给它的那棵：长出了工作树
      expect(decoyBranches()).toEqual(decoyBefore) // 诱饵：零痕迹
      sandbox.removeWorktree()
    } finally {
      process.chdir(cwdBefore)
      rmSync(decoy, { recursive: true, force: true })
    }
    expect(branchSet()).toEqual(BASELINE_BRANCHES)
  })
})
