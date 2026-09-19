import { describe, it, expect, vi, afterEach } from 'vitest'
import { resolve } from 'node:path'
import type { ToolContext } from '../../src/shared'
import { enterWorktreeTool } from '../../src/tools/exec/enter-worktree'
import { worktreeRoot } from '../../src/core/paths'

const ctx: ToolContext = {
  cwd: '/tmp/test',
  sessionId: 'test-session',
  provider: 'test',
  model: 'test-model',
}

/** 假进程：只喂 enter-worktree 真正读的三个字段。 */
function mockProc(exitCode = 0) {
  return {
    stdout: new ReadableStream<Uint8Array>({
      start(c) {
        c.close()
      },
    }),
    stderr: new ReadableStream<Uint8Array>({
      start(c) {
        c.close()
      },
    }),
    exited: Promise.resolve(exitCode),
    kill: vi.fn(),
  }
}

/**
 * 每次 spawn 一个**新**假进程。共用一个会让第二次读撞上已经消费掉的流
 * （`Response body object should not be disturbed or locked`），而那是替身的毛病、
 * 不是被测代码的毛病 —— 判据会因此说谎。
 */
function mockSpawn(exitCode = 0) {
  return vi.spyOn(Bun, 'spawn').mockImplementation((() => mockProc(exitCode)) as never)
}

/** 取**最后**一条 spawn 的 argv —— 前面还有 `rev-parse --git-dir` 与 `worktree list`。 */
const lastArgv = (spy: { mock: { calls: unknown[][] } }): string[] =>
  spy.mock.calls[spy.mock.calls.length - 1]![0] as string[]

afterEach(() => {
  vi.restoreAllMocks()
})

// ============================================================
// EnterWorktree 把**模型给的** `baseRef` 直接拼进 git 的 argv。
//
// `baseRef` 没有校验，落进 git 的**选项命名空间**。本机实测：
// `git worktree add -b wt/a <path> --force` 建出来了（exit 0），而同样位置放一个
// 不存在的 ref 是 `fatal: invalid reference` —— 可见 `--force` 是被当成**选项**吃掉的，
// 不是当成 ref。于是「从哪儿开始建」这件事由调用方决定。
//
// 判据取 argv（git 实际拿到的东西），不是错误文案：E4 的注释已经把理由写死了 ——
// 按**拼写**写的守卫总有缝，argv 才是 git 收到的那个。本机的真 git 也实测过 `--` 之后
// `--force` 会被当成 ref 而失败（`fatal: invalid reference: --force`），即 `--` 确实
// 关掉了这个命名空间。
//
// 另两条是**既有**行为的回归守卫，不是本轮的修复（写之前先跑，它们本来就是绿的）：
// `name` 走绝对路径时已经有一道 containment 闸（`enter-worktree.ts` 的
// "Worktree path must be within .mipham/worktrees/"），多段名也照常落在根之下。
// ============================================================
describe('EnterWorktree 的参数闸门', () => {
  it('baseRef 用 `--` 隔开，落不进 git 的选项命名空间', async () => {
    const spawnSpy = mockSpawn()

    await enterWorktreeTool.execute({ name: 'feature', baseRef: '--force' }, ctx)

    const argv = lastArgv(spawnSpy)
    expect(argv.slice(0, 6)).toEqual([
      'git',
      'worktree',
      'add',
      '-b',
      'worktree/feature',
      expect.any(String),
    ])
    expect(argv[6]).toBe('--')
    expect(argv[7]).toBe('--force')
  })

  it('反方向：正常的 baseRef 照常传下去（没有把 ref 一并堵死）', async () => {
    const spawnSpy = mockSpawn()

    const result = await enterWorktreeTool.execute({ name: 'feature', baseRef: 'origin/main' }, ctx)

    const argv = lastArgv(spawnSpy)
    expect(argv[6]).toBe('--')
    expect(argv[7]).toBe('origin/main')
    expect(result.success).toBe(true)
  })

  it('name 是绝对路径时拒绝，git 一次都不跑', async () => {
    const spawnSpy = mockSpawn()

    const result = await enterWorktreeTool.execute({ name: '/tmp/evil' }, ctx)

    expect(result.success).toBe(false)
    expect(spawnSpy).not.toHaveBeenCalled()
  })

  it('反方向：多段 name 仍落在 worktrees 根之下', async () => {
    const spawnSpy = mockSpawn()

    await enterWorktreeTool.execute({ name: 'feature/sub', baseRef: 'HEAD' }, ctx)

    // baseRef 默认 HEAD ⇒ 先 rev-parse 再 worktree add，取最后一条。
    const argv = lastArgv(spawnSpy)
    expect(argv[5]).toBe(resolve(worktreeRoot(ctx.cwd), 'feature/sub'))
    expect(argv[5]!.startsWith(resolve(worktreeRoot(ctx.cwd)))).toBe(true)
  })
})
