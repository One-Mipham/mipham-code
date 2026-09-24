/**
 * Detection and messaging for the "current working directory was deleted"
 * failure — at startup, and mid-session.
 *
 * `process.cwd()` throws `ENOENT` when the directory the process was launched
 * from no longer exists (e.g. a removed git worktree). The CLI entry checks
 * this up front and prints a clear, actionable message instead of letting the
 * error surface as a raw crash dump (matches Claude Code 2.1.239).
 */

import { existsSync } from 'node:fs'

/** True when `err` is the ENOENT thrown by `process.cwd()` on a deleted cwd. */
export function isDeletedCwdError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  // Node sets `code = 'ENOENT'` with a message ending in `, uv_cwd`. Bun and
  // other runtimes may omit the code but still name `getcwd`/`uv_cwd`.
  return (err as NodeJS.ErrnoException).code === 'ENOENT' || /uv_cwd|getcwd/i.test(err.message)
}

/** Human-readable guidance shown when the launch directory was deleted. */
export function deletedCwdMessage(): string {
  return (
    `Mipham Code can't start: the current working directory no longer exists.\n\n` +
    `The directory you launched from was deleted (for example, a removed git worktree).\n` +
    `Change to a valid directory and run \`mipham\` again.`
  )
}

/**
 * `dir` (default `process.cwd()`) if it still exists, otherwise `null`.
 *
 * The launch-time check above covers a directory that was already gone when the
 * process started. A directory deleted *while* the session runs reaches the same
 * state, and neither runtime reports it on its own:
 *
 * - Node throws `ENOENT` from `process.cwd()` — but from inside whatever call
 *   site happens to touch it first, so the message names the wrong thing;
 * - Bun does not throw at all. It keeps returning the path it cached at startup,
 *   so the deleted directory arrives as an ordinary string and only fails later,
 *   at the first syscall that uses it (`spawn /bin/sh ENOENT` blames the shell).
 *
 * Asking the filesystem makes both runtimes agree, and lets the caller decide
 * what to say. An error that is not this one is not swallowed.
 */
export function resolveExistingCwd(dir?: string): string | null {
  let target: string
  try {
    target = dir ?? process.cwd()
  } catch (err) {
    if (isDeletedCwdError(err)) return null
    throw err
  }
  return existsSync(target) ? target : null
}

/**
 * Guidance for a session whose working directory was deleted while it ran.
 *
 * `deletedCwdMessage` is read before there is a session — it tells the reader to
 * launch the CLI. This one is read from inside a running session, by the model
 * and the operator, so it says what is broken now and what to do instead.
 */
export function deletedCwdSessionMessage(): string {
  return (
    `The working directory for this session no longer exists — it was deleted ` +
    `while the session was running.\n` +
    `Tools that need a directory cannot run until the session is restarted from ` +
    `a directory that exists.`
  )
}
