import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '../../src/shared'
import { exitWorktreeTool } from '../../src/tools/exec/exit-worktree'
import { enterWorktreeTool } from '../../src/tools/exec/enter-worktree'

// ============================================================
// ExitWorktree / EnterWorktree 的「这个 worktree 到底在不在」判定。
//
// 两处原先都是 `listOutput.includes(<路径>)` —— **子串**判定。本机用真 git 量过
// （建出 `w1` 与 `w10` 两个 worktree，逐字看 `git worktree list --porcelain`），
// 它错在三个方向：
//
//   1. `.../w1` 会命中 **`.../w10` 那一行**（前缀被当成了同一个工作树）
//      ⇒ 不存在的工作树被判成存在。EnterWorktree 那侧因此**永远建不出 `w1`**：
//      在 `w10` 存在时它报「already exists」并提前返回。
//   2. 带尾斜杠的 `.../w1/` 一行都不命中 ⇒ 存在的工作树被判成 not found。
//   3. git 打印的是 **realpath 拼法**：本机 `mktemp -d /tmp/x` 建的工作树，
//      porcelain 里逐字是 `/private/tmp/x/...`。于是**别名拼法**（`/tmp/x/...`）
//      一头都命中不了 —— 而 EnterWorktree 的成功文案里印的正是它自己算出来的
//      那个拼法，模型照着传回来就必然吃 not found。
//
// 另外 ExitWorktree 的 containment 闸拿 `resolve(worktreePath)`（**单参数**）算
// 归一化路径，基数因此是 `process.cwd()`；而同一函数里每一个 `Bun.spawn` 都带
// `cwd: ctx.cwd`。校验看的是 A 对象、执行动的是 B 对象。
// ============================================================

const ctx = (cwd: string): ToolContext => ({
  cwd,
  sessionId: 'test-session',
  provider: 'test',
  model: 'test-model',
})

const streamOf = (text: string) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new TextEncoder().encode(text))
      c.close()
    },
  })

/** 假进程：只喂两个工具真正读的字段；每次 spawn 一个**新**假进程（流不可复用）。 */
const mockProc = (stdout: string, exitCode = 0) => ({
  stdout: streamOf(stdout),
  stderr: streamOf(''),
  exited: Promise.resolve(exitCode),
  kill: vi.fn(),
})

const mockSpawn = (stdout: string, exitCode = 0) =>
  vi.spyOn(Bun, 'spawn').mockImplementation((() => mockProc(stdout, exitCode)) as never)

const lastArgv = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls[spy.mock.calls.length - 1]![0] as string[]

/** `git worktree list --porcelain` 的形状（实测：每条 `worktree <path>` 起头）。 */
const porcelain = (paths: string[]): string =>
  paths
    .map(
      (p) => `worktree ${p}\nHEAD 7c28f5f5219daf237a099f4d42af781a6d9a2f5e\nbranch refs/heads/x\n`,
    )
    .join('\n')

/** 真实存在的工作树目录 —— 让两侧的 realpath 规范化有东西可规范化。 */
function makeProject(): { root: string; wt: (name: string) => string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mipham-e8-')))
  const wtRoot = join(root, '.mipham', 'worktrees')
  mkdirSync(wtRoot, { recursive: true })
  return { root, wt: (name) => join(wtRoot, name) }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('「按名字」判定，不按子串', () => {
  it('同名前缀（w1 vs w10）不算已存在 —— ExitWorktree', async () => {
    const { root, wt } = makeProject()
    mkdirSync(wt('w10'))
    mockSpawn(porcelain([wt('w10')]))

    const result = await exitWorktreeTool.execute({ path: wt('w1'), action: 'keep' }, ctx(root))

    expect(result.success).toBe(false)
    expect(result.error).toContain('not found')
  })

  it('反方向：带尾斜杠的路径照旧找得到', async () => {
    const { root, wt } = makeProject()
    mkdirSync(wt('w10'))
    mockSpawn(porcelain([wt('w10')]))

    const result = await exitWorktreeTool.execute(
      { path: wt('w10') + '/', action: 'keep' },
      ctx(root),
    )

    expect(result.success).toBe(true)
  })

  it('别名拼法（symlink 形态的 /tmp vs /private/tmp）照旧找得到', async () => {
    const { root, wt } = makeProject()
    mkdirSync(wt('w2'))
    const aliasRoot = join(tmpdir(), `mipham-e8-alias-${process.pid}`)
    symlinkSync(root, aliasRoot)
    // git 打印 real 拼法 —— 与实测的 `/private/tmp/...` 同形。
    mockSpawn(porcelain([wt('w2')]))

    const result = await exitWorktreeTool.execute(
      { path: join(aliasRoot, '.mipham', 'worktrees', 'w2'), action: 'keep' },
      ctx(aliasRoot),
    )

    expect(result.success).toBe(true)
  })

  it('EnterWorktree 同族：w10 存在时 w1 仍能建出来', async () => {
    const { root, wt } = makeProject()
    mkdirSync(wt('w10'))
    const spawnSpy = mockSpawn(porcelain([wt('w10')]))

    const result = await enterWorktreeTool.execute({ name: 'w1', baseRef: 'HEAD' }, ctx(root))

    expect(result.content).not.toContain('Already Exists')
    expect(lastArgv(spawnSpy).slice(0, 5)).toEqual(['git', 'worktree', 'add', '-b', 'worktree/w1'])
  })

  it('反方向：真在列表里的照旧报「已存在」，不重复建', async () => {
    const { root, wt } = makeProject()
    mkdirSync(wt('w1'))
    mockSpawn(porcelain([wt('w1')]))

    const result = await enterWorktreeTool.execute({ name: 'w1', baseRef: 'HEAD' }, ctx(root))

    expect(result.content).toContain('Already Exists')
  })
})

describe('校验与执行同一个基数（都是 ctx.cwd）', () => {
  it('相对路径按 ctx.cwd 归一化，不按 process.cwd()', async () => {
    const { root, wt } = makeProject()
    mkdirSync(wt('w1'))
    mockSpawn(porcelain([wt('w1')]))
    // 前置自检：本进程的 cwd 必须**不在**这个临时项目里，否则下面绿得毫无意义
    // （单参数 resolve 恰好也会算对）——「检查必须能失败」。
    expect(process.cwd().startsWith(root)).toBe(false)

    const result = await exitWorktreeTool.execute(
      { path: join('.mipham', 'worktrees', 'w1'), action: 'keep' },
      ctx(root),
    )

    expect(result.error ?? '').not.toContain('is not under')
    expect(result.success).toBe(true)
  })
})
