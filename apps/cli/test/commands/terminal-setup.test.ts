/**
 * `/terminal-setup` 写进用户 shell 的那个文件，**每一行都得有落点**。
 *
 * 从前它写三样东西，三样都不生效，其中一样还有害：
 *   • `export MIPHAM_HOME=…` —— `miphamHome()` 只用 `homedir()`，从不读这个变量；
 *   • `export MIPHAM_PROVIDER=$(grep …)` —— 全仓库零读者；
 *   • `alias mipham='cd $(pwd) && npm install -g … > /dev/null 2>&1; mipham'` ——
 *     空操作 + **每次敲 `mipham` 静默重装全局包**，错误全丢。
 *
 * 这条用例断的是「写出去的东西里不许再有这三样」——文件落在临时 HOME 里，
 * 不碰本机真实的 `~`。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const h = vi.hoisted(() => ({ home: '', calls: [] as string[] }))

vi.mock('node:os', async (orig) => {
  const real = await orig<typeof import('node:os')>()
  return { ...real, homedir: () => h.home }
})

vi.mock('node:child_process', async (orig) => {
  const real = await orig<typeof import('node:child_process')>()
  return {
    ...real,
    execSync: vi.fn((cmd: string) => {
      h.calls.push(cmd)
      // 「装好了」那一支：不再打印安装说明，也就不会与安装说明里的
      // `npm install -g` 字样混淆本用例的判据。
      if (cmd.startsWith('which mipham')) return '/usr/local/bin/mipham\n'
      if (cmd.startsWith('mipham --version')) return '0.0.0-test\n'
      return ''
    }),
  }
})

const { getCommand } = await import('../../src/ui/commands')
const terminalSetupCmd = getCommand('/terminal-setup')!

const originalShell = process.env.SHELL

beforeEach(() => {
  h.home = mkdtempSync(join(tmpdir(), 'mipham-term-'))
  h.calls = []
  process.env.SHELL = '/bin/zsh'
})

afterEach(() => {
  rmSync(h.home, { recursive: true, force: true })
  if (originalShell === undefined) delete process.env.SHELL
  else process.env.SHELL = originalShell
})

const shellFile = () => join(h.home, '.mipham', 'shell-setup.sh')

describe('/terminal-setup 写出的 shell-setup.sh', () => {
  it('不再每次启动静默重装全局包', async () => {
    await terminalSetupCmd({} as never, [])

    const content = readFileSync(shellFile(), 'utf8')
    expect(content).not.toContain('npm install -g')
    expect(content).not.toContain('alias mipham=')
    // 空操作那半也不能留着假装有用
    expect(content).not.toContain('cd $(pwd)')
  })

  it('不再导出没有读者的环境变量', async () => {
    await terminalSetupCmd({} as never, [])

    const content = readFileSync(shellFile(), 'utf8')
    expect(content).not.toContain('export MIPHAM_HOME')
    expect(content).not.toContain('export MIPHAM_PROVIDER')
  })

  it('仍然可 source：文件在、带了 source 的说明', async () => {
    await terminalSetupCmd({} as never, [])

    expect(existsSync(shellFile())).toBe(true)
    expect(readFileSync(shellFile(), 'utf8')).toContain('source ~/.mipham/shell-setup.sh')
  })

  it('把 source 行追加进 profile，重跑不重复追加', async () => {
    writeFileSync(join(h.home, '.zshrc'), '# user content\n')

    await terminalSetupCmd({} as never, [])
    const once = readFileSync(join(h.home, '.zshrc'), 'utf8')
    expect(once).toContain('shell-setup.sh')
    expect(once).toContain('# user content')

    const second = await terminalSetupCmd({} as never, [])
    const twice = readFileSync(join(h.home, '.zshrc'), 'utf8')
    expect(twice).toBe(once)
    expect(second.content).toContain('already has Mipham Code integration')
  })

  it('重跑会把旧版本留下的文件覆盖掉 —— 已经装过的用户也能被修好', async () => {
    // 模拟旧版本写下的文件
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(h.home, '.mipham'), { recursive: true })
    writeFileSync(
      shellFile(),
      "#!/bin/bash\nalias mipham='cd $(pwd) && npm install -g @miphamai/cli > /dev/null 2>&1; mipham'\n",
    )

    await terminalSetupCmd({} as never, [])

    const content = readFileSync(shellFile(), 'utf8')
    expect(content).not.toContain('npm install -g')
  })
})
