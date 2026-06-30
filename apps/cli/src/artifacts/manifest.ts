import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
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
