import { readFileSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'

/** Graft's hook-maintained stats cache (`graft/.cache/stats.json`). */
export interface GraftStats {
  nodeCount: number
  edgeCount: number
  staleCount: number
  dirty: boolean
  syncing: boolean
  lastFile: string | null
}

/**
 * Read graft's stats cache for the given project. Returns null when graft is
 * not built/installed in `cwd` (no `graft/.cache/stats.json`, or an empty
 * graph) — callers render nothing in that case.
 */
export function readGraftStats(cwd: string): GraftStats | null {
  const statsPath = join(cwd, 'graft', '.cache', 'stats.json')
  if (!existsSync(statsPath)) return null
  try {
    const raw = JSON.parse(readFileSync(statsPath, 'utf-8')) as Record<string, unknown>
    if (typeof raw.nodeCount !== 'number' || raw.nodeCount === 0) return null
    return {
      nodeCount: raw.nodeCount,
      edgeCount: typeof raw.edgeCount === 'number' ? raw.edgeCount : 0,
      staleCount: typeof raw.staleCount === 'number' ? raw.staleCount : 0,
      dirty: raw.dirty === true,
      syncing: raw.syncing === true,
      lastFile: typeof raw.lastFile === 'string' ? raw.lastFile : null,
    }
  } catch {
    return null
  }
}

/**
 * Find the nearest graft graph by walking up from `cwd` to the filesystem root.
 * Graft builds its cache at the repo root (`graft/.cache/stats.json`), so this
 * also resolves when `cwd` is a subdirectory of a graft-indexed repo — not only
 * the repo root itself.
 */
export function findGraftStats(cwd: string): GraftStats | null {
  let dir = resolve(cwd)
  for (;;) {
    const stats = readGraftStats(dir)
    if (stats) return stats
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}
