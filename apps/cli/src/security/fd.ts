import { openSync, writeFileSync, closeSync, constants } from 'node:fs'

/**
 * O_NOFOLLOW is POSIX-only; on Windows it is undefined. Fall back to 0 (a
 * no-op) — Windows symlinks are governed by different semantics, and
 * `resolveSafe` still rejects UNC/device-namespace paths and workspace
 * escapes before any file is opened.
 */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0

/**
 * Open a file with O_NOFOLLOW so a symlink swapped in after path resolution
 * (a TOCTOU race) fails with ELOOP instead of being silently followed.
 *
 * `resolveSafe` resolves symlinks at check time, but the returned canonical
 * path is a *string*; re-opening it by path re-resolves the filesystem. If a
 * concurrent process replaces the final component with a symlink between the
 * check and the open, O_NOFOLLOW makes the open fail closed.
 *
 * Callers combine with their own flags (O_RDONLY / O_WRONLY / O_CREAT /
 * O_TRUNC). Throws ELOOP when the path is a symlink.
 */
export function openNoFollow(path: string, flags: number, mode?: number): number {
  return openSync(path, flags | O_NOFOLLOW, mode)
}

/** True if `err` is ELOOP — a symlink was encountered where O_NOFOLLOW forbade following it. */
export function isSymlinkLoop(err: unknown): boolean {
  return (err as NodeJS.ErrnoException)?.code === 'ELOOP'
}

/**
 * Open a file O_WRONLY|O_NOFOLLOW, write `content`, and close. Used by Write
 * and Edit so a symlink swapped in after `resolveSafe` is rejected rather than
 * followed (writing through it would clobber an out-of-workspace target).
 *
 * `flags` should include O_WRONLY|O_TRUNC (and O_CREAT for Write). Throws
 * ELOOP when the path is a symlink.
 */
export function writeFileNoFollow(
  path: string,
  content: string,
  flags: number,
  mode = 0o666,
): void {
  const fd = openSync(path, flags | O_NOFOLLOW, mode)
  try {
    writeFileSync(fd, content, 'utf-8')
  } finally {
    closeSync(fd)
  }
}
