import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const DEFAULT_VERSIONS_DIR = join(homedir(), '.mipham', 'artifacts')

export interface ArtifactVersion {
  name: string
  version: number
  path: string
  createdAt: string
  size: number
}

/**
 * Manages artifact version snapshots on disk.
 *
 * Directory layout:
 *   <dir>/<name>/versions/v1.html
 *   <dir>/<name>/versions/v2.html
 *   <dir>/<name>/current.html     (latest snapshot)
 *   <dir>/<name>/manifest.json    ({ name, currentVersion, versionCount })
 */
export class ArtifactVersioning {
  private dir: string

  constructor(dir?: string) {
    this.dir = dir ?? DEFAULT_VERSIONS_DIR
    mkdirSync(this.dir, { recursive: true })
  }

  /** Save a new version of an artifact. Returns the assigned version number. */
  saveVersion(name: string, content: string): number {
    const artifactDir = join(this.dir, name)
    const versionsDir = join(artifactDir, 'versions')
    mkdirSync(versionsDir, { recursive: true })

    // Determine next version number
    const existing = this.listVersions(name)
    const nextVersion = (existing.length > 0 ? Math.max(...existing.map((v) => v.version)) : 0) + 1

    // Save versioned file
    const versionPath = join(versionsDir, `v${nextVersion}.html`)
    writeFileSync(versionPath, content, 'utf-8')

    // Update current.html
    writeFileSync(join(artifactDir, 'current.html'), content, 'utf-8')

    // Update manifest
    writeFileSync(
      join(artifactDir, 'manifest.json'),
      JSON.stringify(
        {
          name,
          currentVersion: nextVersion,
          versionCount: nextVersion,
        },
        null,
        2,
      ),
    )

    return nextVersion
  }

  /** List all saved versions for an artifact, newest first. */
  listVersions(name: string): ArtifactVersion[] {
    const versionsDir = join(this.dir, name, 'versions')
    if (!existsSync(versionsDir)) return []

    try {
      return readdirSync(versionsDir)
        .filter((f) => f.startsWith('v') && f.endsWith('.html'))
        .map((f) => {
          const vNum = parseInt(f.replace('v', '').replace('.html', ''), 10)
          const path = join(versionsDir, f)
          const stat = statSync(path)
          return {
            name,
            version: vNum,
            path,
            createdAt: stat.birthtime.toISOString(),
            size: stat.size,
          }
        })
        .sort((a, b) => b.version - a.version)
    } catch {
      return []
    }
  }

  /**
   * Get artifact content.
   * - If a version number is given, returns that specific version.
   * - Otherwise returns the latest (current.html).
   * Returns null if the requested version does not exist.
   */
  getVersion(name: string, version?: number): string | null {
    const artifactDir = join(this.dir, name)

    if (version !== undefined) {
      const vPath = join(artifactDir, 'versions', `v${version}.html`)
      return existsSync(vPath) ? readFileSync(vPath, 'utf-8') : null
    }

    const currentPath = join(artifactDir, 'current.html')
    return existsSync(currentPath) ? readFileSync(currentPath, 'utf-8') : null
  }

  /** Produce a simple line-by-line text diff between two versions. */
  diff(name: string, v1: number, v2: number): string {
    const content1 = this.getVersion(name, v1) || ''
    const content2 = this.getVersion(name, v2) || ''
    const lines1 = content1.split('\n')
    const lines2 = content2.split('\n')

    const diffLines: string[] = []
    const maxLen = Math.max(lines1.length, lines2.length)
    for (let i = 0; i < maxLen; i++) {
      if (lines1[i] !== lines2[i]) {
        if (lines1[i] !== undefined) diffLines.push(`- ${lines1[i]}`)
        if (lines2[i] !== undefined) diffLines.push(`+ ${lines2[i]}`)
      }
    }
    return diffLines.length > 0 ? diffLines.join('\n') : '(no changes)'
  }
}
