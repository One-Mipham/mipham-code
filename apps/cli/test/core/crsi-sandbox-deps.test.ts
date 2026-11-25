/**
 * `runTests()` 的依赖供应（2026-11-25 实测缺口）。
 *
 * 沙箱的 worktree 是 `git worktree add … HEAD` 的**干净检出** —— 没有 `node_modules`。
 * 此前 `runTests()` 直接跑 `pnpm test`，在真仓库上实测 **1 秒**即以
 * `sh: vitest: command not found` 失败（`ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL`），
 * 于是 `/crsi modify` 的每一次真实修改都停在 phase failed。
 *
 * 这里只钉**形状**（先装依赖、再跑套件、装不上就不跑套件），不真跑 pnpm：
 * 真跑一次全量套件是 49s，而且与这条形状无关。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// hoisted：vi.mock 的工厂会在模块初始化前运行，普通 const 此时还没赋值。
const { mockExecSync } = vi.hoisted(() => ({ mockExecSync: vi.fn() }))

// 只替换 execSync；其余导出保留真身（同 commands.test.ts 的理由）。
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execSync: mockExecSync,
}))

// 报告目录与真 ~/.mipham 隔离。
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-crsi-sandbox-deps`,
  }
})

const { CrsiSandbox } = await import('../../src/core/crsi-sandbox')

let root: string

beforeEach(() => {
  // realpathSync：macOS 的 /var → /private/var，而 git 回的是物理路径。
  root = realpathSync(mkdtempSync(join(tmpdir(), 'crsi-sandbox-deps-')))
  mkdirSync(join(root, 'apps', 'cli'), { recursive: true })
  mockExecSync.mockReset()
  mockExecSync.mockReturnValue(`${root}\n`)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function commands(): string[] {
  return mockExecSync.mock.calls.map((c) => String(c[0]))
}

describe('CrsiSandbox.runTests 依赖供应', () => {
  it('在跑套件之前先在 worktree 里离线安装依赖', () => {
    const sandbox = new CrsiSandbox(root)
    const { worktreePath } = sandbox.createWorktree()

    mockExecSync.mockReturnValue('Tests 1 passed (1)\n')
    const result = sandbox.runTests()

    const cmds = commands()
    const installAt = cmds.findIndex((c) => c.includes('pnpm install'))
    const testAt = cmds.findIndex((c) => c.includes('pnpm test'))

    expect(installAt).toBeGreaterThan(-1)
    expect(testAt).toBeGreaterThan(installAt)
    // 两条命令都必须落在 worktree 里（不是 repoRoot）。
    expect(cmds[installAt]).toContain(worktreePath)
    expect(cmds[testAt]).toContain(worktreePath)
    // 离线 + 锁文件冻结 + 不跑 postinstall：闸里不联网、不改锁文件。
    expect(cmds[installAt]).toContain('--offline')
    expect(cmds[installAt]).toContain('--frozen-lockfile')
    expect(cmds[installAt]).toContain('--ignore-scripts')
    expect(result.passed).toBe(true)
  })

  it('装依赖失败 ⇒ 不跑套件，并把原因写进 output', () => {
    const sandbox = new CrsiSandbox(root)
    sandbox.createWorktree()

    mockExecSync.mockImplementation((cmd: string) => {
      if (String(cmd).includes('pnpm install')) {
        throw Object.assign(new Error('Command failed'), {
          stderr: Buffer.from('ERR_PNPM_NO_OFFLINE_TARBALL  No tarball for vitest@5.0.5'),
        })
      }
      return 'Tests 999 passed (999)\n'
    })
    const result = sandbox.runTests()

    expect(result.passed).toBe(false)
    expect(result.failedTests).toBeGreaterThan(0)
    expect(result.output).toContain('ERR_PNPM_NO_OFFLINE_TARBALL')
    // 关键：依赖没装上时**不能**假装跑过套件（否则一条「全绿」输出会把
    // 「仪器没启动」读成「改动没问题」）。
    expect(commands().some((c) => c.includes('pnpm test'))).toBe(false)
  })
})

const SKILL_FILE = 'apps/cli/skills/standard/safe-coding.SKILL.md'

/**
 * 派生状态：`bundled-skills.ts` 是 skill 文件在磁盘上的**快照**，freshness 测试
 * （`test/tools/skills.test.ts`）逐字比对。于是任何只改 skill 正文的 proposal 都会被
 * 沙箱闸整批打回 —— 2026-11-25 实测：`1 failed | 5305 passed`，唯一失败就是
 * 「snapshot freshness」。而**只有 skill 改动能量化任务表现** ⇒ 测量路径在结构上
 * 死在闸前。闸里要像构建步骤一样先把派生状态对齐（`merge()` 是 `git add -A`，
 * 重生成结果会一起进 diff）。
 */
describe('CrsiSandbox.runTests 派生状态', () => {
  /** 把沙箱 worktree 里的一格文件改成 `content`（先落一份可读的旧内容）。 */
  function applyEdit(
    sandbox: InstanceType<typeof CrsiSandbox>,
    worktreePath: string,
    filePath: string,
    content: string,
  ): void {
    const target = join(worktreePath, filePath)
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, 'old body\n')
    sandbox.applyModification({
      id: 'mod-1',
      description: 'edit',
      filePath,
      newContent: content,
      originalContent: 'old body\n',
      timestamp: new Date().toISOString(),
    })
  }

  it('改动触及 skill 文件 ⇒ 先重生成 bundled 快照，再跑套件', () => {
    const sandbox = new CrsiSandbox(root)
    const { worktreePath } = sandbox.createWorktree()
    applyEdit(sandbox, worktreePath, SKILL_FILE, 'new body\n')

    mockExecSync.mockReturnValue('Tests 1 passed (1)\n')
    const result = sandbox.runTests()

    const cmds = commands()
    const deriveAt = cmds.findIndex((c) => c.includes('generate-bundled-skills.ts'))
    const testAt = cmds.findIndex((c) => c.includes('pnpm test'))
    expect(deriveAt).toBeGreaterThan(-1)
    expect(testAt).toBeGreaterThan(deriveAt)
    expect(result.passed).toBe(true)
  })

  it('非 skill 改动 ⇒ 不重生成（负控：这条命令不该无条件出现）', () => {
    const sandbox = new CrsiSandbox(root)
    const { worktreePath } = sandbox.createWorktree()
    applyEdit(sandbox, worktreePath, 'apps/cli/README.md', 'new readme\n')

    mockExecSync.mockReturnValue('Tests 1 passed (1)\n')
    sandbox.runTests()

    expect(commands().some((c) => c.includes('generate-bundled-skills.ts'))).toBe(false)
  })
})
