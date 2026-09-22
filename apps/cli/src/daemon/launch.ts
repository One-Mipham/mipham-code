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
import { dirname, resolve } from 'node:path'
import { miphamHome } from '../core/paths.ts'

/** argv sentinel that re-enters this program as a daemon. Not user-facing. */
export const DAEMON_ENTRY = '__daemon'

const DEFAULT_LOG_FILE = miphamHome('daemon.log')

/**
 * argv prefix that re-runs *this* program.
 *
 * Is an interpreter sitting in front of this program? That — and only that —
 * is what decides whether the re-exec has to re-pass a script path. Measured on
 * bun 1.3.14; these are the shapes bun actually produces:
 *
 *   bun run bin/mipham.ts daemon start
 *     argv     = ["<…>/bun.exe", "<abs>/bin/mipham.ts", "daemon", "start"]
 *     execPath = "<…>/bun.exe"           ← argv[0] IS the interpreter
 *   dist/mipham daemon start
 *     argv     = ["bun", "/$bunfs/root/mipham", "daemon", "start"]
 *     execPath = "<…>/dist/mipham"       ← argv[0] is not; the entry lives inside
 *
 * Both shapes put exactly TWO entries in front of the user's own arguments,
 * which is why the rest of bin/mipham.ts parses with `process.argv.slice(2)`
 * in either mode. Only the re-exec prefix has to tell the two apart — and the
 * compiled entry is a `$bunfs` path that exists only inside the binary, so no
 * re-exec can ever name it: the artifact re-runs `execPath` with no script.
 *
 * (Until this was measured the discriminator was "does argv[1] end in .ts/.js",
 * so it read the compiled `$bunfs` entry as the first *user argument* — and the
 * `__daemon` branch became unreachable in the artifact while source mode, where
 * the heuristic happens to be right, stayed green.)
 */
export function selfArgvPrefix(
  argv0: string | undefined,
  argv1: string | undefined,
  execPath: string,
): string[] {
  return argv0 === execPath && typeof argv1 === 'string' ? [execPath, resolve(argv1)] : [execPath]
}

/**
 * The user-facing arguments, with the interpreter/script prefix stripped.
 *
 * Always two, in both modes — same model as the `process.argv.slice(2)` used
 * throughout bin/mipham.ts. See `selfArgvPrefix` for the measured shapes.
 */
export function userArgs(argv: readonly string[]): string[] {
  return argv.slice(2)
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
 *
 * `argv0`/`argv1` default to the real `process.argv[0]`/`process.argv[1]` and
 * `execPath` to the real `process.execPath`. The branch is
 * `argv0 === execPath && typeof argv1 === 'string'` — *both* conjuncts, and the
 * second is reachable without passing `argv0`: `planDaemonSpawn({ argv1:
 * undefined })` keeps the default equality (true whenever the calling process is
 * in source mode) and fails the `typeof`, so it gets the *compiled* shape.
 * Both satisfied ⇒ the *source* shape (an interpreter in front of a script path,
 * so the script element is re-sent); otherwise ⇒ the bare `[execPath]` of the
 * *compiled* shape. To force the compiled shape, pass `argv0` as well.
 */
export function planDaemonSpawn(
  opts: {
    argv0?: string | undefined
    argv1?: string | undefined
    execPath?: string
    extraArgs?: string[]
    logPath?: string
  } = {},
): SpawnPlan {
  const argv0 = 'argv0' in opts ? opts.argv0 : process.argv[0]
  const argv1 = 'argv1' in opts ? opts.argv1 : process.argv[1]
  const execPath = opts.execPath ?? process.execPath
  return {
    command: execPath,
    // `selfArgvPrefix` returns the child's *argv*, so it starts with argv[0] —
    // but spawn() sets argv[0] from `command` itself, so that element has to be
    // dropped here. Keeping it puts `execPath` at argv[1], where the runtime
    // reads it as *the script to execute*: node/bun then parse the interpreter's
    // own binary as source and die with `error: Unexpected <binary>` before the
    // script ever runs. Verified identical on node v24 and bun 1.3.14.
    args: [
      ...selfArgvPrefix(argv0, argv1, execPath).slice(1),
      DAEMON_ENTRY,
      ...(opts.extraArgs ?? []),
    ],
    // No `cwd`: the child must inherit this process's working directory.
    // `daemonRoot = process.cwd()` is the daemon's path allowlist boundary.
    options: { detached: true, env: { ...process.env } },
    logPath: opts.logPath ?? DEFAULT_LOG_FILE,
  }
}

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
/** How long `restart` waits for the *old* daemon to go before refusing. */
const OLD_DAEMON_EXIT_TIMEOUT_MS = 10_000

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

/**
 * Wait until the daemon we just signalled is *gone*.
 *
 * `restart` used to SIGTERM and then sleep a fixed 500 ms. That is a guess, and
 * the guess is load-bearing: `startDetachedDaemon()` opens with a probe of
 * `getStatus()` and returns whatever pid/port it finds there. A pid file the old
 * daemon has not unlinked yet therefore reads as "already running" — `restart`
 * then reports `Daemon restarted (PID: <old>)` and exits 0 having started
 * nothing, and the old daemon finishes exiting afterwards, leaving none. That is
 * the same "reports success with no daemon behind it" failure this module exists
 * to remove, reintroduced on a new write point.
 *
 * Returns true once `getStatus()` goes null, false if it never does before the
 * deadline. `false` is a refusal, not a warning: the caller must not start.
 */
export async function waitForDaemonExit(
  opts: { timeoutMs?: number; pollMs?: number; deps?: LaunchDeps } = {},
): Promise<boolean> {
  const deps = opts.deps ?? {}
  const getStatus = deps.getStatus ?? defaultGetStatus
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const deadline = Date.now() + (opts.timeoutMs ?? OLD_DAEMON_EXIT_TIMEOUT_MS)
  const pollMs = opts.pollMs ?? POLL_INTERVAL_MS

  for (;;) {
    const status = await getStatus()
    if (!status) return true
    if (Date.now() >= deadline) return false
    await sleep(pollMs)
  }
}

/**
 * The daemon process body, shared by the `__daemon` branch of the compiled
 * binary and by `bin/daemon.ts` (source mode). One implementation, two entry
 * points — a second copy is how "two render paths, only one wired" starts.
 *
 * The two callers pass *different* argv slices and that is deliberate: the
 * compiled binary is `[binary, '__daemon', ...]` while the source entry is
 * `[bun, 'bin/daemon.ts', ...]`, so the `__daemon` branch strips the sentinel
 * (and `bin/daemon.ts` relies on the default) rather than either of them
 * handing over a raw `process.argv` tail.
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
