import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  copyFileSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import type { ArtifactManifest, ArtifactEntry } from '../shared/types'

/**
 * Read the artifact manifest from disk, or return an empty one if it doesn't exist.
 */
export function readManifest(dir: string): ArtifactManifest {
  const path = join(dir, 'index.json')
  if (!existsSync(path)) {
    return { version: 1, artifacts: [] }
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return { version: 1, artifacts: [] }
  }
}

/**
 * Write the manifest to disk, creating parent directories as needed.
 */
export function writeManifest(dir: string, manifest: ArtifactManifest): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.json'), JSON.stringify(manifest, null, 2), 'utf-8')
}

/**
 * Add an entry to the manifest and persist it.
 * If an entry with the same name already exists, it is replaced.
 */
export function addToManifest(dir: string, entry: ArtifactEntry, port?: number): ArtifactManifest {
  const manifest = readManifest(dir)
  if (port !== undefined) manifest.port = port

  const idx = manifest.artifacts.findIndex((a) => a.name === entry.name)
  if (idx >= 0) {
    manifest.artifacts[idx] = entry
  } else {
    manifest.artifacts.push(entry)
  }

  writeManifest(dir, manifest)
  return manifest
}

/**
 * Get all artifacts for a specific session.
 */
export function getSessionArtifacts(dir: string, sessionId: string): ArtifactEntry[] {
  const manifest = readManifest(dir)
  return manifest.artifacts.filter((a) => a.sessionId === sessionId)
}

/**
 * Archive an existing artifact file by renaming it with a version tag.
 * e.g. dashboard.html → dashboard.v1.html, dashboard.v1.html → dashboard.v2.html.
 *
 * Returns the version tag assigned to the archived file, or `undefined` when
 * there was nothing to archive — in which case the manifest is left untouched.
 *
 * 「没归档就什么都不记」是刻意的：源文件找不到时照样推进版本号、往 `versions` 里
 * 塞一个标签，等于在 manifest 里留一版磁盘上并不存在的版本。走到那条路并不难
 * —— 条目按 name 找、文件按 `<session>/<name><ext>` 找，把同一个名字从 html 改
 * 成 svg 就错开了。宁可少记一版，也不能记一版假的。
 */
export function archiveVersion(dir: string, entry: ArtifactEntry): string | undefined {
  const ext = entry.type === 'svg' ? '.svg' : '.html'
  const baseName = entry.name
  const currentPath = join(dir, entry.sessionId, `${baseName}${ext}`)

  if (!existsSync(currentPath)) return undefined

  const versionCount = (entry.versionCount || 1) + 1
  const versionTag = `v${versionCount}`
  const archivedPath = join(dir, entry.sessionId, `${baseName}.${versionTag}${ext}`)

  try {
    renameSync(currentPath, archivedPath)
  } catch {
    // If rename fails (e.g. cross-device), copy instead
    copyFileSync(currentPath, archivedPath)
    unlinkSync(currentPath)
  }

  // Update manifest entry
  const manifest = readManifest(dir)
  const artifact = manifest.artifacts.find((a) => a.name === entry.name)
  if (artifact) {
    const versions = artifact.versions || ['v1']
    versions.push(versionTag)
    artifact.versions = versions
    artifact.versionCount = versionCount
  }

  writeManifest(dir, manifest)
  return versionTag
}
