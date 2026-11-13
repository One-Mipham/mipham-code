import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * `/changelog` 不许把 tag 名送进 shell。
 *
 * tag 是**仓库可控数据**：clone 一个恶意仓库，里面可以有 `v1$(touch /tmp/pwned)`。
 * 原实现把 `${tag}` 拼进 `execSync` 的 shell 字符串，于是跑一次 `/changelog` 就执行了
 * 那一段。判据：tag 名必须以**独立的 argv 元素**到达 `execFileSync`，且没有任何一次
 * `execSync` 收到过含 tag 的字符串。
 *
 * 同一处还做了 `| head -8` —— 那也是一层 shell。窗口改成本 JS 的 `slice(0, 8)`。
 */

const h = vi.hoisted(() => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}))

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execSync: h.execSync,
  execFileSync: h.execFileSync,
}))

const { getCommand } = await import('../../src/ui/commands')

const handler = getCommand('/changelog')!

const EVIL = 'v1$(touch${IFS}/tmp/pwned)'

function mkCtx() {
  return { version: '0.0.1', config: {} } as unknown as Parameters<typeof handler>[0]
}

beforeEach(() => {
  h.execSync.mockReset()
  h.execFileSync.mockReset()
})

describe('/changelog 读 tag 与 log 走 argv', () => {
  it('tag 名原样作为 argv 元素，绝不进入 shell 字符串', async () => {
    h.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'tag') return `${EVIL}\nv0.0.2\nv0.0.1\n`
      return 'feat: something\nfix: another\n'
    })

    const res = await handler(mkCtx(), [])
    expect(res.content).toContain('v0.0.2')

    // 有且只有 tag/log 两类 git 调用，全部是 argv 形态。
    expect(h.execFileSync).toHaveBeenCalled()
    for (const call of h.execFileSync.mock.calls) {
      expect(call[0]).toBe('git')
      expect(Array.isArray(call[1])).toBe(true)
    }

    // 恶意 tag 作为 `A..B` 的**一个**元素出现，不被拆、不被解释。
    const logCall = h.execFileSync.mock.calls.find((c) => c[1][0] === 'log')
    expect(logCall).toBeDefined()
    const argv = logCall![1] as string[]
    expect(argv.some((a) => a.includes(EVIL))).toBe(true)

    // 负锚：没有任何 shell 调用看到过它。
    const shell = h.execSync.mock.calls.find((c) => typeof c[0] === 'string' && c[0].includes(EVIL))
    expect(shell, 'tag 名仍被拼进 shell 字符串').toBeUndefined()
  })

  it('log 窗口由 JS 截断，命令里不再有 head', async () => {
    h.execFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'tag') return 'v0.0.1\n'
      return Array.from({ length: 12 }, (_, i) => `commit ${i}`).join('\n')
    })
    const res = await handler(mkCtx(), [])
    expect(res.content).toContain('commit 7')
    expect(res.content).not.toContain('commit 8')

    const logCall = h.execFileSync.mock.calls.find((c) => c[1][0] === 'log')
    expect((logCall![1] as string[]).some((a) => a === 'head' || a.includes('head -'))).toBe(false)
  })
})
