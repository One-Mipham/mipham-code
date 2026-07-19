/**
 * Mipham Code — Self-update utilities.
 *
 * Shared between the CLI entry point (bin/mipham.ts) and the TUI slash
 * command handler (commands.ts) so that both `mipham update` and `/upgrade`
 * use the same logic.
 */

import { readFileSync, existsSync, copyFileSync, mkdirSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'

const PACKAGE = '@miphamai/cli'
const HOME = homedir()
const MIPHAM_HOME = join(HOME, '.mipham')
const CONFIG_PATH = join(MIPHAM_HOME, 'config.yml')

export interface UpdateCheck {
  /** Current installed version */
  current: string
  /** Latest version on npm */
  latest: string
  /** Whether an update is available */
  available: boolean
}

/**
 * Read the currently installed version from package.json.
 */
export function getCurrentVersion(): string {
  try {
    // Try the CLI's own package.json first
    const cliPkg = join(import.meta.dirname!, '..', '..', 'package.json')
    if (existsSync(cliPkg)) {
      const pkg = JSON.parse(readFileSync(cliPkg, 'utf-8'))
      return pkg.version
    }
  } catch {
    // fall through
  }
  return 'unknown'
}

/**
 * Fetch the latest version from the npm registry.
 * Returns the version string, or throws on failure.
 */
function fetchLatestVersion(): string {
  const result = execSync(`npm view ${PACKAGE} version --json`, {
    encoding: 'utf-8',
    timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim()
  return result.replace(/"/g, '')
}

/**
 * Check if an update is available by comparing the local version
 * against the npm registry.
 */
export function checkForUpdates(): UpdateCheck {
  const current = getCurrentVersion()
  let latest = current
  let available = false

  try {
    latest = fetchLatestVersion()
    available = compareVersions(latest, current) > 0
  } catch {
    // If we can't reach npm, treat as up-to-date (don't alarm the user)
  }

  return { current, latest, available }
}

/**
 * Back up the user's config.yml before an update.
 * Returns the backup path, or null if backup wasn't possible.
 */
export function backupConfig(label: string): string | null {
  if (!existsSync(CONFIG_PATH)) return null
  try {
    mkdirSync(MIPHAM_HOME, { recursive: true, mode: 0o700 })
    const ts = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = join(MIPHAM_HOME, `config.pre-${label}-${ts}.yml`)
    copyFileSync(CONFIG_PATH, backupPath)
    chmodSync(backupPath, 0o600) // owner read/write only — contains API keys
    return backupPath
  } catch {
    return null
  }
}

/** Validate a semver string before passing it to a shell command. */
const SEMVER_RE = /^\d+\.\d+\.\d+(-[a-zA-Z0-9.]+)?(\+[a-zA-Z0-9.]+)?$/

function isValidSemver(v: string): boolean {
  return SEMVER_RE.test(v)
}

/**
 * Perform the actual update via npm install -g.
 * Validates the version string before shell execution (prevents command injection).
 * Returns true on success.
 */
export function performUpdate(version: string): boolean {
  if (!isValidSemver(version)) {
    process.stderr.write(`⚠ Refusing to install invalid version: "${version}"\n`)
    return false
  }

  try {
    execSync(`npm install -g ${PACKAGE}@${version}`, {
      encoding: 'utf-8',
      stdio: 'inherit',
      timeout: 120_000,
    })
    return true
  } catch {
    return false
  }
}

/**
 * Restore config from a backup path.
 */
export function restoreConfig(backupPath: string): boolean {
  if (!existsSync(backupPath)) return false
  try {
    copyFileSync(backupPath, CONFIG_PATH)
    return true
  } catch {
    return false
  }
}

/**
 * Get the config path so callers can verify it survived.
 */
export function getConfigPath(): string {
  return CONFIG_PATH
}

/**
 * Compare two semver strings. Returns >0 if a > b, <0 if a < b, 0 if equal.
 */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const da = pa[i] ?? 0
    const db = pb[i] ?? 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}
