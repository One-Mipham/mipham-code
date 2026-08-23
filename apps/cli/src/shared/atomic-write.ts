import { writeFileSync, renameSync } from 'node:fs'

/**
 * Write a file atomically: write to a same-directory `.tmp` file, then rename
 * over the target. Same-filesystem rename is atomic, so a crash or kill
 * mid-write can never leave a truncated/corrupt file — readers see either the
 * old or the new content, never a partial write.
 */
export function atomicWriteFileSync(
  path: string,
  content: string,
  options: { mode?: number } = {},
): void {
  const tmp = path + '.tmp'
  writeFileSync(tmp, content, { encoding: 'utf-8', mode: options.mode ?? 0o600 })
  renameSync(tmp, path)
}
