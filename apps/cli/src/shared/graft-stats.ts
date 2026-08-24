import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Graft's hook-maintained stats cache (`graft/.cache/stats.json`). */
export interface GraftStats {
  nodeCount: number
  edgeCount: number
  staleCount: number
  dirty: boolean
  syncing: boolean
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
    }
  } catch {
    return null
  }
}
