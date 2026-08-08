import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { homedir } from 'node:os'

const MIPHAM_HOME = join(homedir(), '.mipham')
const TRUST_STORE_PATH = join(MIPHAM_HOME, 'trusted-workspaces.json')

export interface TrustedWorkspaces {
  version: 1
  directories: string[]
  updatedAt: string
}

/**
 * Resolves a directory to its real absolute path, following symlinks.
 * Falls back to the resolved path if realpath fails.
 */
function realPath(dir: string): string {
  try {
    // Use resolve to normalize, but don't require the directory to exist yet
    const resolved = resolve(dir)
    return resolved
  } catch {
    return resolve(dir)
  }
}

/**
 * Manages the workspace trust store.
 *
 * Trust is hierarchical: a directory is trusted if it or any of its
 * ancestor directories are in the trust store. This means trusting
 * /Users/me/Projects implicitly trusts all subdirectories.
 */
export class WorkspaceTrust {
  private store: TrustedWorkspaces

  constructor() {
    this.store = this.load()
  }

  /** Load the trust store from disk, or return a fresh default. */
  private load(): TrustedWorkspaces {
    try {
      if (!existsSync(TRUST_STORE_PATH)) {
        return { version: 1, directories: [], updatedAt: new Date().toISOString() }
      }
      const raw = readFileSync(TRUST_STORE_PATH, 'utf-8')
      const parsed = JSON.parse(raw) as TrustedWorkspaces
      if (parsed.version !== 1) {
        // Unknown version — reset
        return { version: 1, directories: [], updatedAt: new Date().toISOString() }
      }
      return parsed
    } catch {
      return { version: 1, directories: [], updatedAt: new Date().toISOString() }
    }
  }

  /** Persist the trust store to disk. */
  private save(): void {
    try {
      if (!existsSync(MIPHAM_HOME)) {
        mkdirSync(MIPHAM_HOME, { recursive: true })
      }
      this.store.updatedAt = new Date().toISOString()
      writeFileSync(TRUST_STORE_PATH, JSON.stringify(this.store, null, 2), 'utf-8')
    } catch {
      // Best-effort: don't crash if we can't save
    }
  }

  /**
   * Check whether a directory is trusted.
   * A directory is trusted if it or any ancestor is in the trust list.
   */
  isTrusted(dir: string): boolean {
    const resolved = realPath(dir)
    const resolvedLower = resolved.toLowerCase()

    for (const trusted of this.store.directories) {
      const trustedLower = trusted.toLowerCase()
      // Exact match
      if (resolvedLower === trustedLower) return true
      // Ancestor match: trusted dir is a parent of the target
      if (resolvedLower.startsWith(trustedLower + '/')) return true
    }

    return false
  }

  /** Add a directory to the trust store. */
  trust(dir: string): void {
    const resolved = realPath(dir)
    // Don't add duplicates
    if (this.store.directories.includes(resolved)) return
    // Don't add subdirectories of already-trusted paths
    if (this.isTrusted(resolved)) return

    this.store.directories.push(resolved)
    // Sort for readability
    this.store.directories.sort()
    this.save()
  }

  /** Remove a directory from the trust store (and any subdirectories). */
  untrust(dir: string): void {
    const resolved = realPath(dir)
    const resolvedLower = resolved.toLowerCase()

    this.store.directories = this.store.directories.filter((d) => {
      const lower = d.toLowerCase()
      // Remove exact match and all subdirectories
      return lower !== resolvedLower && !lower.startsWith(resolvedLower + '/')
    })
    this.save()
  }

  /** List all trusted directories. */
  listTrusted(): string[] {
    return [...this.store.directories]
  }

  /** Get the path to the trust store. */
  getStorePath(): string {
    return TRUST_STORE_PATH
  }
}

// ── Singleton ──

let _instance: WorkspaceTrust | null = null

export function getWorkspaceTrust(): WorkspaceTrust {
  if (!_instance) {
    _instance = new WorkspaceTrust()
  }
  return _instance
}

/** Reset the singleton (for tests). */
export function resetWorkspaceTrust(): void {
  _instance = null
}
