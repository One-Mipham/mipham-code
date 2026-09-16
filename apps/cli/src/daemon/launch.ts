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
