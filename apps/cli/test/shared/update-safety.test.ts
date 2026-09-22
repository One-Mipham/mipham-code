/**
 * `mipham update` 的安全性 —— 一次真实事故的回归测试。
 *
 * 事故：`mipham update` 跑 `npm install -g`，而 npm 是**就地重写**全局包目录的。
 * 安装进程被 SIGTERM 之后，旧安装已经删掉、新安装没写完 ⇒ 用户手里**一个 CLI 都没有**，
 * 连 `mipham update` 本身都没了（自锁）。而旧代码把「npm 退出码」当成了「装好了」。
 *
 * 旧代码的两处缺陷，各由这里的用例钉住：
 *   1. `execSync(..., { timeout: 600_000 })` —— 10 分钟到点 SIGTERM。本机实测这个包
 *      下载要 11 分钟以上 ⇒ 这个「保护」会在一次正常的安装过程中开火，而开火本身就是破坏。
 *   2. 装完只印一句「Run 'mipham --version' to verify」 —— 把唯一的验证推给用户，
 *      而那时旧安装早已不在。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync, execSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performUpdate, resolveInstallPaths } from '../../src/shared/update'

/** launcher 与包内 bin 都指向它：一个只会打印版本号的真脚本（真跑，不打桩）。 */
function launcherScript(version: string): string {
  return `#!/bin/sh\necho "@miphamai/cli v${version}"\n`
}

interface Fake {
  root: string
  pkgDir: string
  launcher: string
  /** 当作 `import.meta.dirname` 传进去，<pkgDir>/src/shared */
  fromDir: string
  backupRoot: string
}

/** 造一份和 nvm 布局同形的假安装：<root>/lib/node_modules/@miphamai/cli + <root>/bin/mipham */
function makeFakeInstall(
  root: string,
  version: string,
  launcherKind: 'symlink' | 'file' = 'symlink',
): Fake {
  const pkgDir = join(root, 'lib', 'node_modules', '@miphamai', 'cli')
  const binDir = join(root, 'bin')
  mkdirSync(join(pkgDir, 'src', 'shared'), { recursive: true })
  mkdirSync(join(pkgDir, 'bin'), { recursive: true })
  mkdirSync(binDir, { recursive: true })

  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@miphamai/cli', version }))
  const pkgBin = join(pkgDir, 'bin', 'mipham')
  writeFileSync(pkgBin, launcherScript(version))
  chmodSync(pkgBin, 0o755)

  // 布局对照物：真 node prefix 的 bin/ 里一定有 npm，少了它就不该猜布局。
  writeFileSync(join(binDir, 'npm'), '')

  const launcher = join(binDir, 'mipham')
  if (launcherKind === 'symlink') {
    symlinkSync(join('..', 'lib', 'node_modules', '@miphamai', 'cli', 'bin', 'mipham'), launcher)
  } else {
    writeFileSync(launcher, launcherScript(version))
    chmodSync(launcher, 0o755)
  }

  return {
    root,
    pkgDir,
    launcher,
    fromDir: join(pkgDir, 'src', 'shared'),
    backupRoot: join(root, 'backups'),
  }
}

type Mode = 'ok' | 'killed' | 'silent-break' | 'missing-launcher' | 'wrong-version'

/**
 * 假 npm：模拟它的**就地重写**语义 —— 无论结局如何，旧树先没了。
 * 这正是「回滚必须靠事先的快照」的原因：出事时没有第二份可选。
 */
function fakeNpm(f: Fake, mode: Mode, target: string, seen: Array<Record<string, unknown>> = []) {
  return (_cmd: string, opts: Record<string, unknown>) => {
    seen.push(opts)
    if (mode === 'killed') {
      // 被信号杀掉的那一刻，npm 已经删掉了旧树、还没放好新树。真实形态如此。
      rmSync(f.pkgDir, { recursive: true, force: true })
      rmSync(f.launcher, { force: true })
      throw new Error('npm install was terminated by SIGTERM')
    }
    rmSync(f.pkgDir, { recursive: true, force: true })
    if (mode === 'silent-break') {
      // npm「成功返回」，却什么都没留下 —— 旧代码在这里会印 ✓ Updated。
      mkdirSync(f.pkgDir, { recursive: true })
      return
    }
    const installed = mode === 'wrong-version' ? '1.0.0' : target
    mkdirSync(join(f.pkgDir, 'bin'), { recursive: true })
    writeFileSync(
      join(f.pkgDir, 'package.json'),
      JSON.stringify({ name: '@miphamai/cli', version: installed }),
    )
    const pkgBin = join(f.pkgDir, 'bin', 'mipham')
    writeFileSync(pkgBin, launcherScript(installed))
    chmodSync(pkgBin, 0o755)
    rmSync(f.launcher, { force: true })
    if (mode !== 'missing-launcher') {
      symlinkSync(
        join('..', 'lib', 'node_modules', '@miphamai', 'cli', 'bin', 'mipham'),
        f.launcher,
      )
    }
  }
}

function installedVersion(f: Fake): string | undefined {
  try {
    return (
      JSON.parse(readFileSync(join(f.pkgDir, 'package.json'), 'utf-8')) as { version?: string }
    ).version
  } catch {
    return undefined
  }
}

/** 旧安装是否真的还能跑（不是「文件在不在」，而是「敲了有没有输出」）。 */
function launcherRuns(f: Fake): string | null {
  try {
    return execFileSync(f.launcher, ['--version'], { encoding: 'utf-8' }).trim()
  } catch {
    return null
  }
}

let tmp: string
let f: Fake

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mipham-update-'))
  f = makeFakeInstall(tmp, '0.83.0')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

describe('resolveInstallPaths —— 布局要推得出来，且推不出时不许猜', () => {
  it('从 <pkg>/src/shared 推出 prefix / pkgDir / launcher', () => {
    const p = resolveInstallPaths(f.fromDir)
    expect(p).not.toBeNull()
    expect(p!.pkgDir).toBe(f.pkgDir)
    expect(p!.launcher).toBe(f.launcher)
    expect(p!.prefix).toBe(f.root)
  })

  it('bin/ 里没有 npm（不是 node prefix 的形状）⇒ 返回 null', () => {
    // 判据：这是「我们只是猜了一个路径」与「这个路径真的是 node prefix」的分界。
    // 少了这条对照，一个猜出来的路径会被拿去写 launcher。
    rmSync(join(f.root, 'bin', 'npm'), { force: true })
    expect(resolveInstallPaths(f.fromDir)).toBeNull()
  })

  it('package.json 不在（树是残的）⇒ 返回 null', () => {
    rmSync(join(f.pkgDir, 'package.json'), { force: true })
    expect(resolveInstallPaths(f.fromDir)).toBeNull()
  })
})

describe('performUpdate —— 我们自己绝不能杀掉安装进程', () => {
  it('install 这一步不带 timeout（事故的根因就是它）', () => {
    const seen: Array<Record<string, unknown>> = []
    performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      backupRoot: f.backupRoot,
      install: fakeNpm(f, 'ok', '9.9.9', seen),
    })
    expect(seen).toHaveLength(1)
    // 负控：把 `timeout: 600_000` 加回去，本断言即红。判据是「有没有一个能在
    // 正常安装途中开火的计时器」—— 本机实测该包下载 >11 分钟，而它设在 10 分钟。
    expect(seen[0]).not.toHaveProperty('timeout')
  })
})

/**
 * 0.85.0 修好了「装前快照 / 装后自证 / 失败回滚」，但**回滚代码跑在 CLI 进程里** ——
 * 终端按 Ctrl-C 时 SIGINT 发给**整个前台进程组**，CLI 与 npm 一起死 ⇒ catch 永远不执行，
 * 用户手里还是半截树、而且**没有人回滚**。
 *
 * 两道守卫，缺一被保下来的都只是一半：
 *   · `detached: true`（调用点）—— npm 自成进程组，终端的 SIGINT 到不了它；
 *   · `blockSigintDuringInstall()` —— CLI 自己不被那条信号打死，好让 catch/自证/回滚有机会跑。
 *
 * **边界（只做了一半，如实记下）**：
 *   1. 「安装期间 Ctrl-C 会被忽略」是本修法的**代价**，不是附带好处 —— 用户按了没用，
 *      要中断只能另开一个终端杀进程。本次只落了代码与测试；**发布那一笔必须写进
 *      `CHANGELOG.md`**（用户可见的行为变化）。
 *   2. TUI（`/upgrade`）路径自带 SIGINT 处理，安装完成后它仍可能被投递；本守位只保证
 *      **CLI 在安装窗口内不死**，不改 TUI 的行为。
 *   3. 根因（npm 全局安装**没有原子换手**）没动 —— 真正扛得住 SIGKILL 的是 staging prefix
 *      + 原子换手，那是 ROADMAP 上另一条（D12），本轮不做。
 */
describe('performUpdate —— 终端 Ctrl-C 不能把安装打断到一半', () => {
  it('install 这一步带 detached:true（npm 自成进程组，终端的 SIGINT 到不了它）', () => {
    const seen: Array<Record<string, unknown>> = []
    performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      backupRoot: f.backupRoot,
      install: fakeNpm(f, 'ok', '9.9.9', seen),
    })
    expect(seen).toHaveLength(1)
    // 负控：删掉调用点的 `detached: true`，本断言即红。
    // 边界：这里断的是「选项送出去了」；「detached 真的换了进程组」是 Node/POSIX 的行为，
    // 已用真命令行探针在本机验过（detached 的子进程 pgid ≠ 父进程，未 detached 的 == 父进程），
    // 但那是探针不是本套件 —— 别把这条绿读成「进程组语义已被 CI 覆盖」。
    expect(seen[0].detached).toBe(true)
  })

  it('安装窗口内 CLI 挂着 SIGINT 守位，装完立刻撤掉', () => {
    const base = process.listenerCount('SIGINT')
    let during = -1
    performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      backupRoot: f.backupRoot,
      install: (cmd, opts) => {
        during = process.listenerCount('SIGINT')
        fakeNpm(f, 'ok', '9.9.9')(cmd, opts)
      },
    })
    expect(during).toBe(base + 1)
    // 漏撤的话，handler 会活到进程结束 —— TUI 里 Ctrl-C 从此**永远**没反应，比原来更糟。
    expect(process.listenerCount('SIGINT')).toBe(base)
  })

  it('安装中途抛错时守位也要撤掉（挂在 finally 上，不是只有成功路径）', () => {
    const base = process.listenerCount('SIGINT')
    performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      backupRoot: f.backupRoot,
      install: fakeNpm(f, 'killed', '9.9.9'),
    })
    expect(process.listenerCount('SIGINT')).toBe(base)
  })

  it('真往自己发一个 SIGINT（终端那条 Ctrl-C 打到 CLI 的形状）：进程活着，安装照跑完', () => {
    // 负控：把 `blockSigintDuringInstall()` 换成空壳（`() => () => {}`），**本进程当场死**
    // —— vitest 会把该 worker 记成失败。这条负控是「进程死」而不是「断言红」，跑它之前
    // 先确认 vitest 真的把它算失败（实测过才写在这里）。
    const r = performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      backupRoot: f.backupRoot,
      install: (cmd, opts) => {
        process.kill(process.pid, 'SIGINT')
        // 阻塞着收信号 —— 正是事故的时序：信号到达时事件循环在 execSync 里。
        execSync('sleep 0.3')
        fakeNpm(f, 'ok', '9.9.9')(cmd, opts)
      },
    })
    expect(r.ok).toBe(true)
    expect(r.verified).toBe(true)
  })
})

describe('performUpdate —— 装完必须自证，不能把验证推给用户', () => {
  it('装好且验证通过 ⇒ ok:true + verified:true + 报出新版本', () => {
    const r = performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      backupRoot: f.backupRoot,
      install: fakeNpm(f, 'ok', '9.9.9'),
    })
    expect(r.ok).toBe(true)
    expect(r.verified).toBe(true)
    expect(r.version).toBe('9.9.9')
    expect(installedVersion(f)).toBe('9.9.9')
    expect(launcherRuns(f)).toContain('9.9.9')
  })

  it('安装进程被杀（事故原形）⇒ ok:false、回滚，旧 CLI 仍能跑', () => {
    const r = performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      backupRoot: f.backupRoot,
      install: fakeNpm(f, 'killed', '9.9.9'),
    })
    expect(r.ok).toBe(false)
    expect(r.rolledBack).toBe(true)
    // 判据：用户手里还有能跑的 CLI，而不是「一个都没有」。
    expect(installedVersion(f)).toBe('0.83.0')
    expect(launcherRuns(f)).toContain('0.83.0')
  })

  it('npm 静默留下半截树（退出码是 0）⇒ 必须判失败并回滚', () => {
    // 这是旧代码的盲区：它只看 npm 的退出码，于是会印「✓ Updated」。
    const r = performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      backupRoot: f.backupRoot,
      install: fakeNpm(f, 'silent-break', '9.9.9'),
    })
    expect(r.ok).toBe(false)
    expect(r.rolledBack).toBe(true)
    expect(r.reason).toBeTruthy()
    expect(installedVersion(f)).toBe('0.83.0')
    expect(launcherRuns(f)).toContain('0.83.0')
  })

  it('包装好了但 launcher 没落位 ⇒ 失败并回滚（并把它建回来）', () => {
    const r = performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      backupRoot: f.backupRoot,
      install: fakeNpm(f, 'missing-launcher', '9.9.9'),
    })
    expect(r.ok).toBe(false)
    expect(r.rolledBack).toBe(true)
    expect(launcherRuns(f)).toContain('0.83.0')
  })

  it('装成了别的版本 ⇒ 失败并回滚（版本对不上不算装好）', () => {
    const r = performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      backupRoot: f.backupRoot,
      install: fakeNpm(f, 'wrong-version', '9.9.9'),
    })
    expect(r.ok).toBe(false)
    expect(r.rolledBack).toBe(true)
    expect(installedVersion(f)).toBe('0.83.0')
  })

  it('launcher 是普通文件（非符号链接）也能回滚', () => {
    const f2 = makeFakeInstall(mkdtempSync(join(tmpdir(), 'mipham-update-file-')), '0.82.0', 'file')
    try {
      const r = performUpdate('9.9.9', undefined, {
        paths: resolveInstallPaths(f2.fromDir),
        backupRoot: f2.backupRoot,
        install: fakeNpm(f2, 'killed', '9.9.9'),
      })
      expect(r.ok).toBe(false)
      expect(r.rolledBack).toBe(true)
      expect(launcherRuns(f2)).toContain('0.82.0')
    } finally {
      rmSync(f2.root, { recursive: true, force: true })
    }
  })

  it('没有旧安装（全新）时失败不崩，且不谎称回滚', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'mipham-update-fresh-'))
    try {
      const paths = {
        prefix: fresh,
        pkgDir: join(fresh, 'nope', '@miphamai', 'cli'),
        launcher: join(fresh, 'bin', 'mipham'),
      }
      const r = performUpdate('9.9.9', undefined, {
        paths,
        backupRoot: join(fresh, 'backups'),
        install: () => {
          throw new Error('boom')
        },
      })
      expect(r.ok).toBe(false)
      expect(r.rolledBack).toBe(false)
      expect(r.reason).toBeTruthy()
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })

  it('非法版本号直接拒绝，不碰安装', () => {
    const install = vi.fn()
    const r = performUpdate('9.9.9; rm -rf /', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      backupRoot: f.backupRoot,
      install,
    })
    expect(r.ok).toBe(false)
    expect(install).not.toHaveBeenCalled()
  })
})

describe('performUpdate —— 快照是瞬时的', () => {
  it('成功之后不留下整份包副本', () => {
    performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      backupRoot: f.backupRoot,
      install: fakeNpm(f, 'ok', '9.9.9'),
    })
    const leftovers = existsSync(f.backupRoot)
      ? readdirSync(f.backupRoot).filter((e) => e.startsWith('cli-'))
      : []
    expect(leftovers).toEqual([])
  })

  it('上一次被杀的残留会被这次运行清掉（不然会攒满磁盘）', () => {
    mkdirSync(join(f.backupRoot, 'cli-0.83.0-STALE', 'pkg'), { recursive: true })
    writeFileSync(join(f.backupRoot, 'cli-0.83.0-STALE', 'pkg', 'package.json'), '{}')
    performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      backupRoot: f.backupRoot,
      install: fakeNpm(f, 'ok', '9.9.9'),
    })
    expect(existsSync(join(f.backupRoot, 'cli-0.83.0-STALE'))).toBe(false)
  })
})
