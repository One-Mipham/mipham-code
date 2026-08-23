import { existsSync, readdirSync } from 'node:fs'
import { dirname, basename, join } from 'node:path'

/**
 * Suggest existing directories that match a partial `/cd` target.
 *
 * `path` must already be tilde-expanded and resolved by the caller (`/cd`
 * passes the `resolve()`d target). Given a path that does not (fully) exist,
 * walk up to its nearest existing ancestor and return the subdirectories whose
 * names prefix-match the trailing segment. Files and non-matching entries are
 * excluded. Returns `[]` when the path already exists or nothing matches.
 */
export function suggestDirectories(path: string): string[] {
  if (existsSync(path)) return []

  let ancestor = dirname(path)
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) return [] // hit filesystem root
    ancestor = parent
  }

  const prefix = basename(path)
  let entries
  try {
    entries = readdirSync(ancestor, { withFileTypes: true })
  } catch {
    return []
  }

  return entries
    .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
    .map((e) => join(ancestor, e.name))
    .sort()
}
