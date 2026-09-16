import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

// startDetachedDaemon() plans a spawn whose logPath defaults to
// ~/.mipham/daemon.log and then mkdirs + opens it, so every test that reaches
// the spawn path would otherwise write into the developer's real home.
// It must be `node:os` (a hoisted `vi.mock`) and not `process.env.HOME`:
// DEFAULT_LOG_FILE is computed when launch.ts is first imported, and the mock
// is hoisted above that import while an env var is not.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-daemon-launch`,
  }
})

import {
  DAEMON_ENTRY,
  planDaemonSpawn,
  selfArgvPrefix,
  startDetachedDaemon,
  userArgs,
  waitForDaemonExit,
} from '../../src/daemon/launch'

// Measured on bun 1.3.14 — 这两条是 bun 真正产生的形状，不是我们希望它产生的。
// 本文件原先给编译产物编了一个 ['/opt/mipham/dist/mipham', '__daemon']：bun 从不
// 产生它（产物里 argv[0] 是字面量 "bun"、argv[1] 是只存在于二进制内部的 $bunfs
// 路径），于是那条用例在错的模型上恒绿 —— 正是本 bug 逃过 Task 1–3 的原因。
// **形状断言必须锚在实测形状上：锚在臆想形状上的断言比没有测试更糟。**
const SOURCE_ARGV = ['/usr/local/bin/bun', '/repo/apps/cli/bin/mipham.ts', DAEMON_ENTRY]
const COMPILED_ARGV = ['bun', '/$bunfs/root/mipham', DAEMON_ENTRY]

describe('selfArgvPrefix', () => {
  it('源码模式：解释器在 argv[0] ⇒ 可执行文件后必须再传一次脚本路径', () => {
    expect(selfArgvPrefix(SOURCE_ARGV[0], SOURCE_ARGV[1], '/usr/local/bin/bun')).toEqual([
      '/usr/local/bin/bun',
      resolve('/repo/apps/cli/bin/mipham.ts'),
    ])
  })

  it('编译产物：argv[0] 是字面量 "bun"（≠ execPath）⇒ 只重跑 execPath，不带 $bunfs 路径', () => {
    const plan = selfArgvPrefix(COMPILED_ARGV[0], COMPILED_ARGV[1], '/opt/mipham/dist/mipham')
    expect(plan).toEqual(['/opt/mipham/dist/mipham'])
  })

  it('绝不产出裸 "bun" —— 编译产物存在的全部意义就是用户不必装 Bun', () => {
    for (const argv1 of [COMPILED_ARGV[1], SOURCE_ARGV[1], undefined]) {
      expect(selfArgvPrefix(SOURCE_ARGV[0], argv1, '/opt/mipham/dist/mipham')).not.toContain('bun')
    }
  })
})

describe('userArgs', () => {
  it('源码模式：用户参数从下标 2 起', () => {
    expect(userArgs(SOURCE_ARGV)).toEqual([DAEMON_ENTRY])
  })

  it('编译产物：同样从下标 2 起（argv[1] 的 $bunfs 路径不是用户参数）', () => {
    // 这一条就是当初能抓住本 bug 的那条：判别式一改成「有没有扩展名」，
    // 它就断言不出 [DAEMON_ENTRY]，`main()` 的 __daemon 分支随即不可达。
    expect(userArgs(COMPILED_ARGV)).toEqual([DAEMON_ENTRY])
  })
})

describe('planDaemonSpawn', () => {
  it('args 里绝不能再出现 execPath —— spawn() 自己把它设成 argv[0]', () => {
    const plan = planDaemonSpawn({
      argv0: COMPILED_ARGV[0],
      argv1: COMPILED_ARGV[1],
      execPath: '/opt/mipham/dist/mipham',
      logPath: '/tmp/x/daemon.log',
    })
    expect(plan.command).toBe('/opt/mipham/dist/mipham')
    // 编译产物：argv = [execPath, '__daemon', …]。`spawn(command, args)` 把 command
    // 放在 argv[0]（node 与 bun 一致，实测），所以 args[0] 就是 argv[1]。
    expect(plan.args[0]).toBe(DAEMON_ENTRY)

    // 源码模式：argv = [bun, script, '__daemon', …] ⇒ args 必须从脚本路径起，
    // 且只出现一次。args[0] 若再放 execPath，argv[1] 就成了 bun 自己的二进制，
    // 运行时把它当脚本解析 ⇒ `error: Unexpected <binary>`，脚本根本跑不到。
    const source = planDaemonSpawn({
      argv0: SOURCE_ARGV[0],
      argv1: SOURCE_ARGV[1],
      execPath: '/usr/local/bin/bun',
      logPath: '/tmp/x/daemon.log',
    })
    expect(source.args).toEqual([resolve('/repo/apps/cli/bin/mipham.ts'), DAEMON_ENTRY])
  })

  it('闭环：plan 产出的 argv 被子进程回读时，两种模式都解析出 __daemon', () => {
    // planDaemonSpawn 决定子进程 argv 的尾部，userArgs 在子进程里解析它 —— 单看任何
    // 一侧都发现不了本 bug（形状对、模型错），闭环才抓得住。
    // 两种模式的 *前两项* 不同（实测，见文件顶部）：源码是 spawn 自己写的
    // [command, 脚本]，产物是运行时改写/插入的 ["bun", $bunfs 入口]。这正是不变量
    // 只可能是「前两项之后就是用户参数」，而不是「argv[1] 是不是脚本路径」的原因。
    const source = planDaemonSpawn({
      argv0: SOURCE_ARGV[0],
      argv1: SOURCE_ARGV[1],
      execPath: '/usr/local/bin/bun',
    })
    expect(userArgs([source.command, ...source.args])).toEqual([DAEMON_ENTRY])

    const compiled = planDaemonSpawn({
      argv0: COMPILED_ARGV[0],
      argv1: COMPILED_ARGV[1],
      execPath: '/opt/mipham/dist/mipham',
    })
    expect(userArgs(['bun', '/$bunfs/root/mipham', ...compiled.args])).toEqual([DAEMON_ENTRY])
  })

  it('不带 cwd —— 继承是 §2.2 的契约，显式传值会把它变成可静默改动的配置', () => {
    const plan = planDaemonSpawn({
      argv0: COMPILED_ARGV[0],
      argv1: COMPILED_ARGV[1],
      execPath: '/opt/mipham/dist/mipham',
    })
    expect('cwd' in plan.options).toBe(false)
  })

  it('detached + unref 语义：detached 为真', () => {
    const plan = planDaemonSpawn({
      argv0: COMPILED_ARGV[0],
      argv1: COMPILED_ARGV[1],
      execPath: '/opt/mipham/dist/mipham',
    })
    expect(plan.options.detached).toBe(true)
  })

  it('判别式是**两个**合取项：argv1 存在但值不是字符串 ⇒ 产物形状，不去 resolve 它', () => {
    // 判别式写的是 `argv0 === execPath && typeof argv1 === 'string'`，两个条件。
    // 这里只传递第二个的失效方式（`'argv1' in opts` 为真、值为 undefined），
    // 第一个用默认值 —— 实测（node 下 `process.argv[0] === process.execPath`）为真，
    // 于是结论只可能来自 `typeof` 那一项。删掉它，分支就会去 `resolve(undefined)`
    // 并抛 TypeError：这正是「源码形状」那条路在做的事，而它在产物里是错的
    // （$bunfs 路径不存在于任何新进程可读的地方，见 selfArgvPrefix 的注释）。
    const plan = planDaemonSpawn({ argv1: undefined, logPath: '/tmp/x/daemon.log' })
    expect(plan.args).toEqual([DAEMON_ENTRY])
  })
})

/** Minimal child-process double: records listeners, lets the test fire them. */
function fakeChild() {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  return {
    on(event: string, cb: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? []
      list.push(cb)
      listeners.set(event, list)
      return this
    },
    unref() {},
    emit(event: string, ...args: unknown[]) {
      for (const cb of listeners.get(event) ?? []) cb(...args)
    },
  }
}

const noSleep = async () => {}

describe('startDetachedDaemon 不谎报', () => {
  it('status 在超时前出现 ⇒ ok:true 并带上真实 pid/port', async () => {
    const child = fakeChild()
    let calls = 0
    const result = await startDetachedDaemon({
      deps: {
        spawnFn: (() => child) as never,
        // null on the pre-spawn probe, ready afterwards: returning a status on
        // the *first* call exits through the "already running" branch, and the
        // polling loop this test is named after would never execute.
        getStatus: () => (calls++ === 0 ? null : { pid: 4242, port: 45671 }),
        sleep: noSleep,
      },
    })
    expect(result).toEqual({ ok: true, pid: 4242, port: 45671 })
  })

  it('spawn 报错（如 ENOENT）⇒ ok:false 且说明原因', async () => {
    const child = fakeChild()
    const result = await startDetachedDaemon({
      timeoutMs: 50,
      deps: {
        spawnFn: (() => {
          queueMicrotask(() => child.emit('error', new Error('spawn bun ENOENT')))
          return child
        }) as never,
        getStatus: () => null,
        sleep: () => new Promise((r) => setTimeout(r, 1)),
      },
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('ENOENT')
  })

  it('子进程早退而 status 始终为空 ⇒ ok:false 且带退出码', async () => {
    const child = fakeChild()
    const result = await startDetachedDaemon({
      timeoutMs: 50,
      deps: {
        spawnFn: (() => {
          queueMicrotask(() => child.emit('exit', 3))
          return child
        }) as never,
        getStatus: () => null,
        sleep: () => new Promise((r) => setTimeout(r, 1)),
      },
    })
    expect(result.ok).toBe(false)
    // 必须钉退出码字样，不能只断 '3'：超时分支的 reason 里带着 logPath，而 mock
    // home 是 <tmpdir>/mipham-test-daemon-launch —— 路径本身就含 '3'，于是断言在
    // 错的分支上也通过，删掉整个早退分支它照样绿。
    expect(result.reason).toContain('exited with code 3')
  })

  it('始终不 ready ⇒ ok:false（旧实现在这里打印成功并 exit 0）', async () => {
    const result = await startDetachedDaemon({
      timeoutMs: 0,
      deps: { spawnFn: (() => fakeChild()) as never, getStatus: () => null, sleep: noSleep },
    })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/ready|超时|timeout/i)
  })

  it('已经在跑 ⇒ 直接 ok:true，不重复 spawn', async () => {
    let spawned = 0
    const result = await startDetachedDaemon({
      deps: {
        spawnFn: (() => {
          spawned += 1
          return fakeChild()
        }) as never,
        getStatus: () => ({ pid: 7, port: 1234 }),
        sleep: noSleep,
      },
    })
    expect(result).toEqual({ ok: true, pid: 7, port: 1234 })
    expect(spawned).toBe(0)
  })

  it('调用点的形状：spawn 实参带 detached/env、绝不带 cwd，且 pollMs 真的生效', async () => {
    const child = fakeChild()
    let calls = 0
    // Task 1 钉的是 planDaemonSpawn 的**返回值**；这里是调用点的**实参**，两者可以
    // 各自被改坏。丢掉 detached ⇒ daemon 随父 shell 一起死；加 cwd ⇒ 违反 §2.2
    // 的唯一硬接口（cwd 必须继承，它是 daemon 的路径白名单边界）。
    const captured: { args?: readonly string[]; options?: Record<string, unknown> } = {}
    const slept: number[] = []
    const result = await startDetachedDaemon({
      pollMs: 7,
      deps: {
        spawnFn: ((_command: string, args: readonly string[], options: Record<string, unknown>) => {
          captured.args = args
          captured.options = options
          return child
        }) as never,
        // 首次 null（spawn 前的探活），其后 ready：non-null 会走 already 早退，
        // 而 spawn 一次都不会发生。
        getStatus: () => (calls++ === 0 ? null : { pid: 4242, port: 45671 }),
        sleep: async (ms: number) => {
          slept.push(ms)
        },
      },
    })

    expect(result.ok).toBe(true)
    expect(captured.options?.detached).toBe(true)
    expect(captured.options && 'cwd' in captured.options).toBe(false)
    expect(captured.options?.env).toBeInstanceOf(Object)
    expect(Object.keys((captured.options?.env ?? {}) as object).length).toBe(
      Object.keys(process.env).length,
    )
    expect(captured.args).toContain(DAEMON_ENTRY)
    // 否则「用了 pollMs」与「随便传了个数」不可区分。
    expect(slept).toEqual([7])
  })
})

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

describe('waitForDaemonExit —— restart 等老 daemon 真的退', () => {
  it('status 变 null ⇒ true，一拿到就不再 poll', async () => {
    let calls = 0
    const slept: number[] = []
    const gone = await waitForDaemonExit({
      pollMs: 5,
      deps: {
        // 前两次仍在、第三次起为 null
        getStatus: () => (++calls < 3 ? { pid: 7, port: 1234 } : null),
        sleep: async (ms: number) => {
          slept.push(ms)
        },
      },
    })
    expect(gone).toBe(true)
    // 至少一次：一次都不问就报 true 的「等」不是等。
    expect(calls).toBe(3)
    // 有界：睡的次数恰好等于「读到仍在」的次数，而不是空转到某个常数。
    expect(slept).toEqual([5, 5])
  })

  it('老 daemon 始终不退 ⇒ false，且按 timeoutMs/pollMs 有界（绝不真等 10s）', async () => {
    vi.useFakeTimers()
    try {
      const slept: number[] = []
      const gone = await waitForDaemonExit({
        timeoutMs: 30,
        pollMs: 10,
        deps: {
          getStatus: () => ({ pid: 7, port: 1234 }),
          // 假时钟随假 sleep 前进，否则 timeoutMs 只能用**真**墙钟度量，
          // 这条用例就得真等 30ms——而默认值是 10s。
          sleep: async (ms: number) => {
            slept.push(ms)
            vi.advanceTimersByTime(ms)
          },
        },
      })
      expect(gone).toBe(false)
      expect(slept).toEqual([10, 10, 10])
    } finally {
      vi.useRealTimers()
    }
  })

  it('问之前就已经不在了 ⇒ true，一次都不睡', async () => {
    const slept: number[] = []
    const gone = await waitForDaemonExit({
      deps: {
        getStatus: () => null,
        sleep: async (ms: number) => {
          slept.push(ms)
        },
      },
    })
    expect(gone).toBe(true)
    expect(slept).toEqual([])
  })
})

describe('__daemon 分支可达', () => {
  it('bin/mipham.ts 在 main() 顶部按 DAEMON_ENTRY 分派', () => {
    const src = readFileSync(join(CLI_ROOT, 'bin', 'mipham.ts'), 'utf-8')
    // main() 的第一句必须是这个分派：其后的代码假定交互式 TTY（stty），
    // 而 daemon 是 detached + stdio ignore 起来的。
    const mainStart = src.indexOf('async function main()')
    expect(mainStart).toBeGreaterThan(-1)
    const head = src.slice(mainStart, mainStart + 600)
    expect(head).toContain('DAEMON_ENTRY')
  })

  it('bin/daemon.ts 不再自己实现 daemon 进程体，改为委托', () => {
    const src = readFileSync(join(CLI_ROOT, 'bin', 'daemon.ts'), 'utf-8')
    expect(src).toContain('runDaemonProcess')
    // 两份实现就是「两条渲染路径只接一条」的温床
    expect(src).not.toContain('process.env.MIPHAM_PORT =')
  })
})
