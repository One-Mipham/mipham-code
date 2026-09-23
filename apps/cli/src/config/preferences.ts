/**
 * Lightweight preferences store backed by ~/.mipham/preferences.json.
 * Used for persisting user-level UI state (e.g. last code review effort).
 *
 * NOT for config.yml settings — those belong in the YAML config system.
 * NOT for secrets — this file is plain JSON, not encrypted.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { atomicWriteFileSync } from '../shared/atomic-write'
import { readRegularFileSync } from '../shared/regular-file'
import { miphamHome } from '../core/paths.ts'

const PREFS_PATH = miphamHome('preferences.json')

function readPrefs(): Record<string, string> {
  try {
    // 类型闸在读取之前 —— FIFO 上的 `readFileSync` 会一直等写者（见
    // shared/regular-file.ts）。
    const raw = readRegularFileSync(PREFS_PATH)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Record<string, string>
  } catch {
    return {}
  }
}

function writePrefs(prefs: Record<string, string>): void {
  try {
    const dir = miphamHome()
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    // 原子写：裸 writeFileSync 原地截断，崩在写中途就留下一份不可解析的文件，
    // 而 readPrefs 把不可解析吞成「空」⇒ **全部**偏好静默消失（不是丢一项）。
    atomicWriteFileSync(PREFS_PATH, JSON.stringify(prefs, null, 2), { mode: 0o600 })
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
