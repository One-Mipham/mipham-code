/**
 * Lightweight preferences store backed by ~/.mipham/preferences.json.
 * Used for persisting user-level UI state (e.g. last code review effort).
 *
 * NOT for config.yml settings — those belong in the YAML config system.
 * NOT for secrets — this file is plain JSON, not encrypted.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PREFS_PATH = join(homedir(), '.mipham', 'preferences.json')

function readPrefs(): Record<string, string> {
  try {
    if (!existsSync(PREFS_PATH)) return {}
    const raw = readFileSync(PREFS_PATH, 'utf-8')
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Record<string, string>
  } catch {
    return {}
  }
}

function writePrefs(prefs: Record<string, string>): void {
  try {
    const dir = join(homedir(), '.mipham')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2), { mode: 0o600, encoding: 'utf-8' })
  } catch {
    // best-effort; never crash because preferences failed to save
  }
}

export function getPreference(key: string, defaultValue: string): string {
  const prefs = readPrefs()
  return prefs[key] ?? defaultValue
}

export function setPreference(key: string, value: string): void {
  const prefs = readPrefs()
  prefs[key] = value
  writePrefs(prefs)
}
