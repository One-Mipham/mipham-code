/**
 * The user's persisted locale choice (`/lang`).
 *
 * Lives in `~/.mipham/settings.json` — the same file telemetry consent uses —
 * because it is the only config writer that preserves keys it does not model.
 * `detectLocale` reads this before `LANG`, so an explicit choice is not
 * overridden by the shell's environment on the next start.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWriteFileSync } from '../shared/atomic-write'
import { readRegularFileSync } from '../shared/regular-file'
import { miphamHome } from '../core/paths.ts'
import { SUPPORTED_LOCALES, type Locale } from './types'

function settingsPath(): string {
  return miphamHome('settings.json')
}

/** The saved locale, or null when absent / unsupported / unreadable. */
export function readLocalePreference(): Locale | null {
  try {
    const raw = readRegularFileSync(settingsPath())
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const value = (parsed as { locale?: unknown }).locale
    return typeof value === 'string' && (SUPPORTED_LOCALES as string[]).includes(value)
      ? (value as Locale)
      : null
  } catch {
    return null
  }
}

/** Persist the choice, preserving unrelated keys. Returns false on write failure. */
export function saveLocalePreference(locale: Locale): boolean {
  try {
    let doc: Record<string, unknown> = {}
    const raw = readRegularFileSync(settingsPath())
    if (raw !== null) {
      const parsed: unknown = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        doc = parsed as Record<string, unknown>
      }
    }
    doc.locale = locale
    const path = settingsPath()
    mkdirSync(dirname(path), { recursive: true })
    atomicWriteFileSync(path, JSON.stringify(doc, null, 2) + '\n', { mode: 0o644 })
    return true
  } catch {
    return false
  }
}
