// apps/cli/test/daemon/index.test.ts — daemon 生命周期入口（src/daemon/index.ts）
//
// 覆盖四个导出：getPort / getDaemonStatus / startDaemon / stopDaemon。
// 前三个只读磁盘状态，最后一个负责收尾；三者共用的 PID/port 文件路径是在
// **模块导入时**由 miphamHome() 算出来的，所以必须用 vi.mock('node:os') 抢在
// import 之前把 homedir 指到临时目录（与 launch.test.ts 同一手法）——换用
// process.env.HOME 来不及，模块常量早已定格。

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-daemon-index`,
  }
})

import { getDaemonStatus, getPort, startDaemon, stopDaemon } from '../../src/daemon/index'
import { DaemonDatabase } from '../../src/daemon/database'
import { PACKAGE_VERSION } from '../../src/shared/package-info'

const HOME = join(tmpdir(), 'mipham-test-daemon-index')
const MIPHAM_HOME = join(HOME, '.mipham')
const PID_FILE = join(MIPHAM_HOME, 'daemon.pid')
const PORT_FILE = join(MIPHAM_HOME, 'daemon.port')
const DB_PATH = join(MIPHAM_HOME, 'daemon.db')

const DEFAULT_PORT = 45671

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true })
  mkdirSync(MIPHAM_HOME, { recursive: true })
})

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true })
})

describe('getPort', () => {
  it('port 文件不存在 ⇒ 默认端口', () => {
    expect(getPort()).toBe(DEFAULT_PORT)
  })

  it('读取 port 文件，去掉首尾空白', () => {
    writeFileSync(PORT_FILE, ' 45678\n')
    expect(getPort()).toBe(45678)
  })

  it.each(['0', '-1', '65536', 'abc'])('port 文件内容无效（%s）⇒ 默认端口', (raw) => {
    writeFileSync(PORT_FILE, raw)
    expect(getPort()).toBe(DEFAULT_PORT)
  })

  it('port 文件读不出来（是目录）⇒ 默认端口，不抛错', () => {
    // existsSync 为真、readFileSync 抛 EISDIR —— 走的是 catch 分支而不是「文件不存在」分支。
    mkdirSync(PORT_FILE)
    expect(getPort()).toBe(DEFAULT_PORT)
  })
})

describe('getDaemonStatus', () => {
  it('PID 文件不存在 ⇒ null', () => {
    expect(getDaemonStatus()).toBeNull()
  })

  it('PID 文件内容不是正整数 ⇒ null', () => {
    for (const raw of ['abc', '0', '-5']) {
      writeFileSync(PID_FILE, raw)
      expect(getDaemonStatus()).toBeNull()
    }
  })

  it('PID 指向活着的进程 ⇒ 返回完整状态，端口取自 port 文件', () => {
    writeFileSync(PID_FILE, String(process.pid))
    writeFileSync(PORT_FILE, '45678')

    expect(getDaemonStatus()).toEqual({
      pid: process.pid,
      port: 45678,
      uptime: 0, // 外部进程读不到实时数据，文档承诺填 0
      activeSessions: 0,
      totalSessions: 0,
      activeAgents: 0,
      version: PACKAGE_VERSION,
    })
  })

  it('PID 活着但没有 port 文件 ⇒ 端口回落到默认值', () => {
    writeFileSync(PID_FILE, String(process.pid))
    expect(getDaemonStatus()?.port).toBe(DEFAULT_PORT)
  })

  it('PID 活着 ⇒ 不删任何文件（清理只发生在进程已死那一支）', () => {
    writeFileSync(PID_FILE, String(process.pid))
    writeFileSync(PORT_FILE, '45678')

    expect(getDaemonStatus()).not.toBeNull()
    expect(existsSync(PID_FILE)).toBe(true)
    expect(existsSync(PORT_FILE)).toBe(true)
  })

  it('PID 指向已退出的进程 ⇒ null，并清理陈旧的 PID/port 文件', () => {
    writeFileSync(PID_FILE, '999999')
    writeFileSync(PORT_FILE, '45678')
    // 只伪造这一个 PID 的「不存在」，其余 pid（含测试框架自己的）仍走真 process.kill。
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid: number | string) => {
      if (Number(pid) === 999999) {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
      }
      return true
    })
    try {
      expect(getDaemonStatus()).toBeNull()
      expect(existsSync(PID_FILE)).toBe(false)
      expect(existsSync(PORT_FILE)).toBe(false)
    } finally {
      kill.mockRestore()
    }
  })
})

describe('stopDaemon', () => {
  it('没有起过 daemon 时调用不抛错，并清掉遗留的 PID/port 文件', async () => {
    writeFileSync(PID_FILE, String(process.pid))
    writeFileSync(PORT_FILE, '45678')

    await stopDaemon()

    expect(existsSync(PID_FILE)).toBe(false)
    expect(existsSync(PORT_FILE)).toBe(false)
  })

  it('可重复调用（第二次同样不抛错）', async () => {
    await stopDaemon()
    await expect(stopDaemon()).resolves.toBeUndefined()
  })
})

describe('startDaemon → stopDaemon 往返', () => {
  afterEach(async () => {
    // 无论用例怎么收场，都把模块级状态清干净，避免污染同文件后续用例。
    await stopDaemon(true)
  })

  it('返回 {port, token}，落盘 PID/port/token，且 getDaemonStatus 能读到它', async () => {
    delete process.env.MIPHAM_PORT
    delete process.env.MIPHAM_BIND

    const { port, token } = await startDaemon()

    expect(port).toBeGreaterThan(0)
    expect(port).toBeLessThan(65536)
    expect(readFileSync(PID_FILE, 'utf-8')).toBe(String(process.pid))
    expect(readFileSync(PORT_FILE, 'utf-8')).toBe(String(port))
    expect(readFileSync(join(MIPHAM_HOME, 'daemon.token'), 'utf-8').trim()).toBe(token)

    const status = getDaemonStatus()
    expect(status?.pid).toBe(process.pid)
    expect(status?.port).toBe(port)

    await stopDaemon(true)
    expect(existsSync(PID_FILE)).toBe(false)
    expect(existsSync(PORT_FILE)).toBe(false)
  })

  it('有活跃会话时不带 force 拒绝停机，且不会顺手拆掉 PID/port 文件', async () => {
    delete process.env.MIPHAM_PORT
    delete process.env.MIPHAM_BIND
    await startDaemon()

    // 另开一条连接插一条 active 会话；模块自己的 activeDb 读的是同一个库。
    const db = new DaemonDatabase(DB_PATH)
    try {
      db.createSession({
        name: 'guard-test',
        cwd: process.cwd(),
        provider: 'anthropic',
        model: 'claude-sonnet-5',
      })
    } finally {
      db.close()
    }

    await expect(stopDaemon()).rejects.toThrow(/1 active session/)
    expect(existsSync(PID_FILE)).toBe(true)
    expect(existsSync(PORT_FILE)).toBe(true)
  })
})
