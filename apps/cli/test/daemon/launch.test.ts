import { resolve } from 'node:path'
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
} from '../../src/daemon/launch'

describe('selfArgvPrefix', () => {
  it('源码模式：argv[1] 是脚本 ⇒ 可执行文件后必须再传一次脚本路径', () => {
    expect(selfArgvPrefix('bin/mipham.ts', '/usr/local/bin/bun')).toEqual([
      '/usr/local/bin/bun',
      resolve('bin/mipham.ts'),
    ])
  })

  it('编译产物：argv[1] 是用户参数，绝不能被当成脚本路径', () => {
    expect(selfArgvPrefix('daemon', '/opt/mipham/dist/mipham')).toEqual(['/opt/mipham/dist/mipham'])
  })

  it('绝不产出裸 "bun" —— 编译产物存在的全部意义就是用户不必装 Bun', () => {
    for (const argv1 of ['daemon', 'bin/mipham.ts', undefined]) {
      expect(selfArgvPrefix(argv1, '/opt/mipham/dist/mipham')).not.toContain('bun')
    }
  })
})

describe('userArgs', () => {
  it('源码模式：argv 前两项是 bun 与脚本路径', () => {
    const argv = ['/usr/local/bin/bun', 'bin/mipham.ts', DAEMON_ENTRY]
    expect(userArgs(argv, argv[1])).toEqual([DAEMON_ENTRY])
  })

  it('编译产物：argv 首项就是程序本身，用户参数从下标 1 开始', () => {
    const argv = ['/opt/mipham/dist/mipham', DAEMON_ENTRY]
    expect(userArgs(argv, argv[1])).toEqual([DAEMON_ENTRY])
  })
})

describe('planDaemonSpawn', () => {
  it('子进程的 argv[0] 是 process.execPath（注入值），且带 __daemon 入口', () => {
    const plan = planDaemonSpawn({
      argv1: 'daemon',
      execPath: '/opt/mipham/dist/mipham',
      logPath: '/tmp/x/daemon.log',
    })
    expect(plan.command).toBe('/opt/mipham/dist/mipham')
    expect(plan.args[0]).toBe('/opt/mipham/dist/mipham')
    expect(plan.args).toContain(DAEMON_ENTRY)
  })

  it('不带 cwd —— 继承是 §2.2 的契约，显式传值会把它变成可静默改动的配置', () => {
    const plan = planDaemonSpawn({ argv1: 'daemon', execPath: '/opt/mipham/dist/mipham' })
    expect('cwd' in plan.options).toBe(false)
  })

  it('detached + unref 语义：detached 为真', () => {
    const plan = planDaemonSpawn({ argv1: 'daemon', execPath: '/opt/mipham/dist/mipham' })
    expect(plan.options.detached).toBe(true)
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
    expect(result.reason).toContain('3')
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
})
