import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * `/fork` 建 worktree 时**不许经过 shell**。
 *
 * 原形是 `execSync(`git worktree add -b ${branch} ${wtPath} HEAD`)` —— branch 与 wtPath
 * 被插进一条 shell 字符串里，没有任何引号。路径里一个空格或 shell 元字符就会让 git
 * 只拿到路径的前半截、或让后半截被当成命令执行。改成 `execFileSync('git', [...])`
 * 后 argv 是**构造上**没有引号问题的：路径永远是数组里独立的一个元素，无论它长什么样。
 *
 * 判据落在这里：调用形状必须是 (string, string[])，且那条命令是 `worktree add`，且
 * **没有任何一次 execSync 收到过含 "worktree add" 的字符串**。失败路径的清理
 * （`worktree remove` / `branch -D`）用同一对值，同一类缺陷，一并钉住。
 */

const h = vi.hoisted(() => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn((_task: string, _kind: string, executor: (s: AbortSignal) => Promise<string>) => {
    h.executor = executor
    return 'bg-1'
  }),
  executor: null as null | ((s: AbortSignal) => Promise<string>),
}))

// 后台执行器里的子代理会真去调模型 —— 这一段只测「提交/推送」，换掉那一条支路。
vi.mock('../../src/agent/sub-agent', () => ({
  SubAgent: class {
    async execute() {
      return 'work done'
    }
  },
}))

// 展开真模块再覆盖两个同步执行器 —— commands.ts 的其它 import 仍要能拿到 spawn 等。
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execSync: h.execSync,
  execFileSync: h.execFileSync,
}))

// spawn 一被调用就会把 executor 跑起来（SubAgent + LLM）——这里砍掉那一整条支路，
// 让被测的只是「建 worktree」这一段。
vi.mock('../../src/agent/background-registry', () => ({
  getBackgroundAgentRegistry: () => ({ spawn: h.spawn }),
}))

// 与 commands.test.ts 同款隔离：别让真 on-disk session 漏进来。
vi.mock('../../src/core/session-store', () => ({
  SessionStore: {
    getLatest: vi.fn(() => null),
    load: vi.fn(() => null),
    list: vi.fn(() => []),
    delete: vi.fn(() => false),
  },
}))

const { getCommand } = await import('../../src/ui/commands')

const handler = getCommand('/fork')!

function mkForkCtx() {
  const session: Record<string, unknown> = { id: 'fork-1' }
  const agentViewManager = {
    create: vi.fn(() => session),
    addMessage: vi.fn(),
    updateStatus: vi.fn(),
  }
  return {
    engine: {
      getAgentViewManager: () => agentViewManager,
      // 后台执行体会把父会话的消息带进子代理 —— 空历史即可。
      getContext: () => ({ getMessages: () => [] }),
      // SubAgent 已被 mock，它拿到的这几个依赖不参与本组断言。
      getRegistry: () => undefined,
      getTools: () => [],
      getPermission: () => undefined,
      getLlm: () => undefined,
      getSubAgentServices: () => undefined,
    },
    config: { providers: [] },
    providerId: 'test',
    modelId: 'test-model',
    __agentViewManager: agentViewManager,
  } as unknown as Parameters<typeof handler>[0]
}

/**
 * 让 `git status --porcelain` 返回指定内容，并可选地让 commit / push 失败。
 * 其余 git 子命令（worktree add、add -A）成功返回。
 */
function stubGit(
  statusOut: string,
  opts: { commitFails?: boolean; pushFails?: boolean } = {},
): void {
  h.execFileSync.mockImplementation((...callArgs: unknown[]) => {
    const argv = callArgs[1] as string[]
    if (argv[0] === 'status') return statusOut
    if (argv[0] === 'commit' && opts.commitFails) throw new Error('commit boom')
    if (argv[0] === 'push' && opts.pushFails) throw new Error('remote rejected')
    return undefined
  })
}

/** 跑一次 /fork，返回后台执行体的最终摘要。 */
async function runFork(task: string[]): Promise<string> {
  h.executor = null
  await handler(mkForkCtx(), task)
  expect(h.executor, 'spawn 没有拿到后台执行体').not.toBeNull()
  return h.executor!(new AbortController().signal)
}

/** 从 execFileSync 的调用里挑出 argv 以 `head` 打头的那一次。 */
const callWithHead = (...head: string[]) =>
  h.execFileSync.mock.calls.find(
    (c) => c[0] === 'git' && Array.isArray(c[1]) && head.every((t, i) => c[1][i] === t),
  )

beforeEach(() => {
  h.execSync.mockReset()
  h.execFileSync.mockReset()
  // 默认：rev-parse 成功（返回 undefined，不抛）、execFileSync 也成功。
  h.execSync.mockReturnValue(undefined)
  h.execFileSync.mockReturnValue(undefined)
})

describe('/fork 建 worktree 走 argv，不经 shell', () => {
  it("正路：worktree add 是 execFileSync('git', ['worktree','add','-b', branch, wtPath, 'HEAD'])", async () => {
    const res = await handler(mkForkCtx(), ['Refactor', 'the', 'auth', 'module'])
    expect(res.content).toContain('✓ Forked')

    const call = callWithHead('worktree', 'add')
    expect(call, 'worktree add 没有走 execFileSync(argv) —— 还在用 shell 字符串').toBeDefined()
    const argv = call![1] as string[]
    expect(argv[0]).toBe('worktree')
    expect(argv[1]).toBe('add')
    expect(argv[2]).toBe('-b')
    expect(argv[5]).toBe('HEAD')
    // 返回值里报出来的 branch / worktree 就是 argv 里那两个元素（各自独立一个实参）。
    expect(res.content).toContain(`Branch: ${argv[3]}`)
    expect(res.content).toContain(`Worktree: ${argv[4]}`)

    // 负锚：没有任何一次 shell 调用收到过拼好的 worktree add 字符串。
    const shellAdd = h.execSync.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('worktree add'),
    )
    expect(shellAdd, '仍在用 shell 插值拼 worktree add').toBeUndefined()
  })

  it('失败路径：清理的 worktree remove / branch -D 同样走 argv', async () => {
    // 第一次 execFileSync（add）抛 ⇒ 走 catch 里的清理。
    h.execFileSync.mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const res = await handler(mkForkCtx(), ['a'])
    expect(res.content).toContain('Worktree creation failed')

    expect(callWithHead('worktree', 'remove'), 'cleanup remove 仍走 shell').toBeDefined()
    expect(callWithHead('branch', '-D'), 'cleanup branch -D 仍走 shell').toBeDefined()
    const shellCleanup = h.execSync.mock.calls.find(
      (c) =>
        typeof c[0] === 'string' &&
        (c[0].includes('worktree remove') || c[0].includes('branch -D')),
    )
    expect(shellCleanup, 'cleanup 仍在用 shell 插值').toBeUndefined()
  })
})

/**
 * 跑完之后那一段（add / status / commit / push）同样不许经过 shell ——
 * 它当时插值的是 **wtPath**（由 cwd 派生）和 **prompt**（用户敲的字），
 * 比 worktree add 那一段更危险；而且它把所有失败都吞进 `catch {}`，
 * 摘要一律写「Fork done」，于是「没提交」和「推失败」与成功长得一模一样。
 */
describe('/fork 完成后的提交/推送：argv + 如实报告', () => {
  it('提交与推送走 execFileSync(argv)，cwd 是 worktree，且没有任何 shell 字符串含任务文本/路径', async () => {
    stubGit(' M src/x.ts\n')
    const task = ['Add', 'validation', '$(touch /tmp/pwned)']
    const summary = await runFork(task)

    const commit = callWithHead('commit', '-m')
    expect(commit, 'commit 没有走 execFileSync(argv)').toBeDefined()
    expect((commit![2] as Record<string, unknown>).cwd).toBeTruthy()

    const push = callWithHead('push', 'origin')
    expect(push, 'push 没有走 execFileSync(argv)').toBeDefined()
    expect(push![1]).toEqual(['push', 'origin', expect.stringMatching(/^worktree\//)])

    // 负锚：没有任何一次 shell 调用收到过拼好的 commit / push 字符串，
    // 也没有任何 shell 字符串含用户文本或 worktree 路径。
    const shellCommitPush = h.execSync.mock.calls.find(
      (c) => typeof c[0] === 'string' && (c[0].includes('git commit') || c[0].includes('git push')),
    )
    expect(shellCommitPush, '提交/推送仍在用 shell 插值').toBeUndefined()
    const shellWithTask = h.execSync.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('touch /tmp/pwned'),
    )
    expect(shellWithTask, '用户任务文本进了 shell').toBeUndefined()

    expect(summary).toContain('Committed and pushed')
  })

  it('工作树干净 ⇒ 明说「没有改动」，而不是含糊地报完成', async () => {
    stubGit('')
    const summary = await runFork(['noop'])
    expect(summary).toContain('No changes to commit.')
    expect(summary).not.toContain('Committed and pushed')
    expect(callWithHead('commit', '-m'), '干净的工作树不该提交').toBeUndefined()
  })

  it('推送被拒 ⇒ 摘要如实说失败，并指出提交还留在本地', async () => {
    stubGit(' M a.ts\n', { pushFails: true })
    const summary = await runFork(['push', 'will', 'fail'])
    expect(summary).toContain('**push failed**')
    expect(summary).toContain('Committed locally')
    expect(summary).toContain('push it yourself')
    expect(summary).not.toContain('Committed and pushed')
  })

  it('提交本身失败 ⇒ 摘要如实说自动提交失败', async () => {
    stubGit(' M a.ts\n', { commitFails: true })
    const summary = await runFork(['commit', 'will', 'fail'])
    expect(summary).toContain('**Auto-commit failed**')
    expect(summary).toContain('Changes are uncommitted')
    expect(summary).not.toContain('Committed and pushed')
  })
})
