import { writeFileSync, renameSync, unlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

/**
 * Write a file atomically: write to a same-directory temp file, then rename
 * over the target. Same-filesystem rename is atomic, so a crash or kill
 * mid-write can never leave a truncated/corrupt file — readers see either the
 * old or the new content, never a partial write.
 *
 * The temp name carries the pid and a random suffix rather than being a fixed
 * `path + '.tmp'`. Several callers write to *shared* locations (the telemetry
 * queue on every process exit, skill usage, the CRSI ledger), so two sessions or
 * daemon workers on one machine can be inside this function for the same path at
 * the same time. With one shared temp name that interleaving loses a write (the
 * first rename moves the *second* writer's content into place) and then throws
 * ENOENT on the other writer's rename — in a function whose whole point is that
 * the target is never observed half-written. Same directory is still required:
 * rename is only atomic within a filesystem.
 */
export function atomicWriteFileSync(
  path: string,
  content: string,
  options: { mode?: number } = {},
): void {
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    writeFileSync(tmp, content, { encoding: 'utf-8', mode: options.mode ?? 0o600 })
    renameSync(tmp, path)
  } catch (err) {
    // Clean up on the failure path: a fixed temp name used to be overwritten by
    // the next writer, but unique names mean every abandoned write would leave
    // its own orphan forever — nothing else ever sweeps this directory.
    try {
      unlinkSync(tmp)
    } catch {
      // Already renamed away (or never created) — nothing to clean.
    }
    throw err
  }
}
