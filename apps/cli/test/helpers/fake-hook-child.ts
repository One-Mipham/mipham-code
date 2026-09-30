import { EventEmitter } from 'node:events'

/**
 * A stand-in for the child `node:child_process.spawn` returns, for tests that
 * cannot afford a real subprocess.
 *
 * The executor reads four things off a child — `stdout`/`stderr` `data` events,
 * `exit`, `close`, `error`, and the payload handed to `stdin.end()` — so a mock
 * has to speak all of them. A *result object* cannot: that is `spawnSync`'s
 * shape, which returns only once the child is over, and using it here would
 * re-mock away the very difference these tests exist to pin (the async executor
 * answers `exit` and `close` separately, and treats a pipe held past `exit`
 * differently from a child still running).
 */
export interface FakeHookOutcome {
  /** Exit code; `null` means "no code", as a signal-killed child has. */
  status?: number | null
  signal?: string | null
  stdout?: string
  stderr?: string
  /**
   * Delivered on the child's `error` event, the way a *failed spawn* arrives
   * (ENOENT/EACCES never produce `exit` or `close`).
   */
  error?: { code?: string; message?: string }
  /**
   * Emit `exit` but never `close` — a descendant still holding the child's
   * stdio pipe, which is the case `spawnSync` could not get out of.
   */
  holdPipe?: boolean
}

export interface FakeHookChild extends EventEmitter {
  pid: number
  stdout: EventEmitter
  stderr: EventEmitter
  stdin: EventEmitter & { end: (input?: unknown) => void }
  kill: (signal?: string) => void
  /** Every payload written to stdin, in order. */
  written: string[]
  /** Signals this child was sent directly (not via its process group). */
  signalled: string[]
}

/**
 * Build a child whose whole life is over by the time the executor's `await`
 * resumes.
 *
 * Delivery is deferred to a microtask: the executor attaches its listeners
 * synchronously after `spawn()` returns, so an outcome emitted in the same tick
 * would be broadcast to nobody — the fake would look like a child that never
 * reported, and the test would hang instead of fail.
 */
export function makeFakeHookChild(outcome: FakeHookOutcome): FakeHookChild {
  const child = new EventEmitter() as FakeHookChild
  child.pid = 4242
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  child.written = []
  child.signalled = []
  child.kill = (signal?: string) => {
    child.signalled.push(signal ?? 'SIGTERM')
  }
  const stdin = new EventEmitter() as FakeHookChild['stdin']
  stdin.end = (input?: unknown) => {
    if (typeof input === 'string') child.written.push(input)
  }
  child.stdin = stdin

  queueMicrotask(() => {
    if (outcome.error) {
      child.emit('error', outcome.error)
      return
    }
    if (outcome.stdout) child.stdout.emit('data', Buffer.from(outcome.stdout))
    if (outcome.stderr) child.stderr.emit('data', Buffer.from(outcome.stderr))
    // `?? 0` would be wrong here: `null` is a status a real child reports (killed
    // by a signal, or still running when the timeout fired), and coalescing it to
    // 0 would hand the executor a clean exit — the opposite of the outcome.
    const status = outcome.status === undefined ? 0 : outcome.status
    const signal = outcome.signal ?? null
    child.emit('exit', status, signal)
    if (!outcome.holdPipe) child.emit('close', status, signal)
  })

  return child
}
