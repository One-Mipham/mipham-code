import { describe, it, expect, afterEach, vi } from 'vitest'
import { spawn as nodeSpawn } from 'node:child_process'
import type { ToolContext } from '../../src/shared'
import { createBashTool, killProcessGroup } from '../../src/tools/exec/bash'

// ============================================================
// Bash 工具的**进程组**收尾 —— 两条失败模式，都没有任何现有覆盖。
//
//   1. `proc.kill()` 只收直接子进程。`bash -c 'sleep 30 & sleep 30'` 超时后，
//      孙进程被**孤儿化**存活 —— 没有通知、没有痕迹。
//   2. 读 stdout 在 `await proc.exited` **之前**：孙进程继承管道且长活时
//      （`server &` 未重定向输出），这一次读永远不返回 —— 命令 3ms 就跑完了，
//      调用却挂死（本机实测：exit 后 800ms 读仍在 pending）。
//
// 两条的解法都是「子进程自成进程组 + `process.kill(-pid)`」，而 `detached`
// **不是可选的润色**：本机实测 `detached: false` 时子进程的 pgid 是**父进程**
// （bun 自己）那一组，`kill(-pid)` 抛 ESRCH —— 组杀不只是无效，而是**指向错的组**。
//
// 测试分两处，因为 vitest 跑在 Node 下、全局 `Bun` 是替身（`Bun.spawn` 默认抛），
// 真进程组在这里**造不出来**：
//   · 机制用真进程测 —— 用 `node:child_process` 亲手建一个真进程组喂给该函数；
//   · 接线在 bash.ts 上测 —— 替身里让「组杀」真的把管道关掉（内核就是这么做的）。
// 撤掉接线时前者保持绿、后者红：判据与接线是两处。
// ============================================================

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('killProcessGroup — 用真进程组测机制', () => {
  const spawned: number[] = []

  afterEach(() => {
    for (const pid of spawned) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        /* 已收掉 */
      }
    }
    spawned.length = 0
  })

  /** 真进程组：组长 + 一个孙进程，返回 {pid, grandchild}。 */
  function spawnGroup(): Promise<{ pid: number; grandchild: number }> {
    const child = nodeSpawn('bash', ['-c', 'sleep 30 & echo $! >&2; sleep 30'], {
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    spawned.push(child.pid!)
    return new Promise((resolve, reject) => {
      let buf = ''
      child.stderr!.on('data', (d) => {
        buf += String(d)
        const n = Number(buf.trim())
        if (Number.isInteger(n) && n > 0) resolve({ pid: child.pid!, grandchild: n })
      })
      child.on('error', reject)
      setTimeout(() => reject(new Error('grandchild pid 未在预期时间内上报')), 5_000)
    })
  }

  it('收掉整组：组长与孙进程一起死', async () => {
    const { pid, grandchild } = await spawnGroup()
    expect(alive(pid)).toBe(true)
    expect(alive(grandchild)).toBe(true)

    killProcessGroup(pid)
    await sleep(300)

    expect(alive(grandchild)).toBe(false)
    expect(alive(pid)).toBe(false)
  }, 15_000)

  it('负对照：不建进程组时，按 -pid 收不掉孙进程（这条才是失败模式本身）', async () => {
    // 与上面同样的场景，唯独不设 detached —— 组杀打在了父进程所在的组上。
    const child = nodeSpawn('bash', ['-c', 'sleep 30 & echo $! >&2; sleep 30'], {
      detached: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    const grandchild = await new Promise<number>((resolve) => {
      let buf = ''
      child.stderr!.on('data', (d) => {
        buf += String(d)
        const n = Number(buf.trim())
        if (Number.isInteger(n) && n > 0) resolve(n)
      })
    })
    expect(alive(grandchild)).toBe(true)

    // 组杀本身失败（ESRCH：那个 id 下没有组），兜底只收直接子进程。
    killProcessGroup(child.pid!)
    child.kill('SIGKILL')
    await sleep(300)

    expect(alive(grandchild)).toBe(true)
    // 清理：这一条**故意**留了孤儿，自己收掉。
    try {
      process.kill(grandchild, 'SIGKILL')
    } catch {
      /* 已不在 */
    }
  }, 15_000)
})

// ============================================================
// 接线：bash.ts 必须（a）以 detached spawn、（b）超时走组杀、
// （c）退出后不再无限等管道。这三条各自都能单独丢掉。
// ============================================================

describe('Bash tool — 进程组接线（替身）', () => {
  const ctx: ToolContext = {
    cwd: '/tmp/test',
    sessionId: 'test-session',
    provider: 'test',
    model: 'test-model',
  } as ToolContext

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** 替身进程：stdout 永不自己关闭，直到「组杀」把它关掉 —— 内核就是这么做的。 */
  function mockProc(pid: number, exitCode: number | 'never') {
    let closeStdout: (() => void) | null = null
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        closeStdout = () => c.close()
      },
    })
    const proc = {
      pid,
      stdout,
      stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      exited: exitCode === 'never' ? new Promise<number>(() => {}) : Promise.resolve(exitCode),
      kill: vi.fn(),
    }
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((target: number) => {
      // 组杀 = 内核把整组的管道一起关掉
      if (target === -pid) closeStdout?.()
      return true
    }) as typeof process.kill)
    vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never)
    return { proc, killSpy }
  }

  it('spawn 时自成进程组（detached）', async () => {
    const spawnSpy = vi.spyOn(Bun, 'spawn').mockImplementation((() => {
      throw new Error('stop')
    }) as never)
    await createBashTool()
      .execute({ command: 'echo hi' }, ctx)
      .catch(() => {})
    expect(spawnSpy.mock.calls[0]?.[1]).toMatchObject({ detached: true })
  })

  it('超时走组杀（-pid），而不是只收直接子进程', async () => {
    const { proc, killSpy } = mockProc(4242, 'never')

    await Promise.race([
      createBashTool().execute({ command: 'sleep 99', timeout: 150 }, ctx),
      sleep(3_000).then(() => 'HUNG'),
    ])

    // 判据取「有没有对**组**下手」：修前这里是 proc.kill()，-4242 一次都不会出现。
    expect(killSpy.mock.calls.map((c) => c[0])).toContain(-4242)
    expect(proc.pid).toBe(4242)
  }, 10_000)

  it('命令已退出但孙进程仍持管道时，调用仍会返回（不永久挂住）', async () => {
    // exited 立刻完成，stdout 一直不关 —— 修前的 `await 读` 落在这里，永不返回。
    mockProc(5252, 0)

    const result = await Promise.race([
      createBashTool().execute({ command: 'server &', timeout: 600_000 }, ctx),
      sleep(4_000).then(() => 'HUNG' as const),
    ])

    expect(result).not.toBe('HUNG')
    expect((result as { success: boolean }).success).toBe(true)
  }, 15_000)
})

// ============================================================
// 取消（`ctx.signal`）要**落到进程组**上。
//
// 修前 signal 只喂到 `permission.resolveApproval` 与 LLM 流：`ToolContext` 里
// 根本没有这个字段，命令收到的一切**永远不改变** ⇒ 一次长跑的 Bash 无法被取消，
// Escape 结束了这一轮，而命令继续往用户磁盘上写。
//
// 两条判据分开钉：① 取消**必须**对组下手（否掉 `proc.kill()` 这种只收直接子进程的
// 写法）；② 取消后的结果**不能是成功** —— 包括退出码恰好是 0 的那一格（SIGKILL 与
// 自然退出赛跑），否则半截命令会被当成干净结果交回去。
//
// 这一格与「超时」共用组杀，但**成因不同**（谁先到），所以报出的文案必须能分开读。
// ============================================================

describe('Bash tool — 取消落到进程组（替身）', () => {
  const ctx: ToolContext = {
    cwd: '/tmp/test',
    sessionId: 'test-session',
    provider: 'test',
    model: 'test-model',
  } as ToolContext

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /**
   * 替身进程：`exited` 在**组杀到来时**才完成 —— 内核就是这么做的（整组死了，子进程
   * 就退出了）。上一段 `mockProc` 把 `exited` 写成永不完成，那对超时/挂起两格是对的
   * （它们只断言「组杀下手了」），但这两格要读**返回的结果**，所以这里必须会收尾。
   */
  function cancellableProc(pid: number, exitCode: number) {
    let closeStdout: (() => void) | null = null
    let resolveExited: (code: number) => void = () => {}
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        closeStdout = () => c.close()
      },
    })
    const proc = {
      pid,
      stdout,
      stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      exited: new Promise<number>((resolve) => {
        resolveExited = resolve
      }),
      kill: vi.fn(),
    }
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((target: number) => {
      if (target === -pid) {
        closeStdout?.()
        resolveExited(exitCode)
      }
      return true
    }) as typeof process.kill)
    vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never)
    return { proc, killSpy }
  }

  it('调用前就已取消 ⇒ 不必等命令自己结束，且对**组**下手', async () => {
    const { proc, killSpy } = cancellableProc(6101, 137)
    const ac = new AbortController()
    ac.abort()

    const result = await Promise.race([
      createBashTool().execute(
        { command: 'sleep 99', timeout: 600_000 },
        { ...ctx, signal: ac.signal },
      ),
      sleep(3_000).then(() => 'HUNG' as const),
    ])

    expect(result).not.toBe('HUNG')
    expect((result as { success: boolean }).success).toBe(false)
    expect((result as { error: string }).error).toContain('cancelled')
    // 判据取「有没有对**组**下手」：只收直接子进程（`proc.kill()`）时 -6101 一次不出现。
    expect(killSpy.mock.calls.map((c) => c[0])).toContain(-6101)
    expect(proc.pid).toBe(6101)
  }, 10_000)

  it('命令跑着的时候取消 ⇒ 组杀并如实报「取消」，不报「超时」', async () => {
    const { killSpy } = cancellableProc(6202, 137)
    const ac = new AbortController()
    // 监听器是在 `await proc.exited` 之前、同一个同步段里挂上的，所以一个 30ms 的
    // 定时器必然在挂上之后触发（不是靠运气抢跑）。
    const t = setTimeout(() => ac.abort(), 30)

    const result = await Promise.race([
      createBashTool().execute(
        { command: 'sleep 99', timeout: 600_000 },
        { ...ctx, signal: ac.signal },
      ),
      sleep(3_000).then(() => 'HUNG' as const),
    ])
    clearTimeout(t)

    expect(result).not.toBe('HUNG')
    const r = result as { success: boolean; error: string }
    expect(r.success).toBe(false)
    expect(r.error).toContain('cancelled')
    expect(r.error).not.toContain('timed out')
    expect(killSpy.mock.calls.map((c) => c[0])).toContain(-6202)
  }, 10_000)

  it('取消后命令恰好退出 0 ⇒ 仍然报失败（半截命令不许当干净结果交回）', async () => {
    cancellableProc(6303, 0)
    const ac = new AbortController()
    ac.abort()

    const result = await createBashTool().execute(
      { command: 'half-written', timeout: 600_000 },
      { ...ctx, signal: ac.signal },
    )

    expect(result.success).toBe(false)
    expect(result.error).toContain('cancelled')
  }, 10_000)

  it('反方向：没有 signal 的调用不受影响（同一份替身，命令正常收尾）', async () => {
    // 不取消、`exited` 自行完成 —— 命令的输出照旧算成功。少了这一条，「凡调用皆取消」
    // 也能让上面三条全绿。
    let resolveExited: (code: number) => void = () => {}
    const stdout = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('ok\n'))
        c.close()
      },
    })
    const proc = {
      pid: 6404,
      stdout,
      stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
      exited: new Promise<number>((resolve) => {
        resolveExited = resolve
      }),
      kill: vi.fn(),
    }
    vi.spyOn(Bun, 'spawn').mockReturnValue(proc as never)
    resolveExited(0)

    const result = await createBashTool().execute({ command: 'echo ok', timeout: 600_000 }, ctx)

    expect(result.success).toBe(true)
    expect(result.content).toContain('ok')
  }, 10_000)
})
