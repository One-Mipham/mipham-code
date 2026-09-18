import { readFileSync, existsSync, mkdirSync, renameSync, copyFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { atomicWriteFileSync } from '../shared/atomic-write'
import type { ArtifactManifest, ArtifactEntry } from '../shared/types'

function emptyManifest(): ArtifactManifest {
  return { version: 1, artifacts: [] }
}

/**
 * Read the artifact manifest from disk, or return an empty one if it doesn't exist.
 *
 * An unreadable index also yields an empty manifest — the callers here only *show*
 * artifacts (gallery, `/artifact list`), and showing none beats throwing at them.
 * Writers must not go through this path: see `readManifestForUpdate`.
 */
export function readManifest(dir: string): ArtifactManifest {
  const path = join(dir, 'index.json')
  if (!existsSync(path)) {
    return emptyManifest()
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    return emptyManifest()
  }
}

/**
 * Read the manifest for a caller that is about to write it back.
 *
 * The difference from `readManifest` is what happens when the file exists but does
 * not parse: a writer must not treat that as "empty", because writing back an
 * empty manifest replaces every other artifact's entry with nothing — the files
 * stay on disk, but the gallery and `/artifact list` lose them. So the unreadable
 * file is renamed aside (bytes kept, recoverable by hand) and reported, and the
 * caller decides what to tell the user.
 */
function readManifestForUpdate(dir: string): {
  manifest: ArtifactManifest
  quarantined?: string
} {
  const path = join(dir, 'index.json')
  if (!existsSync(path)) return { manifest: emptyManifest() }
  try {
    return { manifest: JSON.parse(readFileSync(path, 'utf-8')) }
  } catch {
    const quarantined = `${path}.corrupt-${new Date().toISOString().replace(/[:.]/g, '-')}`
    // If this rename fails we let it throw: the alternative is overwriting the
    // only copy of the index with a manifest built from nothing.
    renameSync(path, quarantined)
    return { manifest: emptyManifest(), quarantined }
  }
}

/**
 * Write the manifest to disk, creating parent directories as needed.
 *
 * Atomic: a crash mid-write used to leave a truncated `index.json`, which is
 * exactly the corruption `readManifestForUpdate` then has to quarantine.
 */
export function writeManifest(dir: string, manifest: ArtifactManifest): void {
  mkdirSync(dir, { recursive: true })
  atomicWriteFileSync(join(dir, 'index.json'), JSON.stringify(manifest, null, 2), {
    mode: 0o644,
  })
}

/**
 * Add an entry to the manifest and persist it.
 *
 * An entry is identified by `name` **and** `sessionId`, matching how the tool
 * looks one up: the manifest is a single global `index.json` holding every
 * session's artifacts, so keying on the name alone made two sessions publishing
 * the same name overwrite each other's entry — the loser's file stayed on disk
 * but vanished from the index.
 *
 * Returns the written manifest plus, when the previous index was unreadable, the
 * path its bytes were moved to — the caller is expected to say so rather than
 * let an artifact appear to publish cleanly over a lost index.
 */
export function addToManifest(
  dir: string,
  entry: ArtifactEntry,
  port?: number,
): { manifest: ArtifactManifest; quarantined?: string } {
  const { manifest, quarantined } = readManifestForUpdate(dir)
  if (port !== undefined) manifest.port = port

  const idx = manifest.artifacts.findIndex(
    (a) => a.name === entry.name && a.sessionId === entry.sessionId,
  )
  if (idx >= 0) {
    manifest.artifacts[idx] = entry
  } else {
    manifest.artifacts.push(entry)
  }

  writeManifest(dir, manifest)
  return { manifest, quarantined }
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

  // Update manifest entry — keyed on name *and* session, like every other
  // lookup here: a same-named artifact in another session is a different one.
  const manifest = readManifest(dir)
  const artifact = manifest.artifacts.find(
    (a) => a.name === entry.name && a.sessionId === entry.sessionId,
  )
  if (artifact) {
    const versions = artifact.versions || ['v1']
    versions.push(versionTag)
    artifact.versions = versions
    artifact.versionCount = versionCount
  }

  writeManifest(dir, manifest)
  return versionTag
}
