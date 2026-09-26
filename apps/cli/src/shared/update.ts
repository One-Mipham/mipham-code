/**
 * Mipham Code — Self-update utilities.
 *
 * Shared between the CLI entry point (bin/mipham.ts) and the TUI slash
 * command handler (commands.ts) so that both `mipham update` and `/upgrade`
 * use the same logic.
 */

import {
  readFileSync,
  existsSync,
  copyFileSync,
  mkdirSync,
  chmodSync,
  rmSync,
  renameSync,
  readdirSync,
} from 'node:fs'
import { join, resolve } from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import { PACKAGE_VERSION } from './package-info'
import { miphamHome } from '../core/paths.ts'

const PACKAGE = '@miphamai/cli'
const MIPHAM_HOME = miphamHome()
const CONFIG_PATH = join(MIPHAM_HOME, 'config.yml')

// Registry fallback chain: npm default → npmmirror (China mirror)
const REGISTRIES = [
  { name: 'npm', url: 'https://registry.npmjs.org/' },
  { name: 'npmmirror', url: 'https://registry.npmmirror.com/' },
]

export interface UpdateCheck {
  /** Current installed version */
  current: string
  /** Latest version on npm — only meaningful when `checked` is true */
  latest: string
  /** Whether an update is available */
  available: boolean
  /**
   * Whether the registry was actually reached.
   *
   * `false` means `latest`/`available` carry **no information**: the check
   * failed and `latest` is just `current`. Without this field the two states
   * are the same value — "we asked, you're current" and "we couldn't ask" both
   * read as `available: false`, which is how `/upgrade` came to print
   * "Already up to date" while offline.
   */
  checked: boolean
}

/**
 * Read the currently installed version from package.json.
 */
export function getCurrentVersion(): string {
  try {
    // Try the CLI's own package.json first
    const cliPkg = join(import.meta.dirname!, '..', '..', 'package.json')
    if (existsSync(cliPkg)) {
      const pkg = JSON.parse(readFileSync(cliPkg, 'utf-8'))
      return pkg.version
    }
  } catch {
    // fall through
  }
  return 'unknown'
}

/**
 * Run `npm view` against a specific registry with a given timeout.
 * Returns the version string, or throws on failure.
 */
function tryRegistry(registry: string, timeoutMs: number): string {
  const result = execSync(`npm view ${PACKAGE} version --json --registry=${registry}`, {
    encoding: 'utf-8',
    timeout: timeoutMs,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
  return result.replace(/"/g, '')
}

/**
 * Fetch the latest version from the npm registry with retry + mirror fallback.
 *
 * Strategy:
 *   1. Try npm default registry (10s timeout)
 *   2. Retry npm default registry (20s timeout)
 *   3. Fall back to npmmirror.com — China mirror (15s timeout)
 *
 * Returns the version string, or throws on all failures.
 */
function fetchLatestVersion(): string {
  const attempts: Array<{ registry: string; timeout: number }> = [
    { registry: REGISTRIES[0]!.url, timeout: 10_000 },
    { registry: REGISTRIES[0]!.url, timeout: 20_000 },
    { registry: REGISTRIES[1]!.url, timeout: 15_000 },
  ]

  let lastError: Error | null = null

  for (const attempt of attempts) {
    try {
      return tryRegistry(attempt.registry, attempt.timeout)
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err))
      // Continue to next attempt
    }
  }

  throw lastError ?? new Error('Failed to fetch latest version')
}

/**
 * Check if an update is available by comparing the local version
 * against the npm registry.
 */
export function checkForUpdates(): UpdateCheck {
  const current = getCurrentVersion()
  let latest = current
  let available = false
  let checked = false

  try {
    latest = fetchLatestVersion()
    available = compareVersions(latest, current) > 0
    checked = true
  } catch {
    // Registry unreachable — stay quiet rather than alarm, but do **not** claim
    // we are current: `checked: false` is what lets `/upgrade` say "couldn't
    // check" instead of "Already up to date".
  }

  return { current, latest, available, checked }
}

/**
 * Back up the user's config.yml before an update.
 * Returns the backup path, or null if backup wasn't possible.
 */
export function backupConfig(label: string): string | null {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    mkdirSync(MIPHAM_HOME, { recursive: true, mode: 0o700 })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = join(MIPHAM_HOME, `config.pre-${label}-${ts}.yml`)
    copyFileSync(CONFIG_PATH, backupPath)
    chmodSync(backupPath, 0o600) // owner read/write only — contains API keys
    return backupPath
  } catch {
    return null
  }
}

/** Validate a semver string before passing it to a shell command. */
const SEMVER_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/

function isValidSemver(v: string): boolean {
  return SEMVER_RE.test(v)
}

/** 全局安装的三个位置。 */
export interface InstallPaths {
  /** node prefix，例如 ~/.nvm/versions/node/v24.14.0 */
  prefix: string
  /** <prefix>/lib/node_modules/@miphamai/cli（Windows 下**没有** `lib` 这一层） */
  pkgDir: string
  /** <prefix>/bin/mipham（Windows 下是 <prefix>/mipham.cmd） */
  launcher: string
  /**
   * 这套布局是按哪个平台算出来的 —— **数据，不是环境**。
   *
   * 换手时要给 staging 也推一套布局，而那套**必须与本套同一套算术**：各自去读
   * `process.platform` 的话，注入 Windows 形状的调用方会拿到 Unix 形状的 staging 目录，
   * 而 D14 那个活缺陷正是「同一套平台知识存在两份、只修了一份」。把它带在结构里，
   * 两者就不可能不一致。
   */
  platform: NodeJS.Platform
}

/**
 * 由 node prefix 推出三个位置。**纯算术，不做任何校验** —— 校验在 `resolveInstallPaths`，
 * 因为它的对照物（`<prefix>/bin/npm`）只有**真** node prefix 里才有；换手用的 staging prefix
 * 是我们自己造的，里面当然没有 npm，拿同一把尺子去量它只会把它判成「不是 prefix」。
 *
 * **两个平台差一层**（2026-09-25 修）。npm 把全局包装进 `<prefix>/lib/node_modules`
 * （Unix）或 `<prefix>/node_modules`（**Windows 无 `lib`**）—— 见 npm 自带源码 `lib/npm.js`
 * 的 `globalDir`（`process.platform !== 'win32' ? <prefix>/lib/node_modules : <prefix>/node_modules`）；
 * bin 的落点也是同形状的一个分支（`bin-links/lib/bin-target.js`：全局装时
 * `dirname(prefix)/bin` 对 **`prefix` 本身**）。
 *
 * **这两个分支只写在这里一处。** 别处再抄一遍就是 D14 的重演：那次是 Unix 的四层 `..` 被
 * 抄到了 Windows 分支上，于是 `launcher` 指向 `<prefix 的父目录>/mipham.cmd`（永远不存在）
 * ⇒ 自证必红 ⇒ **每次 `mipham update` 都把刚装好的新版回滚掉**，而因为 Windows 那半在开发机
 * 与 CI 上都跑不到，它活了很久。
 */
export function layoutFor(prefix: string, platform: NodeJS.Platform): InstallPaths {
  if (platform === 'win32') {
    // <prefix>/node_modules/@miphamai/cli；shim 直接落在 <prefix>（没有 bin/）
    return {
      prefix,
      platform,
      pkgDir: join(prefix, 'node_modules', ...PACKAGE.split('/')),
      launcher: join(prefix, 'mipham.cmd'),
    }
  }
  // <prefix>/lib/node_modules/@miphamai/cli；launcher 在 <prefix>/bin
  return {
    prefix,
    platform,
    pkgDir: join(prefix, 'lib', 'node_modules', ...PACKAGE.split('/')),
    launcher: join(prefix, 'bin', 'mipham'),
  }
}

/**
 * 推出全局安装路径。`fromDir` 与 `platform` 只为测试可注入，后者默认 `process.platform`。
 *
 * 推不出时返回 **null**，绝不猜：`../../../..` 只是算术，它不能证明这个路径真的是一个
 * node prefix。对照物是 `<prefix>/bin/npm` —— 真 prefix 一定有，猜出来的路径不一定有。
 * （**这一步不能省**，而 Windows 分支过去恰好跳过了它：`platform` 是**参数**而不是直接读
 * `process.platform`，正是为了让 Windows 那半也能在任何机器上被真跑，见
 * `test/shared/update-safety.test.ts` 的 Windows 形状夹具。）
 */
export function resolveInstallPaths(
  fromDir?: string,
  platform: NodeJS.Platform = process.platform,
): InstallPaths | null {
  const base = fromDir ?? import.meta.dirname
  if (!base) return null
  const pkgDir = resolve(base, '..', '..')
  if (!existsSync(join(pkgDir, 'package.json'))) return null

  // prefix 由 pkgDir 数 `..` 推出来：Unix 四层（多一层 `lib`）、Windows 三层。
  const prefix =
    platform === 'win32'
      ? resolve(pkgDir, '..', '..', '..')
      : resolve(pkgDir, '..', '..', '..', '..')

  // 对照物：真 node prefix 的 bin/ 里一定有 npm（Windows 是 npm.cmd）。少了这一格，
  // 拿到的就是「算出来的路径」，没有任何东西证明它真的是一个 node prefix。
  const marker = platform === 'win32' ? join(prefix, 'npm.cmd') : join(prefix, 'bin', 'npm')
  if (!existsSync(marker)) return null

  return layoutFor(prefix, platform)
}

/**
 * 换手用的两个临时名，都落在 `<prefix>` 下。
 *
 * **必须在 `<prefix>` 里**：rename 只在**同一文件系统**内原子，而 staging prefix 若建在
 * `os.tmpdir()` 之类的别处，跨设备 rename 直接抛 `EXDEV`（Linux 上 `/tmp` 常是 tmpfs）——
 * 那时就只能退回「复制」，而复制本身又成了「可被打断的中间态」，等于把刚拆掉的问题请回来。
 */
const STAGING_PREFIX = '.mipham-staging-'
const PARKED_PREFIX = '.mipham-old-'

function readPkgVersion(pkgDir: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8')) as { version?: string })
      .version
  } catch {
    return undefined
  }
}

/**
 * 删掉一棵临时树。**失败不抛** —— 收尾清理失败不该把一个已经成功的更新判成失败；
 * 删不掉的残留会在下一次运行开头的 `cleanStaleStaging()` 里被收掉。
 */
function rmIfPresent(target: string): void {
  try {
    rmSync(target, { recursive: true, force: true })
  } catch {
    // 见上：留着，下一次运行收
  }
}

/**
 * 清掉上一次被 SIGKILL / 断电留下的临时物。
 *
 * 它们**只可能是**我们自己的：真安装树从不会被删（只会被 rename），所以「一个 CLI 都没有」
 * 的形态在磁盘上留下的就是这样一堆 `.mipham-*`。清它们不会碰到任何人的安装。
 */
function cleanStaleStaging(prefix: string): void {
  let entries: string[]
  try {
    entries = readdirSync(prefix)
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.startsWith(STAGING_PREFIX) || entry.startsWith(PARKED_PREFIX))
      rmIfPresent(join(prefix, entry))
  }
}

/**
 * 同文件系统内的 rename —— 原子的那一步。返回是否成功，失败由调用方决定怎么报。
 *
 * 这是本模块唯一会改动真安装树的操作，而它**没有中间态**：目录要么在旧名、要么在新名，
 * 不存在「写到一半」。这正是它能扛住 SIGKILL / 断电、而 `cpSync` 扛不住的原因。
 */
function tryRename(from: string, to: string): boolean {
  try {
    renameSync(from, to)
    return true
  } catch {
    return false
  }
}

/**
 * 自证结果。**失败必带 `reason`** —— 写成 `ok: boolean` + `reason?: string` 的话，调用方
 * 拿到失败却读不到原因（`undefined` 一路飘到用户面前变成空句），而这四关每一关都能说清
 * 自己是怎么判的。
 */
export type InstallVerification =
  { ok: true; actual?: string } | { ok: false; actual?: string; reason: string }

/**
 * 装完之后的**自证**。两关，缺一不可：
 *   1. `<pkgDir>/package.json` 的版本就是目标版本（事故里它连同整棵树一起没了）；
 *   2. **launcher 真的能跑**并报出目标版本 —— 用户敲的是 `mipham --version`，不是读文件。
 * 只查退出码、或只查文件在不在，都会把「装坏了」读成成功。
 */
export function verifyInstalledVersion(paths: InstallPaths, expected: string): InstallVerification {
  const actual = readPkgVersion(paths.pkgDir)
  if (actual === undefined) return { ok: false, reason: '安装树不完整：读不到 package.json' }
  if (actual !== expected)
    return { ok: false, actual, reason: `包装成了 ${actual}，目标是 ${expected}` }
  try {
    const out = execFileSync(paths.launcher, ['--version'], {
      encoding: 'utf-8',
      timeout: 20_000,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    }).trim()
    if (!out.includes(expected))
      return { ok: false, actual, reason: `launcher 报告 "${out}"，不含 ${expected}` }
  } catch (err) {
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err)
    return { ok: false, actual, reason: `launcher 跑不起来：${detail}` }
  }
  return { ok: true, actual }
}

/**
 * 传给 npm 调用的选项。**只此一处** —— 默认 runner 原样转发它，所以测试断的选项
 * 与生产跑的是同一个对象，不是一个长得像的副本。
 *
 * `detached: true`：npm 自成**进程组** ⇒ 终端按 Ctrl-C 时内核发出的 SIGINT
 * （只发给**前台**进程组）到不了它。没有这一条，Ctrl-C 会把 CLI 与 npm 一起打死在
 * `reify` 中间 —— 旧树已删、新树没写完。它与 `blockSigintDuringInstall()` 是一对：
 * 那条保住 CLI（好让下面的 catch 有机会回滚），这条保住 npm。
 */
export type InstallOptions = { encoding: 'utf-8'; stdio: 'inherit'; detached: true }

/**
 * 安装期间把 CLI 自己的 SIGINT 挡掉，返回「撤销」函数。
 *
 * 回滚代码就在 `performUpdate` 的 catch 里 —— 而终端按 Ctrl-C 时 SIGINT 发给**整个
 * 前台进程组**，CLI 与 npm 会一起死 ⇒ catch 永远不执行，用户手里留下半截树且**无人回滚**
 * （2026-09-22 事故里「回滚写了却没跑」的那一格）。
 *
 * ⚠️ 挂了 handler 之后信号**不会立刻**变成 JS 回调：事件循环正阻塞在 `execSync` 里，
 * 回调要等它返回才跑（实测打印顺序是「execSync 返回」在前、「handler 跑了」在后）。
 * 所以**不能**用一个标志位判断「用户按过 Ctrl-C」—— 读完 execSync 立刻看，它一定还是
 * `false`。本函数只保证进程活着，不做上报。
 *
 * ⚠️ 「安装期间 Ctrl-C 会被忽略」是**用户可见的行为变化** —— 本次改动只落在代码与测试，
 * 发布那一笔必须写进 `CHANGELOG.md`（别忘了它是代价，不是附带好处）。
 */
function blockSigintDuringInstall(): () => void {
  const swallow = (): void => {}
  process.on('SIGINT', swallow)
  return () => {
    process.off('SIGINT', swallow)
  }
}

/** 执行 `npm install -g`。可注入 —— 测试永不联网。 */
export type InstallRunner = (command: string, options: InstallOptions) => void

/**
 * 安装调用的选项。**只此一处** —— 默认 runner 原样转发它，所以测试断的选项与生产跑的
 * 是同一个对象，不是一个长得像的副本（2.94.0 那次负控回来是绿的，正是这个形状的教训）。
 */
const INSTALL_OPTIONS: InstallOptions = { encoding: 'utf-8', stdio: 'inherit', detached: true }

/** 失败原因的第一行 —— 完整栈打在终端上只会淹掉「为什么」。 */
function failureDetail(err: unknown): string {
  return err instanceof Error && err.message ? `（${err.message.split('\n')[0]}）` : ''
}

export interface UpdateDeps {
  install?: InstallRunner
  /** 覆盖路径解析；传 `null` 表示「推不出布局」。默认自动推断。 */
  paths?: InstallPaths | null
}

/**
 * 失败时**用户手上那棵树**的状态。它决定调用方印哪句话，所以必须如实 ——
 * 「没动过」是好消息，把它印成「未能恢复」就是对用户谎报他机器的状态。
 *
 * 注意这**不是**「我们做了什么」的记账，而是「你现在有什么」的回答：
 * 更新失败时用户只关心一件事 —— 我还能不能敲 `mipham`。
 */
export type InstallState =
  /** 旧安装未被本次更新改动过（staging 阶段就失败了，换手从未开始）—— 最常见的一种 */
  | 'untouched'
  /** 换手走到一半失败，已用反向 rename 把旧安装放回原位 */
  | 'restored'
  /** 已确认手上没有可用的 CLI（换手失败且放不回去；或本来就没有旧安装） */
  | 'broken'
  /** 推不出布局 ⇒ 装去了哪里、旧树怎样，都判断不了。保守按最坏情况报 */
  | 'unknown'

export type UpdateResult =
  | {
      ok: true
      /** 只有跑过自证才算 true —— 「装完没验证」不许冒充成功 */
      verified: boolean
      version: string
      reason?: string
    }
  | {
      ok: false
      verified: false
      installState: InstallState
      reason: string
      version?: string
    }

/**
 * 真正执行更新：**装在旁边 → 验过 → 两次 rename 换手**。
 *
 * 与「就地重写 + 失败回滚」的分别不是速度而是**可中断性**：旧写法里 npm 直接重写真包目录，
 * 于是在 `reify` 中途被任何不可捕获的终止（SIGKILL / 断电 / 容器被杀）打断，用户手上就是
 * 一棵半截树 —— 回滚代码在 CLI 进程里，而 CLI 已经死了，没人回滚。现在真包目录在**验过之前
 * 一个字节都不动**：除了换手那两次 rename 之间的微秒级窗口，任何时刻磁盘上都有一棵完整的树。
 *
 * 校验版本号后再进 shell（防命令注入）。
 *
 * @param version  目标 semver（必须通过 isValidSemver）。
 * @param registry 可选 registry URL，只接受已知 URL；省略则用 npm 默认。
 */
export function performUpdate(
  version: string,
  registry?: string,
  deps: UpdateDeps = {},
): UpdateResult {
  if (!isValidSemver(version)) {
    process.stderr.write(`⚠ Refusing to install invalid version: "${version}"\n`)
    return {
      ok: false,
      verified: false,
      installState: 'untouched',
      reason: `版本号非法：${version}`,
    }
  }

  // Sanitize registry — only allow known URLs to prevent command injection
  const allowedRegistries = REGISTRIES.map((r) => r.url)
  const safeRegistry = registry && allowedRegistries.includes(registry) ? registry : undefined

  const registryFlag = safeRegistry ? ` --registry=${safeRegistry}` : ''
  const spec = `${PACKAGE}@${version}${registryFlag}`

  const paths = deps.paths !== undefined ? deps.paths : resolveInstallPaths()
  /** 生产用的 runner：把调用点给的选项原样交给 execSync（不另起一套）。 */
  const defaultInstall: InstallRunner = (command, options) => {
    execSync(command, options)
  }
  const install: InstallRunner = deps.install ?? defaultInstall

  if (!paths) {
    // 推不出布局 ⇒ 连换手点在哪都不知道，做不了 staging。退回**旧行为**：就地装、不自证，
    // 并如实说明。这里没有任何安全网，所以旧树的状态是「不知道」而不是「没动过」。
    try {
      install(`npm install -g ${spec}`, INSTALL_OPTIONS)
    } catch (err) {
      return {
        ok: false,
        verified: false,
        installState: 'unknown',
        reason: `安装进程被中断${failureDetail(err)}`,
      }
    }
    return {
      ok: true,
      verified: false,
      version,
      reason: '无法定位全局安装路径，未能验证',
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const stagingPrefix = join(paths.prefix, `${STAGING_PREFIX}${stamp}`)
  const parkedDir = join(paths.prefix, `${PARKED_PREFIX}${stamp}`)
  // staging 的布局用 **paths 记下的那个平台**，不另读 process.platform —— 见 InstallPaths.platform。
  const staging = layoutFor(stagingPrefix, paths.platform)

  /** 失败时该怎么形容用户手上那棵树：换手没开始 ⇒ 没动过；本来就没有 ⇒ 没得用。 */
  const stateIfNotSwapped = (): InstallState => (existsSync(paths.pkgDir) ? 'untouched' : 'broken')

  cleanStaleStaging(paths.prefix)

  // 守位盖住**整段会改磁盘的窗口**：安装 → 自证 → 换手。换成 staging 之后 npm 那一段已经
  // 打不坏东西了（真树在旁边看着），但换手那两次 rename 是，而它们也是「CLI 被杀就会留下
  // 半截状态」的唯一去处。两端各留一个未覆盖的窄口，都只读：① 前面 `cleanStaleStaging()`
  // 只删我们自己的临时物；② 后面收尾删旧树 —— 那时新树已经就位并验过，删不掉只是占地方。
  const unblockSigint = blockSigintDuringInstall()
  try {
    // ① 装在旁边。真树此刻一个字节都没动 —— 这一步无论怎么被打断，用户手里都还是旧版。
    //
    // 这里**故意不设 timeout**。任何一个能在正常安装途中开火的计时器，开火那一刻就是破坏
    // 本身。本机实测这个包的下载要 11 分钟以上，而原来设在 10 分钟。进度由 npm 自己印在
    // 用户终端上（stdio: 'inherit'），要中断交由用户决定。
    //
    // detached 只换进程组、不换等待语义 —— 实测 execSync 照样阻塞到 npm 退出。它与
    // `blockSigintDuringInstall()` 是一对：那条保住 CLI，这条保住 npm。
    //
    // 路径进 shell 必须带引号：prefix 里可能有空格（`/Users/John Doe/.nvm/…`），实测
    // 双引号形式在 sh 与 cmd.exe 两侧都成立（真 npm + 带空格 prefix 已单独探过）。
    try {
      install(`npm install -g --prefix "${stagingPrefix}" ${spec}`, INSTALL_OPTIONS)
    } catch (err) {
      rmIfPresent(stagingPrefix)
      return {
        ok: false,
        verified: false,
        installState: stateIfNotSwapped(),
        version,
        reason: `安装进程被中断${failureDetail(err)}`,
      }
    }

    // ② 先在 staging 上自证。不过 ⇒ 删掉暂存，真树连碰都没碰过 ⇒ **根本不需要回滚**。
    const staged = verifyInstalledVersion(staging, version)
    if (!staged.ok) {
      rmIfPresent(stagingPrefix)
      return {
        ok: false,
        verified: false,
        installState: stateIfNotSwapped(),
        version,
        reason: staged.reason,
      }
    }

    // ③ 换手：两次 rename（同文件系统 ⇒ 各有原子性）。**launcher 全程不碰** —— 它是指向
    //    包目录的相对符号链接（Unix）或按 `%~dp0` 解析的 shim（Windows），包路径不变，
    //    它就永远有效。这也正是「只要搬包目录」是完整动作、不需要任何改写的原因。
    //
    //    旧树不是「备份」而是**从原地挪开的那一份**：拿它回滚是再一次 rename，不是复制 ——
    //    所以回滚这一步本身也不会被中途打断（复制会）。
    const hadOldInstall = existsSync(paths.pkgDir)
    if (hadOldInstall && !tryRename(paths.pkgDir, parkedDir)) {
      rmIfPresent(stagingPrefix)
      return {
        ok: false,
        verified: false,
        installState: 'untouched',
        version,
        reason: '无法把旧安装暂时移到一边（rename 失败，权限？）',
      }
    }
    if (!tryRename(staging.pkgDir, paths.pkgDir)) {
      // 旧树确实被挪开过 ⇒ 这一格只能是 `restored`（放回去了）或 `broken`（放不回去），
      // **不能**是 `untouched` —— 那个词的含义是「换手从未开始」。本来就没有旧树时也无所谓
      // 还原，直接按最坏情况报。
      const restored = hadOldInstall && tryRename(parkedDir, paths.pkgDir)
      rmIfPresent(stagingPrefix)
      return {
        ok: false,
        verified: false,
        installState: restored ? 'restored' : 'broken',
        version,
        reason: '换手失败：新树没能就位',
      }
    }

    // ④ 换手后再自证一次。廉价保险：在 staging 里跑得过不等于搬过来也跑得过 —— 树里若有
    //    安装期写死的**绝对**路径，它就是搬完才指错的。失败 ⇒ 反向换手把旧树拿回来。
    const swapped = verifyInstalledVersion(paths, version)
    if (!swapped.ok) {
      const badDir = `${parkedDir}-bad`
      const restored =
        tryRename(paths.pkgDir, badDir) && hadOldInstall && tryRename(parkedDir, paths.pkgDir)
      rmIfPresent(badDir)
      rmIfPresent(stagingPrefix)
      return {
        ok: false,
        verified: false,
        installState: restored ? 'restored' : 'broken',
        version,
        reason: swapped.reason,
      }
    }

    // ⑤ 收尾：旧树与暂存外壳都不再需要。删不掉也不改变结论（新树已就位并验过）。
    rmIfPresent(parkedDir)
    rmIfPresent(stagingPrefix)
    return { ok: true, verified: true, version }
  } finally {
    unblockSigint()
  }
}

/**
 * Restore config from a backup path.
 */
export function restoreConfig(backupPath: string): boolean {
  if (!existsSync(backupPath)) return false
  try {
    copyFileSync(backupPath, CONFIG_PATH)
    return true
  } catch {
    return false
  }
}

/**
 * Get the config path so callers can verify it survived.
 */
export function getConfigPath(): string {
  return CONFIG_PATH
}

/** 更新提示状态：有新版（未装）| 已装待重启。 */
export type UpdateStatus = { state: 'available' | 'installed'; latest: string }

/** registry /latest 端点（返回 {version}），npm → npmmirror 回退。 */
const LATEST_URLS = [
  'https://registry.npmjs.org/@miphamai%2fcli/latest',
  'https://registry.npmmirror.com/@miphamai%2fcli/latest',
]

/** fetch 拉最新版本，npm → npmmirror 回退（超时 10s/个）。 */
async function fetchLatestVersionAsync(): Promise<string> {
  let lastError: unknown = null
  for (const url of LATEST_URLS) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = (await res.json()) as { version?: string }
      if (data.version) return data.version
      throw new Error('no version in response')
    } catch (err) {
      lastError = err
    }
  }
  throw lastError ?? new Error('Failed to fetch latest version')
}

/** 非阻塞版本检查。current 用 PACKAGE_VERSION（编译期常量，二进制下可靠）。离线/失败 → available: false。 */
export async function checkForUpdatesAsync(): Promise<UpdateCheck> {
  const current: string = PACKAGE_VERSION
  let latest: string = current
  let available = false
  let checked = false
  try {
    latest = await fetchLatestVersionAsync()
    available = compareVersions(latest, current) > 0
    checked = true
  } catch {
    // offline → don't alarm the user, but don't report `available: false` as if
    // it were an answer either (`checked` is what keeps the two apart)
  }
  return { current, latest, available, checked }
}

/**
 * Compare two semver strings. Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}
