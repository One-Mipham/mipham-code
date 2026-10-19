/**
 * The one way out of a session.
 *
 * `SessionEnd` hooks are asynchronous, while `process.exit()` is immediate. The
 * exit path used to start the hooks and call `process.exit()` in the same tick,
 * so a hook registered for SessionEnd could never finish — and `/exit`, `/quit`
 * and the second Ctrl+C left through `process.exit()` directly, never starting
 * them at all. Every user-initiated exit now goes through `exitSession()`, which
 * runs the registered shutdown callback once and then exits.
 *
 * The callback owns its own bounds (a session must not hang on exit); this module
 * only guarantees ordering and that a broken callback cannot trap the user.
 */

let handler: (() => void | Promise<void>) | null = null
let exitPromise: Promise<void> | null = null

/**
 * SessionEnd is best-effort: a hook that is slow, hung, or waiting on a server
 * that never answers must not hold the terminal open. The caller uses this as
 * the upper bound for the hook phase.
 */
export const SESSION_END_HOOK_TIMEOUT_MS = 1_500

export function registerExitHandler(fn: () => void | Promise<void>): void {
  handler = fn
}

/** Test hook — the process-global handler otherwise leaks between test files. */
export function resetExitHandler(): void {
  handler = null
  exitPromise = null
}

/**
 * Run `promise`, giving up after `ms`. Used to bound SessionEnd hooks without
 * cancelling the work they may still be doing in the background.
 */
export async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: unknown
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, ms)
        // A pending timeout must not keep a test process (or a stuck session)
        // alive by itself. Bun's timer is a number; Node's has `unref`.
        ;(timer as { unref?: () => void }).unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer as ReturnType<typeof setTimeout>)
  }
}

/**
 * Run the registered shutdown callback (once, across every caller) and exit.
 *
 * Concurrent or repeated calls — a signal arriving while `/exit` is already
 * shutting down — await the same work and share the same exit.
 */
export function exitSession(code = 0): Promise<never> {
  if (!exitPromise) {
    exitPromise = Promise.resolve()
      .then(() => handler?.())
      .then(() => undefined)
      .catch(() => {
        // Shutdown is best effort. A callback that throws must not leave the
        // user with a session they cannot close.
      })
  }
  return exitPromise.then(() => process.exit(code))
}
