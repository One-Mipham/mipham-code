import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn as nodeSpawn, execFileSync } from 'node:child_process'
import { Readable } from 'node:stream'
import type { ToolContext } from '../../src/shared'
import { enterWorktreeTool } from '../../src/tools/exec/enter-worktree'
import { workflowAgent } from '../../src/workflow/primitives/agent'
import { worktreeRoot } from '../../src/core/paths'

const ctx: ToolContext = {
  cwd: '/tmp/test',
  sessionId: 'test-session',
  provider: 'test',
  model: 'test-model',
}

/**
 * 环境里**不带** `GIT_NO_REPLACE_OBJECTS` 的 git 环境 —— 判据要能分清
 * 「我们屏蔽了 replace refs」与「这台机器本来就没设」。
 */
function plainGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  delete env.GIT_NO_REPLACE_OBJECTS
  return env
}

function git(repo: string, args: string[], env: NodeJS.ProcessEnv = plainGitEnv()): string {
  return execFileSync('git', args, { cwd: repo, env, encoding: 'utf-8' })
}

/** 假进程：enter-worktree 读 `stdout` / `stderr` / `exited` / `kill`。 */
function fakeProc(exitCode: number, opts: { hangs?: boolean } = {}) {
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
    exited: opts.hangs ? new Promise<number>(() => {}) : Promise.resolve(exitCode),
    kill: vi.fn(),
  }
}

/** 真子进程的 `Bun.spawn` 替身：令行为测试跑在**真 git** 上，而不是 argv 断言上。 */
function realSpawn(argv: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) {
  const child = nodeSpawn(argv[0]!, argv.slice(1), { cwd: opts.cwd, env: opts.env })
  return {
    stdout: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    stderr: Readable.toWeb(child.stderr) as unknown as ReadableStream<Uint8Array>,
    exited: new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1))),
    kill: () => {
      child.kill()
    },
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// ============================================================
// 隔离边界必须建在**真历史**上。
//
// `git replace <a> <b>` 会让读到 `<a>` 的每一双眼睛看到 `<b>` 的树 —— 包括
// `worktree add`。于是「隔离工作树里跑什么」这件事由仓库里一条本地 ref 决定：
// 任何能写这个仓库的进程都能让隔离区装进别的内容，而调用方以为它拿到的是 HEAD。
//
// 判据取**工作树里的文件内容**，不是 argv、不是有没有 env：本机先量过一次
// 「不屏蔽 ⇒ REAL / 屏蔽 ⇒ HEADCONTENT」，所以下面第一个用例是正对照（证明这个
// 仓库里的 replace ref 真的会改写检出），第二个才是被测对象 —— 没有正对照，
// 第二个用例在 git 忽略 replace 的将来也照样绿，等于没测。
// ============================================================
describe('EnterWorktree 与 replace refs（真 git）', () => {
  it('替身仓库：不屏蔽时同一 HEAD 检出的是被替换的树；屏蔽后 EnterWorktree 检出真 HEAD', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'mipham-replace-'))
    try {
      git(repo, ['init', '-q', '.'])
      git(repo, ['config', 'user.email', 't@t'])
      git(repo, ['config', 'user.name', 't'])

      writeFileSync(join(repo, 'f.txt'), 'REAL\n')
      git(repo, ['add', 'f.txt'])
      git(repo, ['commit', '-qm', 'base'])
      const base = git(repo, ['rev-parse', 'HEAD']).trim()

      writeFileSync(join(repo, 'f.txt'), 'HEADCONTENT\n')
      git(repo, ['commit', '-qam', 'second'])
      const head = git(repo, ['rev-parse', 'HEAD']).trim()

      git(repo, ['replace', head, base])

      // ── 正对照：这台机器上的 replace ref 确实改写检出 ──
      const probe = join(repo, 'plain-probe')
      git(repo, ['worktree', 'add', '-q', '-b', 'wt-plain', probe, '--', 'HEAD'])
      expect(readFileSync(join(probe, 'f.txt'), 'utf-8')).toBe('REAL\n')

      // ── 被测对象：工具建出来的工作树 ──
      const spawnSpy = vi
        .spyOn(Bun, 'spawn')
        .mockImplementation(((argv: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv }) =>
          realSpawn(argv, opts)) as never)

      const result = await enterWorktreeTool.execute(
        { name: 'iso', baseRef: 'HEAD' },
        { ...ctx, cwd: repo },
      )

      expect(result.success).toBe(true)
      expect(readFileSync(join(worktreeRoot(repo), 'iso', 'f.txt'), 'utf-8')).toBe('HEADCONTENT\n')

      // 每条内部 git 都拿得到这个口径（含建工作树的那一条）。
      const envs = spawnSpy.mock.calls.map(
        (call) => (call[1] as { env?: NodeJS.ProcessEnv }).env?.GIT_NO_REPLACE_OBJECTS,
      )
      expect(envs.length).toBeGreaterThan(0)
      expect(envs.every((v) => v === '1')).toBe(true)
    } finally {
      vi.restoreAllMocks()
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

describe('EnterWorktree 的超时', () => {
  it('git worktree add 不退出时，按上限结束并杀掉子进程，而不是挂住工具', async () => {
    vi.useFakeTimers()
    // 只有 `worktree add` 那一条挂住；前面的 `rev-parse` 照常退出 ——
    // 否则工具在更早的一步就等住了，测的就不是这条超时。
    const hanging = fakeProc(0, { hangs: true })
    vi.spyOn(Bun, 'spawn').mockImplementation(((argv: string[]) =>
      argv.includes('worktree') && argv.includes('add') ? hanging : fakeProc(0)) as never)
    const proc = hanging

    const pending = enterWorktreeTool.execute({ name: 'slow' }, ctx)
    await vi.advanceTimersByTimeAsync(60_000)
    const result = await pending

    expect(result.success).toBe(false)
    expect(result.error).toContain('did not finish within 60s')
    expect(proc.kill).toHaveBeenCalled()
  })
})

describe('workflow agent 的工作树隔离', () => {
  it('建工作树时的 git 也屏蔽 replace refs', async () => {
    const spawnSpy = vi.spyOn(Bun, 'spawn').mockImplementation((() => fakeProc(1)) as never)

    await expect(
      workflowAgent('do it', {} as never, new Map(), { isolation: 'worktree' }),
    ).rejects.toThrow(/Worktree creation failed/)

    const [argv, opts] = spawnSpy.mock.calls[0]!
    expect((argv as string[]).slice(0, 3)).toEqual(['git', 'worktree', 'add'])
    expect((opts as { env?: NodeJS.ProcessEnv }).env?.GIT_NO_REPLACE_OBJECTS).toBe('1')
  })

  it('建工作树不退出时同样按上限失败', async () => {
    vi.useFakeTimers()
    const proc = fakeProc(0, { hangs: true })
    vi.spyOn(Bun, 'spawn').mockImplementation((() => proc) as never)

    const pending = workflowAgent('do it', {} as never, new Map(), { isolation: 'worktree' })
    const assertion = expect(pending).rejects.toThrow(/timed out after 60s/)
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
    expect(proc.kill).toHaveBeenCalled()
  })
})
