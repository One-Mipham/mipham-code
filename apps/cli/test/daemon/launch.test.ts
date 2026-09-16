import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DAEMON_ENTRY, planDaemonSpawn, selfArgvPrefix, userArgs } from '../../src/daemon/launch'

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
