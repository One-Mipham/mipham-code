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
  cpSync,
  rmSync,
  readdirSync,
  lstatSync,
  readlinkSync,
  symlinkSync,
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
  /** <prefix>/lib/node_modules/@miphamai/cli */
  pkgDir: string
  /** <prefix>/bin/mipham（Windows 下是 mipham.cmd） */
  launcher: string
}

/**
 * 推出全局安装路径。`fromDir` 只为测试可注入，默认本模块所在目录（<pkgDir>/src/shared）。
 *
 * 推不出时返回 **null**，绝不猜：`../../../..` 只是算术，它不能证明这个路径真的是一个
 * node prefix。对照物是 `<prefix>/bin/npm` —— 真 prefix 一定有，猜出来的路径不一定有。
 */
export function resolveInstallPaths(fromDir?: string): InstallPaths | null {
  const base = fromDir ?? import.meta.dirname
  if (!base) return null
  const pkgDir = resolve(base, '..', '..')
  if (!existsSync(join(pkgDir, 'package.json'))) return null
  const prefix = resolve(pkgDir, '..', '..', '..', '..')
  if (process.platform === 'win32') {
    return { prefix, pkgDir, launcher: join(prefix, 'mipham.cmd') }
  }
  if (!existsSync(join(prefix, 'bin', 'npm'))) return null
  return { prefix, pkgDir, launcher: join(prefix, 'bin', 'mipham') }
}

/** 安装前的快照。npm 是就地重写，出事时没有第二份可选 —— 只有这个。 */
interface InstallSnapshot {
  dir: string
  pkgCopy: string
  launcherExisted: boolean
  /** 符号链接的原样目标（相对路径也要原样存回） */
  launcherTarget: string | null
  /** 普通文件形态的 launcher 存到包副本**之外**，否则会被当成多出来的文件还原进 pkgDir */
  launcherFile: string | null
}

const SNAPSHOT_PREFIX = 'cli-'

function readPkgVersion(pkgDir: string): string | undefined {
  try {
    return (JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8')) as { version?: string })
      .version
  } catch {
    return undefined
  }
}

/**
 * 把当前安装整份存下来。返回 null 表示**存不下来** —— 那时不得回滚（没有可回的东西）。
 * 会先清掉上一次运行留下的 `cli-*` 残留：那是被中断的上一次，它备份的树早已不是任何人的安装。
 */
function snapshotInstall(
  paths: InstallPaths,
  label: string,
  backupRoot: string,
): InstallSnapshot | null {
  try {
    mkdirSync(backupRoot, { recursive: true, mode: 0o700 })
    for (const entry of readdirSync(backupRoot)) {
      if (entry.startsWith(SNAPSHOT_PREFIX))
        rmSync(join(backupRoot, entry), { recursive: true, force: true })
    }
    const dir = join(
      backupRoot,
      `${SNAPSHOT_PREFIX}${label}-${new Date().toISOString().replace(/[:.]/g, '-')}`,
    )
    const pkgCopy = join(dir, 'pkg')
    cpSync(paths.pkgDir, pkgCopy, { recursive: true })

    let launcherExisted = false
    let launcherTarget: string | null = null
    let launcherFile: string | null = null
    try {
      launcherExisted = true
      if (lstatSync(paths.launcher).isSymbolicLink()) {
        launcherTarget = readlinkSync(paths.launcher)
      } else {
        launcherFile = join(dir, 'launcher')
        copyFileSync(paths.launcher, launcherFile)
      }
    } catch {
      launcherExisted = false // launcher 本来就不在，快照还原不了从未存在的东西
    }
    return { dir, pkgCopy, launcherExisted, launcherTarget, launcherFile }
  } catch {
    return null
  }
}

/** 把快照放回去。返回是否放成功 —— 失败必须如实上报，不能让调用方以为用户还有 CLI。 */
function restoreInstall(snap: InstallSnapshot, paths: InstallPaths): boolean {
  try {
    rmSync(paths.pkgDir, { recursive: true, force: true })
    cpSync(snap.pkgCopy, paths.pkgDir, { recursive: true })
    if (snap.launcherExisted && !existsSync(paths.launcher)) {
      if (snap.launcherTarget !== null) {
        symlinkSync(snap.launcherTarget, paths.launcher)
      } else if (snap.launcherFile !== null) {
        copyFileSync(snap.launcherFile, paths.launcher)
        chmodSync(paths.launcher, 0o755)
      }
    }
    return true
  } catch {
    return false
  }
}

function discardSnapshot(snap: InstallSnapshot | null): void {
  if (!snap) return
  try {
    rmSync(snap.dir, { recursive: true, force: true })
  } catch {
    // 删不掉就留着；下一次运行开头的清理会收掉它
  }
}

export interface InstallVerification {
  ok: boolean
  /** 包自报的版本 */
  actual?: string
  reason?: string
}

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

export interface UpdateDeps {
  install?: InstallRunner
  /** 覆盖路径解析；传 `null` 表示「推不出布局」。默认自动推断。 */
  paths?: InstallPaths | null
  /** 快照根目录，默认 `~/.mipham/backups`。 */
  backupRoot?: string
}

export interface UpdateResult {
  ok: boolean
  /** 只有跑过自证才算 true —— 「装完没验证」不许冒充成功 */
  verified: boolean
  /** 失败后旧安装是否被放了回去 */
  rolledBack: boolean
  version?: string
  reason?: string
}

/**
 * 真正执行更新：先快照 → `npm install -g` → 自证 → 失败则回滚。
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
    return { ok: false, verified: false, rolledBack: false, reason: `版本号非法：${version}` }
  }

  // Sanitize registry — only allow known URLs to prevent command injection
  const allowedRegistries = REGISTRIES.map((r) => r.url)
  const safeRegistry = registry && allowedRegistries.includes(registry) ? registry : undefined

  const registryFlag = safeRegistry ? ` --registry=${safeRegistry}` : ''

  const paths = deps.paths !== undefined ? deps.paths : resolveInstallPaths()
  const backupRoot = deps.backupRoot ?? join(miphamHome(), 'backups')
  /** 生产用的 runner：把调用点给的选项原样交给 execSync（不另起一套）。 */
  const defaultInstall: InstallRunner = (command, options) => {
    execSync(command, options)
  }
  const install: InstallRunner = deps.install ?? defaultInstall

  // 快照必须在安装**之前**：npm 就地重写全局包目录，安装一旦开始，旧树就没了。
  let snap: InstallSnapshot | null = null
  if (paths)
    snap = snapshotInstall(paths, readPkgVersion(paths.pkgDir) ?? getCurrentVersion(), backupRoot)

  // 安装期间两道守卫（缺一，被保下来的都只有一半）：
  //   · 这里 —— CLI 自己不被 SIGINT 打死，好让下面的 catch/回滚有机会跑；
  //   · 下面的 `detached: true` —— npm 自成进程组，终端的 SIGINT 到不了它。
  //
  // 守位只盖住「npm 在跑」这一段 —— 也就是**唯一会破坏磁盘**的那一段。两端各留一个
  // 未覆盖的窄口，各自无害：① 它前面的快照（复制 6601 个文件）期间按 Ctrl-C ⇒ CLI 退出、
  // npm 从未启动，旧树完好；② 它后面的自证（只读：读 package.json + 跑一次 launcher）
  // 期间按 Ctrl-C ⇒ 不再自动回滚，但树是**完整的**，不是「一个 CLI 都没有」。
  const unblockSigint = blockSigintDuringInstall()
  try {
    // 这里**故意不设 timeout**。任何一个能在正常安装途中开火的计时器，开火那一刻就是破坏
    // 本身：npm 被 SIGTERM 时会留下半截树（旧包已删、新包没写完）⇒ 用户一个 CLI 都没有，
    // 连 `mipham update` 本身也没了。本机实测这个包的下载要 11 分钟以上，而原来设在 10 分钟。
    // 进度由 npm 自己印在用户终端上（stdio: 'inherit'），要中断交由用户决定。
    //
    // detached 只换进程组、不换等待语义 —— 实测 execSync 照样阻塞到 npm 退出（1.01s vs
    // 未 detached 的 1.02s），所以自证仍在装完之后；stdio:'inherit' 下它的输出也照样
    // 打在用户终端上（两条通道都实测可见）。
    install(`npm install -g ${PACKAGE}@${version}${registryFlag}`, {
      encoding: 'utf-8',
      stdio: 'inherit',
      detached: true,
    })
  } catch (err) {
    const rolledBack = paths && snap ? restoreInstall(snap, paths) : false
    discardSnapshot(snap)
    const detail = err instanceof Error && err.message ? `（${err.message.split('\n')[0]}）` : ''
    return { ok: false, verified: false, rolledBack, reason: `安装进程被中断${detail}` }
  } finally {
    unblockSigint()
  }

  if (!paths) {
    // 推不出布局 ⇒ 自证不了。如实返回「装了但没验证」，绝不印「✓ 已更新」。
    discardSnapshot(snap)
    return {
      ok: true,
      verified: false,
      rolledBack: false,
      version,
      reason: '无法定位全局安装路径，未能验证',
    }
  }

  const check = verifyInstalledVersion(paths, version)
  if (!check.ok) {
    const rolledBack = snap ? restoreInstall(snap, paths) : false
    discardSnapshot(snap)
    return { ok: false, verified: false, rolledBack, version, reason: check.reason }
  }

  discardSnapshot(snap)
  return { ok: true, verified: true, rolledBack: false, version }
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
