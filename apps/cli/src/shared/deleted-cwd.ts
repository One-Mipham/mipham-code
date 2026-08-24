/**
 * Detection and messaging for the "current working directory was deleted"
 * startup failure.
 *
 * `process.cwd()` throws `ENOENT` when the directory the process was launched
 * from no longer exists (e.g. a removed git worktree). The CLI entry checks
 * this up front and prints a clear, actionable message instead of letting the
 * error surface as a raw crash dump (matches Claude Code 2.1.239).
 */

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
