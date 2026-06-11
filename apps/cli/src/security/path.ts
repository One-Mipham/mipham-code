import { resolve, normalize } from 'node:path'
import { realpathSync, existsSync } from 'node:fs'

/**
 * Sensitive system paths that tools should never access.
 * Relative to filesystem root; checked after resolving symlinks.
 */
const BLOCKED_PATHS = ['/etc', '/proc', '/sys', '/dev', '/boot', '/root']

/**
 * Resolve a user-supplied path relative to cwd, with sandbox enforcement.
 *
 * Rules:
 * - The resolved canonical path MUST be within `cwd` (or a subdirectory).
 * - Symlinks are resolved via realpathSync so attackers can't use
 *   `ln -s /etc project/foo` to escape the sandbox.
 * - Sensitive system directories are always rejected.
 * - If the path doesn't exist yet (e.g. for Write), we resolve its parent
 *   directory and check that the target is still within cwd.
 *
 * @returns The safe canonical path.
 * @throws {Error} with a human-readable message if the path is blocked.
 */
export function resolveSafe(cwd: string, inputPath: string): string {
  const raw = resolve(cwd, inputPath)
  const normalized = normalize(raw)

  // Resolve symlinks if the path (or its parent) already exists on disk
  let canonical: string
  if (existsSync(normalized)) {
    canonical = realpathSync(normalized)
  } else {
    // For paths that don't exist yet (e.g. Write tool creating a new file),
    // walk up to find the first existing parent, resolve that, then
    // reconstruct the full path.
    const existingParent = findExistingParent(normalized)
    if (!existingParent) {
      throw new Error(`Path rejected: no existing parent directory found for "${inputPath}"`)
    }
    const realParent = realpathSync(existingParent)
    const relative = normalized.slice(existingParent.length)
    canonical = realParent + relative
  }

  // Normalize cwd as well (it may contain symlinks)
  const realCwd = realpathSync(cwd)

  // Check 1: must be within cwd
  if (!isWithin(canonical, realCwd)) {
    throw new Error(
      `Path rejected: "${inputPath}" is outside the project workspace.\n` +
        `Resolved: ${canonical}\nWorkspace: ${realCwd}`,
    )
  }

  // Check 2: must not target sensitive system directories
  for (const blocked of BLOCKED_PATHS) {
    if (canonical === blocked || canonical.startsWith(blocked + '/')) {
      throw new Error(
        `Path rejected: "${inputPath}" resolves to a protected system directory (${blocked}).`,
      )
    }
  }

  return canonical
}

/**
 * Find the first existing parent directory of a path.
 * Returns undefined if no parent exists (shouldn't happen for valid paths).
 */
function findExistingParent(p: string): string | undefined {
  let current = p
  while (current.length > 1) {
    const parent = current.slice(0, current.lastIndexOf('/')) || '/'
    if (existsSync(parent)) return parent
    current = parent
  }
  return undefined
}

/**
 * Check if `child` is within `parent` (or equal to it).
 */
function isWithin(child: string, parent: string): boolean {
  // Normalize trailing slashes for comparison
  const c = child.endsWith('/') ? child.slice(0, -1) : child
  const p = parent.endsWith('/') ? parent.slice(0, -1) : parent
  return c === p || c.startsWith(p + '/')
}
