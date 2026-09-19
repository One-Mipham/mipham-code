import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '../../src/shared'
import { createBashTool } from '../../src/tools/exec/bash'

// ============================================================
// Bash 工具报给模型的**失败原因**。两条都是「归因指向了错的根因」——
// 与刚落的 2.58.0 #25（Grep 把任何异常都说成「rg 没装」）同族。
//
//   1. `ctx.cwd` 不存在 ⇒ `Bun.spawn` 抛
//      `ENOENT: no such file or directory, posix_spawn 'bash'`
//      （本机以真 bun 实测，逐字）—— 读起来是「bash 没装」，与真正的原因
//      （工作目录没了）相差一整个排查方向。
//   2. 超时杀掉整组后 exit code 是 137，stderr 是**空**的 ⇒ 模型只看到
//      `Exit code 137: `（同样是真 bun 实测），不知道是自己被超时收掉的。
//      这一条**不止** `timeout: -1`：正常超时（`timeout: 1500` 跑 `sleep 5`）
//      报的是同一条一模一样的字符串。计划里写的 143 是 SIGTERM 的号；
//      实际发的是 SIGKILL ⇒ **137**（实测与推算不一致时以实测为准）。
//   3. `timeout: -1` 本身：`Math.min(-1 || 120_000, 600_000)` = `-1` ⇒
//      `setTimeout(fn, -1)` 被 Node 归成 1ms ⇒ 命令**当场**被收掉。
//      Node 只往 stderr 打一句 `TimeoutNegativeWarning`（模型看不到）。
//
// vitest 跑在 Node 下、全局 `Bun` 是替身，所以这里测的是**描述**（替身抛什么、
// 假进程什么时候退出），不是真内核行为 —— 真行为已用真 bun 量过并记在上面。
// ============================================================

const ctx = (cwd: string): ToolContext => ({
  cwd,
  sessionId: 'test-session',
  provider: 'test',
  model: 'test-model',
})

/** 高于 macOS `pid_max` 的 pid：`process.kill(-pid)` 必 ESRCH，不会误伤真进程组。 */
const FAKE_PID = 2_000_000

function mockProc(opts: { exitCode?: number; delayMs?: number } = {}) {
  const { exitCode = 0, delayMs = 0 } = opts
  return {
    pid: FAKE_PID,
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
    exited: new Promise<number>((r) => setTimeout(() => r(exitCode), delayMs)),
    kill: vi.fn(),
  }
}

const mockSpawn = (opts: { exitCode?: number; delayMs?: number } = {}) =>
  vi.spyOn(Bun, 'spawn').mockImplementation((() => mockProc(opts)) as never)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('cwd 不存在时不许说成「bash 没装」', () => {
  it('ENOENT + cwd 真的不在 ⇒ 报工作目录，不报 posix_spawn bash', async () => {
    vi.spyOn(Bun, 'spawn').mockImplementation((() => {
      throw Object.assign(new Error("ENOENT: no such file or directory, posix_spawn 'bash'"), {
        code: 'ENOENT',
      })
    }) as never)

    const result = await createBashTool().execute({ command: 'echo hi' }, ctx('/no/such/dir'))

    expect(result.success).toBe(false)
    expect(result.error).toContain('/no/such/dir')
    expect(result.error).not.toContain('posix_spawn')
  })

  it('反方向：cwd 在，ENOENT 就还是 ENOENT（bash 真没装时不许改口）', async () => {
    vi.spyOn(Bun, 'spawn').mockImplementation((() => {
      throw Object.assign(new Error("ENOENT: no such file or directory, posix_spawn 'bash'"), {
        code: 'ENOENT',
      })
    }) as never)
    const realDir = mkdtempSync(join(tmpdir(), 'mipham-e7-'))

    const result = await createBashTool().execute({ command: 'echo hi' }, ctx(realDir))

    expect(result.success).toBe(false)
    expect(result.error).toContain('posix_spawn')
  })
})

describe('超时被收掉时要说「超时」，不是光甩一个退出码', () => {
  it('超时 ⇒ 报出超时与毫秒数', async () => {
    // 假进程 60ms 才退，超时 5ms ⇒ 定时器先响（真实现里由组杀收掉它）。
    mockSpawn({ exitCode: 137, delayMs: 60 })

    const result = await createBashTool().execute({ command: 'sleep 5', timeout: 5 }, ctx('/tmp'))

    expect(result.success).toBe(false)
    expect(result.error).toContain('timed out')
    expect(result.error).toContain('5ms')
  })

  it('反方向：不是超时的不许说成超时（普通非零退出照旧）', async () => {
    mockSpawn({ exitCode: 2 })

    const result = await createBashTool().execute({ command: 'exit 2' }, ctx('/tmp'))

    expect(result.success).toBe(false)
    expect(result.error).toContain('Exit code 2')
    expect(result.error).not.toContain('timed out')
  })
})

describe('负数 timeout 当场拒绝，不做成 1ms 的定时器', () => {
  it('timeout: -1 ⇒ 拒绝，且 bash 一次都不 fork', async () => {
    const spawnSpy = mockSpawn()

    const result = await createBashTool().execute({ command: 'echo hi', timeout: -1 }, ctx('/tmp'))

    expect(result.success).toBe(false)
    expect(result.error).toContain('timeout')
    expect(spawnSpy).not.toHaveBeenCalled()
  })
})
