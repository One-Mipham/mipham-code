import { readFileSync, existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { atomicWriteFileSync } from '../shared/atomic-write'
import { miphamHome } from './paths.ts'
import { MIPHAM_DIR } from '../shared/constants.ts'

const MIPHAM_HOME = miphamHome()
const TRUST_STORE_PATH = join(MIPHAM_HOME, 'trusted-workspaces.json')

export interface TrustedWorkspaces {
  version: 1
  directories: string[]
  updatedAt: string
}

/**
 * Resolves a directory to its real absolute path, following symlinks.
 * Falls back to the resolved path if realpath fails.
 *
 * This used to be `resolve()` under a comment claiming it followed symlinks —
 * so trust was checked against the **lexical** spelling while the settings and
 * hooks it gates are read through the **canonical** one. A workspace reached
 * through a symlink (`~/work -> /Volumes/proj`, or macOS's `/tmp -> /private/tmp`)
 * was therefore trusted under one path and read under another.
 *
 * A directory that does not exist yet has no realpath; `resolve` keeps
 * `trust()` usable before the folder is created.
 */
function realPath(dir: string): string {
  try {
    return realpathSync.native(dir)
  } catch {
    return resolve(dir)
  }
}

/**
 * Both spellings of a directory: what the caller typed (normalised) and what
 * the filesystem calls it.
 *
 * Trust entries written before canonicalisation, and paths passed through a
 * symlink, each match only one of the two. Checking both keeps an existing
 * store valid and cannot widen what is trusted — every candidate must itself
 * be inside a trusted directory.
 */
function spellings(dir: string): string[] {
  const literal = resolve(dir)
  const real = realPath(dir)
  return literal === real ? [literal] : [literal, real]
}

/**
 * True if a `.git` file or directory exists anywhere strictly between `dir` and
 * its trusted ancestor `ancestor`. A `.git` marks the root of a separate
 * repository — trust does not cross that boundary (nested-repo isolation).
 */
function hasGitBoundary(dir: string, ancestor: string): boolean {
  let cur = dir
  // Case-insensitive termination matches isTrusted's `toLowerCase()` ancestor
  // check — otherwise a path referenced with different casing than when it was
  // trusted would walk past the ancestor and miss the boundary.
  const targetLower = ancestor.toLowerCase()
  while (cur.toLowerCase() !== targetLower && cur.length > ancestor.length) {
    if (existsSync(join(cur, '.git'))) return true
    const parent = dirname(cur)
    if (parent === cur) break
    cur = parent
  }
  return false
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
      // The version check alone guarded a *field* while leaving the shape open:
      // `{ version: 1 }` passes it and then `for (const trusted of
      // this.store.directories)` throws on `undefined`. Entries must be strings
      // too — `isTrusted` calls `.toLowerCase()` on each one.
      if (
        parsed.version !== 1 ||
        !Array.isArray(parsed.directories) ||
        !parsed.directories.every((d) => typeof d === 'string')
      ) {
        // Unknown version or malformed shape — reset
        return { version: 1, directories: [], updatedAt: new Date().toISOString() }
      }
      return parsed
    } catch {
      return { version: 1, directories: [], updatedAt: new Date().toISOString() }
    }
  }

  /**
   * Persist the trust store to disk.
   *
   * Returns whether the write happened. The caller prints "✓ Workspace
   * trusted", so a swallowed failure here made the UI claim a fact the disk
   * never received — on a read-only or full shared home the next run asked
   * again with no explanation (318-009).
   */
  private save(): boolean {
    try {
      if (!existsSync(MIPHAM_HOME)) {
        mkdirSync(MIPHAM_HOME, { recursive: true })
      }
      this.store.updatedAt = new Date().toISOString()
      // Atomic: this store's own reader swallows a parse failure into a *reset
      // store* (see `load`'s catch), so a write interrupted midway does not just
      // lose the record — it silently un-trusts every directory the user had
      // approved. Fail-closed, but the user never learns why they are being
      // asked again.
      atomicWriteFileSync(TRUST_STORE_PATH, JSON.stringify(this.store, null, 2) + '\n', {
        mode: 0o600,
      })
      return true
    } catch {
      // Don't crash if we can't save — but do report it.
      return false
    }
  }

  /**
   * Check whether a directory is trusted.
   * A directory is trusted if it or any ancestor is in the trust list.
   */
  isTrusted(dir: string): boolean {
    const candidates = spellings(dir)

    for (const trusted of this.store.directories) {
      for (const trustedPath of spellings(trusted)) {
        const trustedLower = trustedPath.toLowerCase()
        for (const candidate of candidates) {
          const candidateLower = candidate.toLowerCase()
          // Exact match
          if (candidateLower === trustedLower) return true
          // Ancestor match: trusted dir is a parent of the target. Trust does not
          // cross a nested git-repository boundary (vendored/submodule isolation).
          if (
            candidateLower.startsWith(trustedLower + '/') &&
            !hasGitBoundary(candidate, trustedPath)
          ) {
            return true
          }
        }
      }
    }

    return false
  }

  /**
   * Add a directory to the trust store.
   *
   * The canonical path is what gets stored: the settings and hooks trust gates
   * are read through the realpath, so recording a symlink's lexical spelling
   * made the two disagree. `isTrusted` still matches older lexical entries.
   *
   * Returns false only when the new entry could not be written to disk; a
   * directory that is already trusted is `true` — it was persisted earlier.
   */
  trust(dir: string): boolean {
    const resolved = realPath(dir)
    // Don't add duplicates
    if (this.store.directories.includes(resolved)) return true
    // Don't add subdirectories of already-trusted paths
    if (this.isTrusted(resolved)) return true

    this.store.directories.push(resolved)
    // Sort for readability
    this.store.directories.sort()
    return this.save()
  }

  /** Remove a directory from the trust store (and any subdirectories). */
  untrust(dir: string): void {
    const targets = spellings(dir).map((p) => p.toLowerCase())

    this.store.directories = this.store.directories.filter((d) => {
      const lower = d.toLowerCase()
      // Remove exact match and all subdirectories, in whichever spelling the
      // entry was recorded.
      return !targets.some((target) => lower === target || lower.startsWith(target + '/'))
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

/**
 * Say out loud that repository-controlled config was skipped because this
 * workspace is not trusted.
 *
 * Call this only when hooks were *actually* withheld — `SettingsJson` reports
 * that (`projectHooksSkipped`), so this cannot announce a skip that never
 * happened.
 *
 * Deliberately not silent. When there is no TTY the trust prompt cannot be
 * asked, so the answer is "no" and the hooks stay out — but a gate that fails
 * without saying so is indistinguishable from one that passed, and the user is
 * left wondering why their hooks do nothing. Written to stderr so it cannot
 * corrupt stdout rendering.
 */
export function warnProjectHooksSkipped(cwd: string): void {
  process.stderr.write(
    `⚠️  Workspace not trusted: skipped hooks from ${join(cwd, MIPHAM_DIR, 'settings.json')}\n` +
      `    (hooks run commands — repository-controlled). Trust this directory in an interactive\n` +
      `    session to enable them.\n`,
  )
}
