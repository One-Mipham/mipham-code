import { existsSync } from 'node:fs'
import { join, delimiter } from 'node:path'

// Windows executable extensions (subset of PATHEXT) probed for bare names.
const WINDOWS_EXECUTABLES = ['.exe', '.cmd', '.bat', '.com']

/**
 * Check whether a command-line binary is available on the system PATH.
 * Accepts an explicit `pathVar` for testability; defaults to `process.env.PATH`.
 * A value containing a path separator is treated as an explicit path and
 * checked for existence directly.
 */
export function isBinAvailable(bin: string, pathVar: string = process.env.PATH || ''): boolean {
  // Explicit path (absolute or relative) — check existence directly.
  if (bin.includes('/') || bin.includes('\\')) {
    return existsSync(bin)
  }

  const isWindows = process.platform === 'win32'
  const names = isWindows ? WINDOWS_EXECUTABLES.map((ext) => bin + ext) : [bin]
  const dirs = pathVar.split(delimiter).filter(Boolean)

  for (const dir of dirs) {
    for (const name of names) {
      if (existsSync(join(dir, name))) return true
    }
  }
  return false
}

/**
 * Return the subset of `bins` that are NOT available on PATH. An empty result
 * means every required binary is present.
 */
export function checkRequiredBins(
  bins: string[],
  pathVar: string = process.env.PATH || '',
): string[] {
  return bins.filter((bin) => !isBinAvailable(bin, pathVar))
}
