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
  spawn: vi.fn(() => 'bg-1'),
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
    engine: { getAgentViewManager: () => agentViewManager },
    config: { providers: [] },
    providerId: 'test',
    modelId: 'test-model',
  } as unknown as Parameters<typeof handler>[0]
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
