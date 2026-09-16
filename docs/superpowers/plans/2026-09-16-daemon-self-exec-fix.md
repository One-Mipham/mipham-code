# daemon 自启修复 实施计划（T2 · Plan A）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `mipham daemon start` 在**编译产物**里真正起得来，且起不来时**报错退出**（非零退出码 + stderr），不再谎报成功。

**Architecture:** 把「重新运行自己」从「拼脚本路径 + 裸 `bun`」改为 `spawn(process.execPath, [...selfArgvPrefix, '__daemon'])` —— 产物里 `process.execPath` 就是二进制本身，源码里是 `bun` 且脚本路径需再传一遍。daemon 进程体从 `bin/daemon.ts` 平移到 `src/daemon/launch.ts` 的 `runDaemonProcess()`，`bin/daemon.ts` 与新增的 `__daemon` 分支**共用同一份**实现。

**Tech Stack:** Bun 1.2+ / TypeScript strict / Vitest 5 / GitHub Actions

**Spec:** [`docs/superpowers/specs/2026-09-16-t2-terminal-bench-design.md`](../specs/2026-09-16-t2-terminal-bench-design.md) §二（本计划即该节的实现层展开；§三 adapter 另立 Plan B）

## Global Constraints

- **禁止在代码、日志、配置文件或提交历史中硬编码凭据、API 密钥、令牌**（集团级强制）。
- **cwd 必须继承** —— `daemonRoot = process.cwd()` 是 daemon 的路径白名单边界，spec §2.2 定为本修复与 §三 adapter 的**唯一硬接口**。实现里**不得**给 spawn 传 `cwd`。
- **不得再谎报成功** —— 起不来必须：非零退出码 + stderr 说明。`daemon start` 的返回值必须可被脚本判真伪（spec §2.2）。
- **源码路径必须保持可用** —— `bun run bin/mipham.ts daemon start` 现在正常，弄坏它是回归。`bin/daemon.ts` 保留。
- 提交信息遵循 Conventional Commits，结尾附 `Co-Authored-By: Claude Code <noreply@anthropic.com>`。
- **禁止自动提交** —— 计划里的 commit 步骤仅在用户明确授权执行本计划后才运行。
- 跑 `apps/cli` 全量测试**必须先 `cd apps/cli`**（`--root apps/cli` 不够：MCP 测试 spawn 子进程并继承 `process.cwd()`，从仓库根跑会有 31 个假红）。
- **文档任何时刻正确** —— 测试数/文件数变化的提交须在**同一提交内**回填 `apps/cli/CLAUDE.md` 的测试表、`### 修订历史`、`## 最近提交` 滚动窗口（各留 5 行，挤出的搬进 `docs/claude-md-history.md`）。数字以实跑为准，**不预填**。
- 提交前 `pnpm lint`；prettier 由 pre-push hook 兜底。

---

### Task 1: spawn 计划的形状 —— `selfArgvPrefix` / `userArgs` / `planDaemonSpawn`

**Files:**

- Create: `apps/cli/src/daemon/launch.ts`
- Test: `apps/cli/test/daemon/launch.test.ts`

**Interfaces:**

- Consumes: 无（本任务是最底层，纯函数）
- Produces:
  - `DAEMON_ENTRY: '__daemon'`
  - `selfArgvPrefix(argv1: string | undefined, execPath: string): string[]`
  - `userArgs(argv: readonly string[], argv1: string | undefined): string[]`
  - `planDaemonSpawn(opts?: { argv1?, execPath?, extraArgs?, logPath? }): SpawnPlan`
  - `interface SpawnPlan { command: string; args: string[]; options: SpawnOptions; logPath: string }`

**为什么三个函数一起做**：它们共用同一个判别式（`argv[1]` 是不是脚本路径），拆开会让判别式出现三份，回退时只改一处就是又一次「两条路径只接一条」。

- [ ] **Step 1: 写失败测试**

创建 `apps/cli/test/daemon/launch.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/daemon/launch.test.ts`
Expected: FAIL —— `Failed to resolve import "../../src/daemon/launch"`

- [ ] **Step 3: 写实现**

创建 `apps/cli/src/daemon/launch.ts`：

```ts
/**
 * Launching the daemon as a detached process.
 *
 * The daemon must be started by *the same program* the user invoked:
 *  - source mode (`bun run bin/mipham.ts`): argv[0] is bun, argv[1] the script
 *  - compiled binary (`dist/mipham`): argv[0] is the binary itself
 *
 * The previous implementation hardcoded `spawn('bun', ['run', <path>])`, which
 * broke both ways in a compiled binary: `bun` is not on PATH (that is the whole
 * point of shipping a binary), and `import.meta.url` resolves to a `$bunfs`
 * path that no freshly spawned interpreter can read.
 */

import { spawn, type SpawnOptions } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** argv sentinel that re-enters this program as a daemon. Not user-facing. */
export const DAEMON_ENTRY = '__daemon'

const DEFAULT_LOG_FILE = join(homedir(), '.mipham', 'daemon.log')

/**
 * Is this argv[1] a script path rather than a user argument?
 *
 * In source mode argv[1] is the entry script; in a compiled binary argv[1] is
 * already the first user argument. Extensions are the discriminator: `daemon`
 * has none, every entry script has one.
 */
function isScriptPath(argv1: string | undefined): boolean {
  return typeof argv1 === 'string' && /\.(ts|tsx|js|mjs|cjs)$/.test(argv1)
}

/** argv prefix that re-runs *this* program. */
export function selfArgvPrefix(argv1: string | undefined, execPath: string): string[] {
  return isScriptPath(argv1) ? [execPath, resolve(argv1 as string)] : [execPath]
}

/** The user-facing arguments, with the interpreter/script prefix stripped. */
export function userArgs(argv: readonly string[], argv1: string | undefined): string[] {
  return argv.slice(1 + (isScriptPath(argv1) ? 1 : 0))
}

export interface SpawnPlan {
  command: string
  args: string[]
  options: SpawnOptions
  logPath: string
}

/**
 * Pure: computes the spawn call without performing it, so the shape (argv[0],
 * missing cwd, detached) is assertable in a unit test that runs under the
 * source tree — where the original bug does *not* reproduce.
 */
export function planDaemonSpawn(
  opts: {
    argv1?: string | undefined
    execPath?: string
    extraArgs?: string[]
    logPath?: string
  } = {},
): SpawnPlan {
  const argv1 = 'argv1' in opts ? opts.argv1 : process.argv[1]
  const execPath = opts.execPath ?? process.execPath
  return {
    command: execPath,
    args: [...selfArgvPrefix(argv1, execPath), DAEMON_ENTRY, ...(opts.extraArgs ?? [])],
    // No `cwd`: the child must inherit this process's working directory.
    // `daemonRoot = process.cwd()` is the daemon's path allowlist boundary.
    options: { detached: true, env: { ...process.env } },
    logPath: opts.logPath ?? DEFAULT_LOG_FILE,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/daemon/launch.test.ts`
Expected: PASS（8 个用例）

- [ ] **Step 5: lint + typecheck**

Run: `cd apps/cli && pnpm typecheck && cd ../.. && pnpm lint`
Expected: 均无输出/通过

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/daemon/launch.ts apps/cli/test/daemon/launch.test.ts
git commit -m "fix(daemon): 自启改 re-exec 自身 —— spawn 计划的形状可单测

编译产物里 spawn('bun', ...) 必失败：bun 不在 PATH，且 import.meta.url
是 \$bunfs 虚拟路径。改为 spawn(process.execPath, [...,'__daemon'])。
本步只落纯函数（形状），行为由 Task 4 的产物冒烟覆盖。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 2: 不再谎报 —— `startDetachedDaemon` 的失败路径

**Files:**

- Modify: `apps/cli/src/daemon/launch.ts`（追加，不改 Task 1 的纯函数）
- Test: `apps/cli/test/daemon/launch.test.ts`（追加 describe 块）

**Interfaces:**

- Consumes: `planDaemonSpawn()`、`SpawnPlan`（Task 1）
- Produces:
  - `startDetachedDaemon(opts?: { timeoutMs?, pollMs?, deps? }): Promise<DaemonLaunch>`
  - `interface DaemonLaunch { ok: boolean; pid?: number; port?: number; reason?: string }`
  - `interface LaunchDeps { spawnFn, getStatus, sleep }`（注入缝，仅为可测性）

**现有缺陷的原话**（`bin/mipham.ts:349-354`）：`getDaemonStatus()` 返回 null 时打印
`Daemon started (PID unknown — check \`mipham daemon status\`)`并`exit(0)` —— **把失败印成成功**。

- [ ] **Step 1: 写失败测试**

追加到 `apps/cli/test/daemon/launch.test.ts`：

```ts
import { startDetachedDaemon } from '../../src/daemon/launch'

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
    const result = await startDetachedDaemon({
      deps: {
        spawnFn: (() => child) as never,
        getStatus: () => ({ pid: 4242, port: 45671 }),
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/daemon/launch.test.ts`
Expected: FAIL —— `startDetachedDaemon is not a function`

- [ ] **Step 3: 写实现**

追加到 `apps/cli/src/daemon/launch.ts`：

```ts
export interface DaemonLaunch {
  ok: boolean
  pid?: number
  port?: number
  reason?: string
}

interface DaemonStatusLike {
  pid: number
  port: number
}

/** Injection seam: real implementations by default, fakes in unit tests. */
export interface LaunchDeps {
  spawnFn?: typeof spawn
  getStatus?: () => DaemonStatusLike | null
  sleep?: (ms: number) => Promise<void>
}

const READY_TIMEOUT_MS = 10_000
const POLL_INTERVAL_MS = 100

async function defaultGetStatus(): Promise<DaemonStatusLike | null> {
  const { getDaemonStatus } = await import('./index')
  return getDaemonStatus()
}

function tailLog(logPath: string, maxBytes = 800): string {
  try {
    const size = statSync(logPath).size
    const start = Math.max(0, size - maxBytes)
    return readFileSync(logPath, 'utf-8').slice(start).trim()
  } catch {
    return ''
  }
}

/**
 * Start the daemon detached and *wait until it is actually up*.
 *
 * Never reports success on an unknown child: the previous implementation
 * printed "Daemon started (PID unknown …)" and exited 0 whenever the pid file
 * was missing, which turned every launch failure into a silent one.
 */
export async function startDetachedDaemon(
  opts: { timeoutMs?: number; pollMs?: number; deps?: LaunchDeps } = {},
): Promise<DaemonLaunch> {
  const deps = opts.deps ?? {}
  const spawnFn = deps.spawnFn ?? spawn
  const getStatus = deps.getStatus ?? defaultGetStatus
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))

  const already = await getStatus()
  if (already) return { ok: true, pid: already.pid, port: already.port }

  const plan = planDaemonSpawn()
  mkdirSync(dirname(plan.logPath), { recursive: true, mode: 0o700 })

  let spawnError: Error | null = null
  let exitCode: number | null = null
  // The child inherits this fd; closing ours does not close theirs.
  const logFd = openSync(plan.logPath, 'a', 0o600)
  let child: ReturnType<typeof spawn>
  try {
    child = spawnFn(plan.command, plan.args, {
      ...plan.options,
      stdio: ['ignore', 'ignore', logFd],
    })
  } finally {
    closeSync(logFd)
  }
  child.on('error', (err: Error) => {
    spawnError = err
  })
  child.on('exit', (code: number | null) => {
    exitCode = code ?? -1
  })
  child.unref()

  const deadline = Date.now() + (opts.timeoutMs ?? READY_TIMEOUT_MS)
  const pollMs = opts.pollMs ?? POLL_INTERVAL_MS
  while (Date.now() < deadline) {
    await sleep(pollMs)
    if (spawnError) {
      const err: Error = spawnError
      return { ok: false, reason: `daemon failed to spawn: ${err.message}` }
    }
    const status = await getStatus()
    if (status) return { ok: true, pid: status.pid, port: status.port }
    if (exitCode !== null) {
      const tail = tailLog(plan.logPath)
      return {
        ok: false,
        reason: `daemon exited with code ${exitCode}${tail ? `:\n${tail}` : ''}`,
      }
    }
  }
  return {
    ok: false,
    reason: `daemon did not become ready within ${opts.timeoutMs ?? READY_TIMEOUT_MS}ms (log: ${plan.logPath})`,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/daemon/launch.test.ts`
Expected: PASS（13 个用例）

- [ ] **Step 5: typecheck + lint**

Run: `cd apps/cli && pnpm typecheck && cd ../.. && pnpm lint`
Expected: 通过。**注意** `no-floating-promises` 钉在 `error`：`child.on('exit', ...)` 的回调不是 async，别改成 async 箭头函数。

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/daemon/launch.ts apps/cli/test/daemon/launch.test.ts
git commit -m "fix(daemon): 起不来不再谎报成功 —— 轮询就绪 + 三条失败路径

旧实现 getDaemonStatus() 为空即打印「Daemon started (PID unknown)」并
exit 0，把每次启动失败都变成静默失败。改为：spawn 错误 / 子进程早退 /
超时三条路径各自 ok:false，并回读 daemon.log 尾部附上原因。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 3: `__daemon` 入口接线 + `bin/daemon.ts` 瘦身

**Files:**

- Modify: `apps/cli/src/daemon/launch.ts`（追加 `runDaemonProcess`）
- Modify: `apps/cli/bin/mipham.ts:1097`（`main()` 顶部加分支）
- Modify: `apps/cli/bin/mipham.ts:337-355`（`start`）、`:400-409`（`restart`）
- Modify: `apps/cli/bin/daemon.ts`（41 行 → 15 行）
- Test: `apps/cli/test/daemon/launch.test.ts`（追加 `__daemon` 分支可达性断言）

**Interfaces:**

- Consumes: `startDetachedDaemon`、`userArgs`、`DAEMON_ENTRY`（Task 1、2）
- Produces: `runDaemonProcess(argv?: string[]): Promise<void>`

- [ ] **Step 1: 写失败测试**

追加到 `apps/cli/test/daemon/launch.test.ts`：

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/daemon/launch.test.ts`
Expected: FAIL —— 两条断言都失败（`bin/mipham.ts` 无 `DAEMON_ENTRY`；`bin/daemon.ts` 仍自己解析 `MIPHAM_PORT`）

- [ ] **Step 3: 追加 `runDaemonProcess`**

追加到 `apps/cli/src/daemon/launch.ts`：

```ts
/**
 * The daemon process body, shared by the `__daemon` branch of the compiled
 * binary and by `bin/daemon.ts` (source mode). One implementation, two entry
 * points — a second copy is how "two render paths, only one wired" starts.
 */
export async function runDaemonProcess(argv: string[] = process.argv.slice(2)): Promise<void> {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port' && argv[i + 1]) process.env.MIPHAM_PORT = argv[i + 1]
    if (argv[i] === '--bind' && argv[i + 1]) process.env.MIPHAM_BIND = argv[i + 1]
  }

  const { startDaemon, stopDaemon } = await import('./index')
  const { port } = await startDaemon()

  console.log(`Daemon running on http://127.0.0.1:${port}`)
  console.log(`PID: ${process.pid}`)

  const shutdown = async (): Promise<void> => {
    await stopDaemon(true)
    process.exit(0)
  }
  process.on('SIGTERM', () => void shutdown())
  process.on('SIGINT', () => void shutdown())
}
```

- [ ] **Step 4: `bin/mipham.ts` 顶部加分支**

在 `bin/mipham.ts` 顶部 import 区（`export {}` 之后）加：

```ts
import { DAEMON_ENTRY, userArgs } from '../src/daemon/launch'
```

把 `main()` 的**第一句**改成：

```ts
async function main() {
  // ── Hidden daemon entry ────────────────────────────────────────────────
  // `daemon start` re-execs this same program with `__daemon` (see
  // src/daemon/launch.ts). This must come first: everything below assumes an
  // interactive TTY — the stty block would run against a detached child whose
  // stdio is the daemon log.
  if (userArgs(process.argv, process.argv[1])[0] === DAEMON_ENTRY) {
    const { runDaemonProcess } = await import('../src/daemon/launch')
    await runDaemonProcess()
    return
  }

  // ── Deleted-cwd guard ──────────────────────────────────────────────────
```

- [ ] **Step 5: `daemon start` 改用 `startDetachedDaemon`**

把 `bin/mipham.ts:337-355` 整段（`console.log('Starting daemon...')` 到 `process.exit(0)`）替换为：

```ts
console.log('Starting daemon...')
const { startDetachedDaemon } = await import('../src/daemon/launch')
const launch = await startDetachedDaemon()
if (!launch.ok) {
  console.error(`Failed to start daemon: ${launch.reason}`)
  process.exit(1)
}
console.log(`Daemon started (PID: ${launch.pid}, Port: ${launch.port})`)
process.exit(0)
```

`spawn` 的 import（`bin/mipham.ts:327`）**此处先别删** —— `restart` 分支（`:401`）还在用，要等 Step 6 改完它才归零，届时一并删（见 Step 6）。

- [ ] **Step 6: `daemon restart` 同样改**

把 `bin/mipham.ts:400-409` 替换为（**是 409 不是 408** —— 400 起于 `const daemonScript = ...`，
409 才是收尾的 `process.exit(0)`；照 400-408 替换会在新块末尾的 `process.exit(0)` 之后再留一行，
成为不可达代码）：

```ts
const { startDetachedDaemon } = await import('../src/daemon/launch')
const launch = await startDetachedDaemon()
if (!launch.ok) {
  console.error(`Failed to restart daemon: ${launch.reason}`)
  process.exit(1)
}
console.log(`Daemon restarted (PID: ${launch.pid}, Port: ${launch.port})`)
process.exit(0)
```

然后删掉 `bin/mipham.ts:327` 的 `const { spawn } = await import('node:child_process')` —— Step 5 与
Step 6 各改掉一处使用者后，`spawn` 在全文**归零**（实测只有 `:327` 声明、`:339`、`:401` 三处），
而 `eslint.config.js:64` 配了 `@typescript-eslint/no-unused-vars` ⇒ 留着必报 lint。

- [ ] **Step 7: `bin/daemon.ts` 瘦身**

把 `apps/cli/bin/daemon.ts` 全文替换为：

```ts
#!/usr/bin/env bun

/**
 * Mipham Code Daemon — standalone source-mode entry.
 *
 * The compiled binary reaches the same code through the hidden `__daemon`
 * branch in bin/mipham.ts. Both call runDaemonProcess() so there is exactly
 * one implementation of the daemon process body.
 *
 * Usage: bun run bin/daemon.ts [--port PORT] [--bind HOST]
 */

import { runDaemonProcess } from '../src/daemon/launch'

await runDaemonProcess()
```

- [ ] **Step 8: 跑测试 + 源码路径实跑**

Run:

```bash
cd apps/cli
pnpm vitest run test/daemon/launch.test.ts
pnpm typecheck
```

Expected: 测试 PASS（15 个用例）、typecheck 通过

然后**实跑源码路径**（这是 spec 明令不可弄坏的那条）：

```bash
cd apps/cli && bun run bin/mipham.ts daemon start
bun run bin/mipham.ts daemon status    # 必须打印 Daemon: running + 真实 PID/Port
bun run bin/mipham.ts daemon stop
```

Expected: start 打印真实 PID/Port；status 为 running；stop 后无残留进程（`lsof -iTCP:45671` 为空）

- [ ] **Step 9: Commit**

```bash
git add apps/cli/src/daemon/launch.ts apps/cli/bin/mipham.ts apps/cli/bin/daemon.ts apps/cli/test/daemon/launch.test.ts
git commit -m "fix(daemon): __daemon 入口接线 + bin/daemon.ts 委托同一实现

daemon 进程体移到 src/daemon/launch.ts 的 runDaemonProcess()，编译产物经
__daemon 分支进入、源码经 bin/daemon.ts 进入，共用一份。
__daemon 分派必须是 main() 第一句 —— 其后是 stty 交互式终端处理。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

### Task 4: 产物冒烟测试 —— 覆盖单测够不到的那一半

**Files:**

- Create: `scripts/smoke-daemon.sh`
- Modify: `.github/workflows/ci.yml:53-68`（`build-cli` job 追加步骤）
- Modify: `apps/cli/CLAUDE.md`（测试数/文件数同提交回填）

**Interfaces:**

- Consumes: Task 3 的产物行为
- Produces: `scripts/smoke-daemon.sh [cli-dir]`，退出码 0 = 产物里 daemon 真能起来

**诚实边界（spec §2.3 原文）**：这个 bug **只在编译产物里存在**，源码下老代码是好的
⇒ 单测抓不到它，**行为层只能由产物冒烟覆盖**。这一步正是当初缺的那一步。

- [ ] **Step 1: 写冒烟脚本**

创建 `scripts/smoke-daemon.sh`：

```bash
#!/usr/bin/env bash
# Guard the class of bug that unit tests structurally cannot catch: source tests
# were green while `daemon start` in the *compiled binary* reported success and
# started nothing (spawn('bun', ...) + a $bunfs script path).
#
# Usage: scripts/smoke-daemon.sh [cli-dir]   (default: apps/cli)
#        RUN_PATH=/usr/bin:/bin scripts/smoke-daemon.sh apps/cli
#          → invoke the artifact with bun off PATH (the container user's world)

set -euo pipefail

CLI_DIR="${1:-apps/cli}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# PATH used for *invoking the artifact* only. Stripping it around the whole
# script would break the compile step, and a compile failure (127) would then
# be misread as "the fix didn't land" — the one judgement this script exists to
# make, decided by the wrong evidence. The compile step always keeps the
# ambient PATH: `bun build` needs bun, the artifact must not.
RUN_PATH="${RUN_PATH:-$PATH}"
run_cli() { env PATH="$RUN_PATH" "$WORK/mipham" "$@"; }

echo "→ Compiling the CLI into $WORK"
(cd "$CLI_DIR" &&
  bun run scripts/generate-bundled-skills.ts >/dev/null &&
  bun build --compile --minify ./bin/mipham.ts --outfile "$WORK/mipham")

# Isolate HOME: the daemon writes ~/.mipham/{daemon.pid,daemon.port,daemon.db}.
# Never touch the developer's real daemon state.
export HOME="$WORK/home"
mkdir -p "$HOME"

# Run from a dedicated directory: cwd is contract, not incidental — the daemon
# uses it as its path allowlist root.
TASK_DIR="$WORK/task"
mkdir -p "$TASK_DIR"
cd "$TASK_DIR"

echo "→ daemon start (compiled binary, PATH=$RUN_PATH)"
run_cli daemon start

echo "→ daemon status"
if ! run_cli daemon status | grep -q 'Daemon: running'; then
  echo "✗ FAIL: daemon start returned success but status is not running"
  exit 1
fi

echo "→ daemon stop"
run_cli daemon stop

echo "✓ compiled-binary daemon smoke test passed"
```

- [ ] **Step 2: 本机实跑（无 bun 的对照也要跑一次）**

Run: `chmod +x scripts/smoke-daemon.sh && bash scripts/smoke-daemon.sh apps/cli`
Expected: 三段全部通过，结尾 `✓ compiled-binary daemon smoke test passed`

再跑一次**不带 bun 的路径**（这是产物真正的使用场景，也是最容易漏的那次）：

```bash
# 让*产物*找不到 bun，模拟容器里的用户。注意收窄的是 RUN_PATH（只作用于调用产物
# 那三次），不是整个脚本的 PATH —— 后者会让 `bun build` 先以 127 退出，得到的
# 「失败」与修复毫无关系，而它的结论句恰恰是「不通过 = 修复没到位」。
RUN_PATH="/usr/bin:/bin" bash scripts/smoke-daemon.sh apps/cli
```

Expected: 同样通过。**若只有这一次不通过，说明修复没到位 —— 旧实现在这里必然失败，这正是判据。**
（编译步骤始终用环境 PATH，故不会因 RUN_PATH 而失败：假判据的来源已被移除。）

- [ ] **Step 3: 接线 CI**

在 `.github/workflows/ci.yml` 的 `build-cli` job 末尾（`- run: pnpm --filter @miphamai/cli build` 之后）追加：

```yaml
- name: Compiled-binary daemon smoke test
  run: bash scripts/smoke-daemon.sh apps/cli
```

- [ ] **Step 4: 回填文档（同提交）**

1. 跑全量取真实数字：`cd apps/cli && pnpm test`
2. 用实跑输出回填 `apps/cli/CLAUDE.md`：
   - `## 测试` 表的 `daemon` 行（文件数 32 → 33，测试数按实跑增）
   - `**合计**` 行（227 → 228 文件）
   - `### 修订历史` 新增一行（**挤掉第 6 行，搬进 `docs/claude-md-history.md`**）
   - `## 最近提交` 新增一行（同样 5 行窗口）
   - 顶部 `> **版本**` 与 `> **最后更新**` 两行
3. **数字以实跑为准**，不预填；`stale-numbers-syndrome` 的老问题就是凭印象填。

- [ ] **Step 5: Commit**

```bash
git add scripts/smoke-daemon.sh .github/workflows/ci.yml apps/cli/CLAUDE.md
git commit -m "test(daemon): 编译产物冒烟 —— 起不来就红

单测跑在源码下，而旧代码在源码下是好的 ⇒ 这个 bug 结构性逃过单测。
补产物层冒烟：编译 → daemon start → status 必须 running → stop，进 CI
build-cli job。同时回填 CLAUDE.md 测试数与窗口。

Co-Authored-By: Claude Code <noreply@anthropic.com>"
```

---

## Self-Review

**Spec 覆盖**（逐条对 spec §二）：

| spec 条目                                                               | 落点                                                                                                         | 状态 |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---- |
| §2.1 re-exec 自己（`spawn(process.execPath, ['__daemon', ...])`）       | Task 1（`selfArgvPrefix`/`planDaemonSpawn`）+ Task 3 Step 4/5/6                                              | ✅   |
| §2.1 `bin/daemon.ts` 逻辑平移至 `__daemon` 分支                         | Task 3 Step 3/7（`runDaemonProcess` 单份实现）                                                               | ✅   |
| §2.1 源码路径不可弄坏、`bin/daemon.ts` 保留                             | Task 3 Step 8 实跑 + Step 7 保留为入口                                                                       | ✅   |
| §2.2 cwd 必须继承                                                       | Task 1 `planDaemonSpawn` 不传 `cwd` + 单测钉 `'cwd' in options === false` + `smoke-daemon.sh` 在独立目录内跑 | ✅   |
| §2.2 不得谎报、非零退出码 + stderr                                      | Task 2（三条失败路径）+ Task 3 Step 5/6（`exit(1)` + `console.error`）                                       | ✅   |
| §2.3 单测抓形状（argv[0] 是 execPath、不是裸 `'bun'`、`__daemon` 可达） | Task 1 Step 1（三条）+ Task 3 Step 1（两条）                                                                 | ✅   |
| §2.3 产物冒烟抓行为、进 CI `build-cli`                                  | Task 4 Step 1/3                                                                                              | ✅   |
| §2.3 诚实边界须写明                                                     | Task 4 前言段                                                                                                | ✅   |

**未覆盖 / 有意排除**：

- **端口冲突**（45671 被占）—— spec 未要求，且与 T2 无关；本计划不改。
- **daemon 的 provider 配置**（daemon 无系统提示、settings.json 的 allow/deny 到不了 daemon 等已知缺口）—— T5 已登记为「不修」，此处不动。
- **`--port`/`--bind` 转发**：`runDaemonProcess` 支持（与旧 `bin/daemon.ts` 行为一致），但 `daemon start` 历来不传这两个 flag，Task 3 Step 5 保持不传 —— 不新增未要求的可配置性。

**类型一致性核对**：`SpawnPlan`（Task 1）→ `planDaemonSpawn()` 返回，Task 2 的 `startDetachedDaemon` 消费 `.command/.args/.options/.logPath`，命名一致；`DaemonLaunch`（Task 2 定义）→ Task 3 Step 5/6 消费 `.ok/.pid/.port/.reason`，一致；`DAEMON_ENTRY`/`userArgs`（Task 1 定义）→ Task 3 Step 4 消费，一致。

**占位符扫描**：无 TBD/TODO；每个代码步骤都给了可直接落盘的完整实现。

---

## 执行偏差（Ruling 29 / 30）

> **本节由执行者事后补写，上文一个字都未改动。** 上文 Task 1 的 `isScriptPath` /
> `selfArgvPrefix(argv1, execPath)` / `userArgs(argv, argv1)`（`:39`、`:69`、`:77`、`:82`、
> `:150-161`、`:188`）**已经作废** —— 它们锚在**臆想的 argv 形状**上，不是 bun 产生的形状。
> 篡改计划正文等于抹掉「当时为什么这么写」这条证据，故只在此处指认它。

### 实测（bun 1.3.14；两种模式各跑一次探针）

| 模式                                | `process.argv`                                        | `process.execPath` | `argv[0] === execPath` | 用户参数起点 |
| ----------------------------------- | ----------------------------------------------------- | ------------------ | :--------------------: | :----------: |
| 源码 `bun run bin/mipham.ts daemon` | `["<…>/bun.exe", "<abs>/bin/mipham.ts", "daemon", …]` | `<…>/bun.exe`      |        **true**        |      2       |
| 产物 `dist/mipham daemon`           | `["bun", "/$bunfs/root/mipham", "daemon", …]`         | `<…>/dist/mipham`  |       **false**        |    **2**     |

**两种世界都在用户参数前放恰好两个元素。** 这正是 `bin/mipham.ts` 全文 **12 处**
`process.argv.slice(2)` 所依据的模型 —— 不是新规则，是本仓库一直以来的规则。

### 原判别式错在哪

`isScriptPath` 用「`argv[1]` 有没有 `.ts/.js` 扩展名」分辨模式。产物侧 `argv[1]` 是**无扩展名的
`$bunfs` 路径**，于是被判成**第一个用户参数** ⇒ `userArgs` 只切掉 1 ⇒ `argv[0]` 留下
`/$bunfs/root/mipham` ⇒ `main()` 顶部 `argv[0] === DAEMON_ENTRY` **恒为假** ⇒ **`__daemon` 分支在产物里不可达**。
源码模式恰好判对，**所以 Task 1–3 的单测全绿**。产物侧实跑报 `Unknown command: mipham __daemon`。

### 现行签名（三个函数被改写）

```ts
export function selfArgvPrefix(
  argv0: string | undefined,
  argv1: string | undefined,
  execPath: string,
): string[]
export function userArgs(argv: readonly string[]): string[] // = argv.slice(2)
export function planDaemonSpawn(opts?: {
  argv0?: string | undefined
  argv1?: string | undefined
  execPath?: string
  extraArgs?: string[]
  logPath?: string
}): SpawnPlan
```

判别式只剩一个问题：**解释器是不是在 argv[0]**（`argv0 === execPath`）。
产物侧 argv[1] 是**只存在于二进制内部**的路径，故再 exec 只能不带脚本。
`isScriptPath` 已删除，**代码里零引用**（全仓库仍有 8 处命中，全是文档：本计划 7 处 ——
含本节自身 —— 加 `docs/claude-md-history.md` 的 2.50.0 行 1 处；文档提及不是代码引用）。
落地于 `116b695`
（`fix(daemon): 产物 argv 是 [bun, $bunfs…] —— 判别式改用「解释器是否在前」`）。

### 结论 —— 本节存在的理由

**Task 1–3 的绿灯不是「覆盖到了」，是「覆盖了一个不存在的世界」。**
Task 1 第 2 条测试（`selfArgvPrefix('daemon', …)`，`:64`）与 `userArgs` 的两条测试（`:77`、`:82`），
喂进去的都是**本计划自己编的** argv 形状；形状断言一旦锚在臆想形状上，**比没有测试更糟** —— 它给的是绿灯。

**编得有多像真的**：计划给产物侧编的形状是 `['/opt/mipham/dist/mipham', DAEMON_ENTRY]` ——
**两项**；真实的产物 argv 是 `['bun', '/$bunfs/root/mipham', DAEMON_ENTRY]` —— **三项**。
旧 `userArgs` 是 `argv.slice(1 + (isScriptPath(argv1) ? 1 : 0))`，在两项编造形状上恰好切对
（`argv[1]` = `'__daemon'` 无扩展名 ⇒ 切 1 ⇒ `['__daemon']`，绿），在真实三项上切错
（`argv[1]` = `/$bunfs/…` 无扩展名 ⇒ 切 1 ⇒ **`['/$bunfs/root/mipham', '__daemon']`**，分派条件恒假）。
**两个形状的差别只是「少了 `bun` 那一项」** —— 这一项之差，就是「测试全绿」与「产物里根本进不去」之间的全部距离。

**而抓到这个 bug 的，正是这份计划设计的那个仪器**：Task 4 的产物冒烟（`scripts/smoke-daemon.sh`）。
计划自己的仪器，抓住了计划自己引入的 bug —— 这也是为什么「单测抓形状、产物抓行为」两条都要有：
单测跑在源码下，而**这个 bug 只在编译产物里存在**，单测结构性够不到它。

---

## 执行偏差（续）—— Task 4 的 shell 里两处不安全写法（Ruling 36）

> 与上一节同理：**上文一字未改**。上文 Task 4 的代码块（`:719` 与 `:749`）**已经作废**，
> 理由不是「风格」，是它**照抄即重造缺陷**。

### 一、`:719` `trap 'rm -rf "$WORK"' EXIT` —— 删除没有守卫

daemon 的 `daemon.pid` / `daemon.port` / `daemon.db` 全在 `$WORK/home` 下，cwd 是 `$WORK/task`。
在 `set -e` 下，**任何在一次成功 `start` 之后的中止**都会走到这个 trap，把活着的 daemon 的 state
从它脚下删掉 —— 进程还持着 `127.0.0.1:45671`，而磁盘上已无据可查。
**计划自己的 FAIL 路径不是这一类**（原文此处把它并进来，是错的）：那条路径的前置条件正是
「`status` 不说 running」，且 trap 里的 `stop` 会真的停掉它 ⇒ 退出时没有 listener 残留。
那边的反向危害才是真的 —— 探针把活的 daemon 读成已停（见本节第二处）。
计划把它写成一行，等于**把「清理临时目录」与「杀掉一个活进程的 state」混为一谈**。

执行时改为：`stop` 尽力而为（`|| true` 保留）→ **捕获** `status` 输出 → 命中「仍在 running」则
**保留 `$WORK`、打印告警、`exit 1`**；只有探针不再说 running 才 `rm -rf`。

**一个必须写下来的细节**：这里的 `exit 1` **不只是状态修饰，它首先是 `rm -rf` 前面那道跳过**。
`case` 命中后没有 `exit` 就直落到函数末尾的 `rm -rf`。实测（只删掉这一行）：**同样打印那条告警**、
`$WORK` 被删而 PID 仍在 LISTEN —— **两件坏事同时发生：删了活 daemon 的 state，再谎报通过。**
执行者一度把这一行当作「可删的状态修饰」并在报告里给了删除建议；该建议**是错的**，已作废。

**那次读到的 `EXIT=0` 带路径依赖 —— 它不等于删除本身**：bash 下 trap 正常走完时，脚本退出码取
**原来的**退出码；trap 里最后一条命令失败时才由它决定 —— **后一半要 `set -e` 在场**
（本脚本恒有 `set -euo pipefail`；另测：去掉 `set -e` 后 `trap "false" EXIT; exit 0` ⇒ 0）。
本机实测三例（均在 `set -e` 下）：主体走完 + trap 收尾成功 ⇒ 0；
`set -e` 中止 + trap 收尾成功 ⇒ 1；主体走完 + trap 收尾失败 ⇒ 1）。删掉 `exit 1` 后直落的那条路
以**成功的 `rm -rf`** 收尾 ⇒ 码值原样返回 —— **从脚本主体正常走完进来的那次是 0（谎报通过），
从 `set -e` 中止进来的那次仍是非零**。两条路的差别只在退出码，**不在删除**：`$WORK` 一样被删、
PID 一样在 LISTEN。

### 二、`:749` `if ! run_cli daemon status | grep -q 'Daemon: running'` —— 探针的失败模式是静默假阴性

同一个惯用法在计划里出现在两处（就绪检查 `:749`，以及执行时新增的删除闸）。它在**两个方向**上都会骗人：

- 当作**删除闸**：`set -o pipefail` 下，`grep -q` 读完第一行即退出 ⇒ 生产者拿 SIGPIPE ⇒ 管道非零
  ⇒ 在 `if` 里读成「没匹配」⇒ **把活着的 daemon 读成已停** ⇒ 正是要防的那次删除。
- 当作**就绪检查**：同一个误读，方向变成 `! (...)` 为真 ⇒ **健康的一跑被判 FAIL**，即假红。

**实测（这才是本节的关键）**：**拿真的 `mipham daemon status` 量，两者当前都不发生** ——
naive **0/100** 与 **0/500** 次误读、捕获式 0/500、连 `run_cli daemon status | head -1` 都 **rc=0 五次全中**。
机制：该命令先做完 I/O 再打印四行短输出，消费者一次读一个缓冲即拿到全部，**生产者从不比消费者活得短** ⇒ 无 EPIPE。
合成一个「分次写、跨消费者退出」的慢生产者，同一个管道**确实**给 141。

⇒ 结论是**潜伏，不是现实**：危害属于「生产者跨消费者退出而分次写」这一类，今天的 `status` 不落在这个类里；
一旦它加一行慢 I/O 或多打几行，**`:749` 会比删除闸先坏**，且坏的方向是假红。

执行时的处置因此是**分开的**，而不是一律照改：**守着删除的那处换成捕获式**（那里误读的代价是删活 state，
且这是本次要修的缺陷本身）；**计划明文规定的 FAIL 路径那处原样保留**（计划正文是权威文档，
而该处当前不触发）。**统一两处惯用法应作为后续任务处理** —— 先改计划（本节即指认），再改代码。

### 三、两节的共同点 —— 这才是本节存在的理由

**这份计划里凡「判别式」与「探针」，都被写成了不安全的形状。**
Task 1 的判别式锚在**臆想的 argv 形状**上（上一节），Task 4 的探针用了一个**失败模式是静默假阴性**的惯用法（本节）。
两者的病理相同：**判断「我处在哪个世界」的那一行，写的是作者以为的形状，而不是量出来的形状**；
而且**两者都不会被单测抓到** —— 前者因为单测跑在另一个世界里；后者因为**没有任何测试文件引用
`scripts/smoke-daemon.sh`**（`git grep -l` 的全部引用是 CI、两份活文档、本计划与脚本自身），
而 CI **恰在 `ci.yml:72`、`:74` 两处**调用它，**两处都是 happy path** —— 即那两个守卫分支
（保留 `$WORK`、以及探针误读）**在 CI 里一次都不会被执行**。

**抓到它们的分别是**：Task 1 的 bug 由**这份计划自己设计的仪器**（Task 4 的产物冒烟）抓到；
Task 4 的探针危害由**执行者**在实现时量出来，而它当时对抗的是**派单指令里推荐的写法** ——
即这条教训同样适用于**「派单时规定的机制，派单者自己也没量过」**。
