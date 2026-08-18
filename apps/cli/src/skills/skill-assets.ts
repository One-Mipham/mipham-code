import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { BUNDLED_SKILL_ASSETS, type BundledSkillAsset } from './bundled-skill-assets'

export interface SkillAssetsOptions {
  /** Base dir under which assets land as `<baseDir>/<skillName>/...`. Defaults to `~/.mipham/skills`. */
  baseDir?: string
  /** Asset map. Defaults to the compiled-in snapshot. Injectable for tests. */
  assets?: Record<string, BundledSkillAsset[]>
}

/**
 * Idempotently extract a skill's bundled executable assets to disk.
 * Content-compare: only writes when a file is missing or its content drifted,
 * so user-added files (e.g. site-patterns/*.md) are never overwritten.
 * Assets are UTF-8 text only today — binary assets would need base64 (see
 * generate-bundled-skills.ts). Returns the extraction root, or null if the
 * skill bundles no assets.
 */
export function ensureSkillAssets(skillName: string, opts?: SkillAssetsOptions): string | null {
  const map = opts?.assets ?? BUNDLED_SKILL_ASSETS
  const base = opts?.baseDir ?? join(homedir(), '.mipham', 'skills')
  const list = map[skillName]
  if (!list) return null
  const root = join(base, skillName)
  for (const a of list) {
    const dest = join(root, a.path)
    const needsWrite = !existsSync(dest) || readFileSync(dest, 'utf-8') !== a.content
    if (needsWrite) {
      mkdirSync(dirname(dest), { recursive: true })
      // Preserve the source exec bit (scripts/*.mjs), default 0o644 for docs.
      writeFileSync(dest, a.content, { mode: a.mode ?? 0o644 })
    }
  }
  return root
}
