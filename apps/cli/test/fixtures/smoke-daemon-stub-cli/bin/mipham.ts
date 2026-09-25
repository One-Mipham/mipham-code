/**
 * Stub CLI for `scripts/smoke-daemon-guards.sh` — drives the *real*
 * `scripts/smoke-daemon.sh` into its two guard branches, which CI's two
 * invocations both skip (both take the happy path with the real artifact).
 *
 * It is **not** a CLI and not a daemon. Its whole contract is the one question
 * `daemon status` is asked: "is the pid file there?" So it keeps its liveness in
 * `$HOME/.mipham/daemon.pid`, which is the same place — and the same shape of
 * answer — the real daemon uses. That is enough for the script's control flow,
 * which is the subject under test; the real artifact's happy path is what
 * `ci.yml` already runs twice.
 *
 * Behaviour is chosen by `SMOKE_STUB_MODE` (inherited through `run_cli`'s
 * `env PATH=...`):
 *   ok            start writes the pid file, stop unlinks it  → happy path (rc 0)
 *   survives-stop stop is a no-op                            → "still running" branch
 *   never-ready   start never writes the pid file            → "not running after a
 *                                                              successful start" branch
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const mode = process.env.SMOKE_STUB_MODE ?? 'ok'
const [group, sub] = process.argv.slice(2)

const home = process.env.HOME ?? ''
const stateDir = join(home, '.mipham')
const pidFile = join(stateDir, 'daemon.pid')

const PID = 4242 // fixed on purpose: the guard test can then tell a *parsed* pid
// in the smoke script's warning from a literal one it may have hardcoded.

// The guard test has no other handle on the smoke script's `mktemp -d` directory:
// the stub was compiled *into* it, so its own path names it. This goes first, so
// every case can locate the work dir even when the run ends in `exit 1`.
console.log(`[stub] execPath=${process.execPath}`)

if (group !== 'daemon') {
  process.exit(0)
}

if (sub === 'start') {
  mkdirSync(stateDir, { recursive: true })
  if (mode !== 'never-ready') writeFileSync(pidFile, `${PID}\n`, { mode: 0o600 })
  console.log(`Daemon started (PID: ${PID}, Port: 45671)`)
  process.exit(0)
}

if (sub === 'status') {
  if (existsSync(pidFile)) {
    console.log('Daemon: running')
    console.log(`  PID:    ${PID}`)
    console.log('  Port:   45671')
    console.log('  URL:    http://127.0.0.1:45671')
  } else {
    console.log('Daemon: not running')
  }
  process.exit(0)
}

if (sub === 'stop') {
  if (!existsSync(pidFile)) {
    console.log('Daemon is not running.')
    process.exit(0)
  }
  if (mode !== 'survives-stop') {
    rmSync(pidFile, { force: true })
  }
  console.log(`Daemon stopped (PID: ${PID})`)
  process.exit(0)
}

process.exit(0)
