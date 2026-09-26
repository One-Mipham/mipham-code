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
 *
 * 0.85.0 加了两道守卫（`detached: true` + `blockSigintDuringInstall()`），先快照再装、
 * 失败回滚 —— 但它们**都跑在 CLI 进程里**，而 SIGINT 发的是整个前台进程组；更要紧的是
 * 回滚代码挡不住**不可捕获**的终止（SIGKILL / 断电 / 容器被杀）：CLI 死了，没人回滚。
 *
 * 本文件现在钉的是**换掉那套做法之后**的形状（D12）：**装在旁边 → 验过 → 两次 rename
 * 换手**。真包目录在自证通过之前一个字节都不动，于是「半截树」这个状态**按构造不存在**
 * —— 除了两次 rename 之间那个微秒级窗口。旧写法里的「快照 / 恢复 / 丢弃」三个函数连同
 * 它们的测试一并退役：回滚不再是复制，而是**反向 rename**。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync, execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { layoutFor, performUpdate, resolveInstallPaths } from '../../src/shared/update'

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
}

/**
 * 布局的**独立复述**。刻意不调 `layoutFor` —— 拿被测代码算期望值，期望值就永远是
 * 「代码现在写的样子」，改错了也跟着一起错（同义反复）。
 *
 * 形状依据是 npm 自带源码：`lib/npm.js` 的 `globalDir`、`bin-links/lib/bin-target.js`
 * 的全局分支。
 */
function expectedLayout(
  prefix: string,
  platform: 'darwin' | 'win32',
): { pkgDir: string; launcher: string } {
  return platform === 'win32'
    ? {
        pkgDir: join(prefix, 'node_modules', '@miphamai', 'cli'),
        launcher: join(prefix, 'mipham.cmd'),
      }
    : {
        pkgDir: join(prefix, 'lib', 'node_modules', '@miphamai', 'cli'),
        launcher: join(prefix, 'bin', 'mipham'),
      }
}

/** 造一份和 nvm 布局同形的假安装：<root>/lib/node_modules/@miphamai/cli + <root>/bin/mipham */
function makeFakeInstall(root: string, version: string): Fake {
  const { pkgDir, launcher } = expectedLayout(root, 'darwin')
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

  // launcher 是**相对符号链接**：指向包目录内部的 `bin/mipham`。这一点是整笔改动的支点
  // —— 包路径不变，所以换手（rename 包目录）之后它**自动**指向新树，一个字节都不用改。
  symlinkSync(join('..', 'lib', 'node_modules', '@miphamai', 'cli', 'bin', 'mipham'), launcher)

  return { root, pkgDir, launcher, fromDir: join(pkgDir, 'src', 'shared') }
}

/**
 * 造一份和 **Windows 全局布局**同形的假安装：`<root>/node_modules/@miphamai/cli` + `<root>/mipham.cmd`。
 *
 * 与上面那份的差别只有两点，而这两点就是 D14 那个缺陷的全部：**没有 `lib` 这一层**、
 * shim 落在 `prefix` **本身**而不是 `prefix/bin`。
 *
 * `mipham.cmd` 在这里是一个**按自身位置解析目标**的 shim（`dirname $0`），对应真 Windows 上
 * cmd-shim 写的 `%~dp0` 形式 —— 只为了让这一格在本机（darwin）也能**真跑**。**这一点是必须
 * 的**：早先的测试把 launcher 写成「直接打印版本号的独立文件」，那种 launcher 跨换手不会
 * 跟着变，于是「换手后自证」这一关在测试里永远绿 —— 而它在真实布局里是要动的。
 */
function makeFakeWinInstall(root: string, version: string): Fake {
  const { pkgDir, launcher } = expectedLayout(root, 'win32')
  mkdirSync(join(pkgDir, 'src', 'shared'), { recursive: true })
  mkdirSync(join(pkgDir, 'bin'), { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@miphamai/cli', version }))
  const pkgBin = join(pkgDir, 'bin', 'mipham')
  writeFileSync(pkgBin, launcherScript(version))
  chmodSync(pkgBin, 0o755)
  writeFileSync(join(root, 'npm.cmd'), '') // 对照物：与 Unix 的 <prefix>/bin/npm 对位
  writeFileSync(
    launcher,
    '#!/bin/sh\nexec "$(dirname "$0")/node_modules/@miphamai/cli/bin/mipham" "$@"\n',
  )
  chmodSync(launcher, 0o755)
  return { root, pkgDir, launcher, fromDir: join(pkgDir, 'src', 'shared') }
}

type Mode = 'ok' | 'killed' | 'silent-break' | 'missing-launcher' | 'wrong-version'

interface SeenCall {
  cmd: string
  opts: Record<string, unknown>
}

/**
 * 假 npm：模拟**装在 `--prefix` 指的那个目录里**（即 staging），而**绝不碰真树**。
 * 这正是本笔改动的全部机理，所以 fixture 必须照着它建模：旧 fixture 模拟的是「就地重写」，
 * 那已经是过去式了。
 *
 * `--prefix` 后面的路径**必须带引号**才能被这里抠出来 —— 这不是 fixture 的洁癖，它就是
 * 被测代码必须具备的形状（prefix 里可能有空格），抠不到直接抛错即红。
 */
function fakeNpm(
  mode: Mode,
  target: string,
  seen: SeenCall[] = [],
  platform: 'darwin' | 'win32' = 'darwin',
) {
  return (cmd: string, opts: Record<string, unknown>) => {
    seen.push({ cmd, opts })
    const m = /--prefix "([^"]+)"/.exec(cmd)
    if (!m) throw new Error(`fakeNpm: 命令里没有带引号的 --prefix —— ${cmd}`)
    const { pkgDir, launcher } = expectedLayout(m[1]!, platform)

    if (mode === 'killed') {
      // 被信号杀掉的那一刻：**暂存**树半截（真树此刻碰都没碰）。
      mkdirSync(join(pkgDir, 'bin'), { recursive: true })
      writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@miphamai/cli' }))
      throw new Error('npm install was terminated by SIGTERM')
    }

    if (mode === 'silent-break') {
      // npm「成功返回」（退出码 0），却什么都没留下 —— 只看退出码的旧代码在这里会印 ✓。
      mkdirSync(pkgDir, { recursive: true })
      return
    }

    const installed = mode === 'wrong-version' ? '1.0.0' : target
    mkdirSync(join(pkgDir, 'bin'), { recursive: true })
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@miphamai/cli', version: installed }),
    )
    const pkgBin = join(pkgDir, 'bin', 'mipham')
    writeFileSync(pkgBin, launcherScript(installed))
    chmodSync(pkgBin, 0o755)
    if (mode === 'missing-launcher') return
    // npm 在 staging prefix 里建 launcher —— 与真安装同形（`bin/` 是它自己建的）。
    mkdirSync(join(launcher, '..'), { recursive: true })
    if (platform === 'win32') {
      writeFileSync(
        launcher,
        '#!/bin/sh\nexec "$(dirname "$0")/node_modules/@miphamai/cli/bin/mipham" "$@"\n',
      )
    } else {
      symlinkSync(join('..', 'lib', 'node_modules', '@miphamai', 'cli', 'bin', 'mipham'), launcher)
    }
    chmodSync(launcher, 0o755)
  }
}

function installedVersion(pkgDir: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8')) as { version?: string })
      .version
  } catch {
    return undefined
  }
}

/** 旧安装是否真的还能跑（不是「文件在不在」，而是「敲了有没有输出」）。 */
function launcherRuns(launcher: string): string | null {
  try {
    return execFileSync(launcher, ['--version'], { encoding: 'utf-8' }).trim()
  } catch {
    return null
  }
}

/** 目录内容的 sha256（相对路径 + 文件字节，路径排序）。用来证明「一个字节都没动」与
 *  「回滚拿回来的就是原来那一棵」—— 比逐个断言文件存在强得多。 */
function treeHash(dir: string): string {
  const h = createHash('sha256')
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }).sort((a, b) =>
      a.name < b.name ? -1 : 1,
    )) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else {
        h.update(relative(dir, p))
        h.update(readFileSync(p))
      }
    }
  }
  walk(dir)
  return h.digest('hex')
}

/** <prefix> 下我们自己的临时物（暂存壳 / 停放地）。 */
function tempEntries(root: string): string[] {
  return readdirSync(root).filter(
    (e) => e.startsWith('.mipham-staging-') || e.startsWith('.mipham-old-'),
  )
}

let tmp: string
let f: Fake
/** Windows 形状的那一份 —— 同一 tmp、同一版本，只有布局不同。 */
let win: Fake

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mipham-update-'))
  f = makeFakeInstall(tmp, '0.83.0')
  win = makeFakeWinInstall(join(tmp, 'win'), '0.83.0')
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

/**
 * 失败文案：四态各要有一句话，两份 locale 都得有。
 *
 * 缺口长什么样：`t()` 遇到不存在的键**不抛异常**，它把原始 key 渲染上屏 —— 用户看到的是
 * `commands.upgrade.install_untouched` 这种东西，而套件全绿。这条守卫从 `commands.ts` 里
 * **把键抠出来**再逐个查（而不是另抄一份清单）：抄一份的话，改了 `commands.ts` 却忘了改这里，
 * 守卫守的就是那份没人渲染的副本。
 */
describe('失败文案 —— 四态在两份 locale 里都得有', () => {
  const readFlattened = (file: string): Set<string> => {
    const flat = (obj: unknown, prefix = ''): string[] =>
      Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => {
        const key = prefix ? `${prefix}.${k}` : k
        if (typeof v === 'string') return [key]
        return v && typeof v === 'object' ? flat(v, key) : []
      })
    return new Set(flat(JSON.parse(readFileSync(file, 'utf-8'))))
  }

  it('commands.upgrade 的四态键在两份 locale 里都在', () => {
    const cliDir = join(import.meta.dirname, '..', '..')
    const src = readFileSync(join(cliDir, 'src', 'ui', 'commands.ts'), 'utf-8')
    // 抠不出来即红（fail-closed）：改名/换形状都得先过这里，而不是静默地什么都不查。
    const block = /const UPGRADE_FAILURE_NOTE[^{]*\{([\s\S]*?)\n\}/.exec(src)
    expect(block, 'UPGRADE_FAILURE_NOTE 没抠到 —— 改了名字或形状就得改这条守卫').not.toBeNull()
    const keys = [...block![1]!.matchAll(/'([a-z][\w]*(?:\.[\w]+)+)'/g)].map((m) => m[1]!)
    // 四态 = 四条。少一条说明有状态落进了「没话可说」——那正是别的状态说话了、它没有。
    expect(new Set(keys).size).toBe(4)

    for (const locale of ['en-US', 'zh-CN']) {
      const flat = readFlattened(join(cliDir, 'src', 'i18n-core', 'locales', `${locale}.json`))
      for (const k of keys) expect(flat.has(k), `${locale} 缺键：${k}`).toBe(true)
    }
  })
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

  it('推出来的布局与独立复述一致，且把平台记在了结果里', () => {
    // `platform` 是**数据不是环境**：staging 的布局必须按当初推出 prefix 时的那个平台算，
    // 而不是在换手那一刻再读一次 process.platform。两处若各读各的，在跨平台测试注入下
    // （本文件就是这么跑的）会算出两份不同的布局。
    const p = resolveInstallPaths(f.fromDir)!
    expect({ pkgDir: p.pkgDir, launcher: p.launcher }).toEqual(expectedLayout(f.root, 'darwin'))
    expect(p.platform).toBe(process.platform)
  })
})

describe('resolveInstallPaths —— Windows 那半（开发机与 CI 都跑不到的那一格）', () => {
  it('Windows 形状用三层 `..`，launcher 在 <prefix>/mipham.cmd', () => {
    const p = resolveInstallPaths(win.fromDir, 'win32')
    expect(p).not.toBeNull()
    expect(p!.prefix).toBe(win.root)
    expect(p!.pkgDir).toBe(win.pkgDir)
    expect(p!.launcher).toBe(win.launcher)
  })

  it('「多退一层」单独钉住：旧的 Unix 算术在 Windows 上落在 root 的父目录', () => {
    // 这不是同义反复，它就是缺陷本身 —— 四层 `..` 与三层差的正是这一格，而 launcher 会随之
    // 指向 <root 的父目录>/mipham.cmd（永远不存在 ⇒ 自证必红 ⇒ 每次更新把刚装好的新版回滚掉）。
    expect(resolve(win.pkgDir, '..', '..', '..', '..')).toBe(resolve(win.root, '..'))
    expect(resolveInstallPaths(win.fromDir, 'win32')!.prefix).not.toBe(resolve(win.root, '..'))
  })

  it('Windows 分支也要过对照物检查（旧代码在这条分支上跳过了它）', () => {
    rmSync(join(win.root, 'npm.cmd'), { force: true })
    expect(resolveInstallPaths(win.fromDir, 'win32')).toBeNull()
  })

  it('平台不会被形状蒙对：Unix 形状在 win32 下推不出', () => {
    // 少了这条，`platform` 参数被无视也能全绿 —— 那恰好就是出事的那个假设（拿 Unix 布局去
    // 算 Windows 的 prefix）。
    expect(resolveInstallPaths(f.fromDir, 'win32')).toBeNull()
  })

  it('layoutFor 的两条分支与独立复述一致，且各有各的 `lib` 层', () => {
    // 这一格是 D14 的正面判据：Windows **没有** `lib` 层、launcher 直接落在 prefix 上。
    expect(layoutFor('/p', 'win32')).toEqual({
      prefix: '/p',
      platform: 'win32',
      ...expectedLayout('/p', 'win32'),
    })
    expect(layoutFor('/p', 'darwin')).toEqual({
      prefix: '/p',
      platform: 'darwin',
      ...expectedLayout('/p', 'darwin'),
    })
    expect(layoutFor('/p', 'win32').pkgDir).not.toContain(`${sep}lib${sep}`)
    expect(layoutFor('/p', 'darwin').pkgDir).toContain(`${sep}lib${sep}`)
  })

  it('按该形状端到端：装好 ⇒ 自证过 ⇒ 不回滚', () => {
    // 只钉 prefix 那两个字符串是不够的：launcher 名字若没跟着平台走，自证照样红、照样回滚。
    // 判据必须三个一起看：ok + verified 才叫装上，installState 缺席才叫没白装。
    const res = performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(win.fromDir, 'win32'),
      install: fakeNpm('ok', '9.9.9', [], 'win32'),
    })
    expect(res).toMatchObject({ ok: true, verified: true })
    expect(installedVersion(win.pkgDir)).toBe('9.9.9')
    // shim 按自身位置解析 ⇒ 换手后自动指向新树，自己始终没被改过。
    expect(launcherRuns(win.launcher)).toContain('9.9.9')
  })
})

describe('performUpdate —— 我们自己绝不能杀掉安装进程', () => {
  it('install 这一步不带 timeout（事故的根因就是它）', () => {
    const seen: SeenCall[] = []
    performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      install: fakeNpm('ok', '9.9.9', seen),
    })
    expect(seen).toHaveLength(1)
    // 负控：把 `timeout: 600_000` 加回去，本断言即红。判据是「有没有一个能在
    // 正常安装途中开火的计时器」—— 本机实测该包下载 >11 分钟，而它设在 10 分钟。
    expect(seen[0]!.opts).not.toHaveProperty('timeout')
  })
})

/**
 * 0.85.0 修好了「装前快照 / 装后自证 / 失败回滚」，但**回滚代码跑在 CLI 进程里** ——
 * 终端按 Ctrl-C 时 SIGINT 发给**整个前台进程组**，CLI 与 npm 一起死 ⇒ catch 永远不执行，
 * 用户手里还是半截树、而且**没有人回滚**。
 *
 * 两道守卫，缺一被保下来的都只是一半：
 *   · `detached: true`（调用点）—— npm 自成进程组，终端的 SIGINT 到不了它；
 *   · `blockSigintDuringInstall()` —— CLI 自己不被那条信号打死，好让换手/回滚有机会跑。
 *
 * **边界（只做了一半，如实记下）**：
 *   1. 「安装期间 Ctrl-C 会被忽略」是本修法的**代价**，不是附带好处 —— 用户按了没用，
 *      要中断只能另开一个终端杀进程。本次只落了代码与测试；**发布那一笔必须写进
 *      `CHANGELOG.md`**（用户可见的行为变化）。
 *   2. TUI（`/upgrade`）路径自带 SIGINT 处理，安装完成后它仍可能被投递；本守位只保证
 *      **CLI 在安装窗口内不死**，不改 TUI 的行为。
 *   3. 守位盖的是「安装 → 自证 → 换手」整段（D12 之前只盖安装那一段）：换手那两次 rename
 *      是磁盘上唯一还会被中途打断的地方，它必须在守位之内。
 */
describe('performUpdate —— 终端 Ctrl-C 不能把安装打断到一半', () => {
  it('install 这一步带 detached:true（npm 自成进程组，终端的 SIGINT 到不了它）', () => {
    const seen: SeenCall[] = []
    performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      install: fakeNpm('ok', '9.9.9', seen),
    })
    expect(seen).toHaveLength(1)
    // 负控：删掉调用点的 `detached: true`，本断言即红。
    // 边界：这里断的是「选项送出去了」；「detached 真的换了进程组」是 Node/POSIX 的行为，
    // 已用真命令行探针在本机验过（detached 的子进程 pgid ≠ 父进程，未 detached 的 == 父进程），
    // 但那是探针不是本套件 —— 别把这条绿读成「进程组语义已被 CI 覆盖」。
    expect(seen[0]!.opts.detached).toBe(true)
  })

  it('从安装到换手，全程 CLI 挂着 SIGINT 守位，收尾立刻撤掉', () => {
    const base = process.listenerCount('SIGINT')
    let duringInstall = -1
    let duringSwap = -1
    performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      install: (cmd, opts) => {
        duringInstall = process.listenerCount('SIGINT')
        fakeNpm('ok', '9.9.9')(cmd, opts)
      },
    })
    // 换手那两次 rename 无法打桩（它们是真 fs 调用），所以「守位盖住换手」由**时序**证：
    // 守位是在 install 之前挂的、在 finally 里撤的，install 时挂着 ⇒ 换手时也挂着。
    duringSwap = duringInstall
    expect(duringInstall).toBe(base + 1)
    expect(duringSwap).toBe(base + 1)
    // 漏撤的话，handler 会活到进程结束 —— TUI 里 Ctrl-C 从此**永远**没反应，比原来更糟。
    expect(process.listenerCount('SIGINT')).toBe(base)
  })

  it('安装中途抛错时守位也要撤掉（挂在 finally 上，不是只有成功路径）', () => {
    const base = process.listenerCount('SIGINT')
    performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      install: fakeNpm('killed', '9.9.9'),
    })
    expect(process.listenerCount('SIGINT')).toBe(base)
  })

  it('真往自己发一个 SIGINT（终端那条 Ctrl-C 打到 CLI 的形状）：进程活着，安装照跑完', () => {
    // 负控：把 `blockSigintDuringInstall()` 换成空壳（`() => () => {}`），**本进程当场死**
    // —— vitest 会把该 worker 记成失败。这条负控是「进程死」而不是「断言红」，跑它之前
    // 先确认 vitest 真的把它算失败（实测过才写在这里）。
    const r = performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      install: (cmd, opts) => {
        process.kill(process.pid, 'SIGINT')
        // 阻塞着收信号 —— 正是事故的时序：信号到达时事件循环在 execSync 里。
        execSync('sleep 0.3')
        fakeNpm('ok', '9.9.9')(cmd, opts)
      },
    })
    expect(r.ok).toBe(true)
    expect(r.verified).toBe(true)
  })
})

describe('performUpdate —— 真包目录在验过之前一个字节都不动', () => {
  it('装的是旁边的暂存 prefix（同 <prefix> 之下，才可能 rename 原子）', () => {
    const seen: SeenCall[] = []
    performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      install: fakeNpm('ok', '9.9.9', seen),
    })
    // 判据一：命令里指定了 prefix，且路径**带引号**（`/Users/John Doe/…` 这种 prefix 存在）。
    expect(seen[0]!.cmd).toContain('--prefix "')
    // 判据二：暂存落在 <prefix> 之下 —— 不是 os.tmpdir()。跨文件系统的 rename 是 EXDEV，
    // 那样就不是「原子换手」而是「复制换手」，本笔改动的意义归零。
    const m = /--prefix "([^"]+)"/.exec(seen[0]!.cmd)!
    expect(m[1]!.startsWith(f.root + sep)).toBe(true)
    expect(m[1]!).not.toBe(f.root)
  })

  it('npm 跑的那一刻，旧树内容逐字节未变（用 sha256 读，不用「文件在不在」）', () => {
    const before = treeHash(f.pkgDir)
    let during: string | null = null
    performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      install: (cmd, opts) => {
        during = treeHash(f.pkgDir)
        fakeNpm('ok', '9.9.9')(cmd, opts)
      },
    })
    // 这就是「事故按构造消失」的判据：以前这一刻旧树已经被 npm 删了一半。
    expect(during).toBe(before)
  })

  it('安装进程被杀（事故原形）⇒ 旧树 untouched，且用户手上仍是能跑的旧版', () => {
    const before = treeHash(f.pkgDir)
    const r = performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      install: fakeNpm('killed', '9.9.9'),
    })
    expect(r).toMatchObject({ ok: false, verified: false, installState: 'untouched' })
    // 判据：用户手里还有能跑的 CLI，而不是「一个都没有」。
    expect(treeHash(f.pkgDir)).toBe(before)
    expect(installedVersion(f.pkgDir)).toBe('0.83.0')
    expect(launcherRuns(f.launcher)).toContain('0.83.0')
    // 失败的暂存不留残骸（否则每次都往 prefix 里攒半棵树）。
    expect(tempEntries(f.root)).toEqual([])
  })

  it('npm 静默留下半截暂存树（退出码是 0）⇒ 必须判失败、且旧树没被碰过', () => {
    // 这是旧代码的盲区：它只看 npm 的退出码，于是会印「✓ Updated」。现在这一格红在**自证**，
    // 而真树从来没参与 —— 所以是 untouched（旧树沿用），不是 restored（回滚过）。
    const before = treeHash(f.pkgDir)
    const r = performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      install: fakeNpm('silent-break', '9.9.9'),
    })
    expect(r).toMatchObject({ ok: false, installState: 'untouched' })
    expect(r.ok === false && r.reason).toBeTruthy()
    expect(treeHash(f.pkgDir)).toBe(before)
    expect(launcherRuns(f.launcher)).toContain('0.83.0')
    expect(tempEntries(f.root)).toEqual([])
  })

  it('暂存树里 launcher 没落位 ⇒ 失败在自证，旧树不动', () => {
    const r = performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      install: fakeNpm('missing-launcher', '9.9.9'),
    })
    expect(r).toMatchObject({ ok: false, installState: 'untouched' })
    expect(launcherRuns(f.launcher)).toContain('0.83.0')
  })

  it('暂存树装成了别的版本 ⇒ 失败在自证，旧树不动', () => {
    const r = performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      install: fakeNpm('wrong-version', '9.9.9'),
    })
    expect(r).toMatchObject({ ok: false, installState: 'untouched' })
    expect(installedVersion(f.pkgDir)).toBe('0.83.0')
  })

  it('没有旧安装（全新）时失败**不许**报 untouched —— 那会谎称 mipham 还能用', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'mipham-update-fresh-'))
    try {
      const r = performUpdate('9.9.9', undefined, {
        paths: layoutFor(fresh, 'darwin'),
        install: () => {
          throw new Error('boom')
        },
      })
      expect(r).toMatchObject({ ok: false, installState: 'broken' })
      expect(r.ok === false && r.reason).toBeTruthy()
    } finally {
      rmSync(fresh, { recursive: true, force: true })
    }
  })

  it('非法版本号直接拒绝，不碰安装，且报 untouched（磁盘确实没动过）', () => {
    const install = vi.fn()
    const r = performUpdate('9.9.9; rm -rf /', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      install,
    })
    expect(r).toMatchObject({ ok: false, installState: 'untouched' })
    expect(install).not.toHaveBeenCalled()
  })
})

describe('performUpdate —— 换手：两次 rename，且只搬包目录', () => {
  it('成功：新树就位、旧树与暂存壳都不留', () => {
    const r = performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      install: fakeNpm('ok', '9.9.9'),
    })
    expect(r).toMatchObject({ ok: true, verified: true, version: '9.9.9' })
    expect(installedVersion(f.pkgDir)).toBe('9.9.9')
    expect(tempEntries(f.root)).toEqual([])
  })

  it('launcher 跨换手**逐字节未改**，却自动指向新树（相对符号链接是支点）', () => {
    const before = readlinkSync(f.launcher)
    performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      install: fakeNpm('ok', '9.9.9'),
    })
    // 「没改」与「仍然有效」两个都要断：只断前者，launcher 指向一个空路径也能绿。
    expect(readlinkSync(f.launcher)).toBe(before)
    expect(launcherRuns(f.launcher)).toContain('9.9.9')
  })

  it('换手后自证不过 ⇒ 反向换手把旧树**原样**拿回来（rename，不是复制）', () => {
    // 造一个「不跟着包目录走」的 launcher：它自己打印旧版本，与 pkgDir 无关。真实世界里
    // 对应的是被复制而非链接的 launcher（换手搬的是包目录，复制出来的那份不会跟着变）。
    // 这一格是「换手后再验一次」这道廉价保险的全部理由 —— staging 里跑得过 ≠ 搬过来也跑得过。
    mkdirSync(join(f.root, 'bin'), { recursive: true })
    rmSync(f.launcher, { force: true })
    writeFileSync(f.launcher, launcherScript('0.83.0'))
    chmodSync(f.launcher, 0o755)

    const before = treeHash(f.pkgDir)
    const r = performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      install: fakeNpm('ok', '9.9.9'),
    })
    expect(r).toMatchObject({ ok: false, verified: false, installState: 'restored' })
    // 「拿回来的是原来那一棵」—— 逐字节比，而不是「文件在不在」。
    expect(treeHash(f.pkgDir)).toBe(before)
    expect(installedVersion(f.pkgDir)).toBe('0.83.0')
    expect(tempEntries(f.root)).toEqual([])
  })

  it('上一次被杀的残留（暂存壳 / 停放地）会被这次运行清掉', () => {
    const staleStaging = join(f.root, '.mipham-staging-2026-01-01T00-00-00-000Z')
    const staleParked = join(f.root, '.mipham-old-2026-01-01T00-00-00-000Z')
    for (const d of [staleStaging, staleParked]) {
      mkdirSync(join(d, 'lib', 'node_modules', '@miphamai', 'cli', 'bin'), { recursive: true })
      writeFileSync(join(d, 'lib', 'node_modules', '@miphamai', 'cli', 'package.json'), '{}')
    }
    performUpdate('9.9.9', undefined, {
      paths: resolveInstallPaths(f.fromDir),
      install: fakeNpm('ok', '9.9.9'),
    })
    expect(existsSync(staleStaging)).toBe(false)
    expect(existsSync(staleParked)).toBe(false)
  })
})
