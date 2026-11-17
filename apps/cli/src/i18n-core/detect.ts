import type { Locale } from './types'
import { execSync } from 'node:child_process'

export function detectLocale(opts?: {
  lang?: string
  /** The user's persisted `/lang` choice (read by the caller; see preference.ts). */
  settingsLocale?: string | null
  cwd?: string
}): Locale {
  // 1. CLI --lang flag
  if (opts?.lang) {
    const normalized = normalizeLocale(opts.lang)
    if (normalized) return normalized as Locale
  }

  // 2. Explicit user preference — beats the environment, or LANG=zh_CN would
  //    silently override someone who chose en-US.
  if (opts?.settingsLocale) {
    const normalized = normalizeLocale(opts.settingsLocale)
    if (normalized) return normalized as Locale
  }

  // 3. LANG / LC_ALL env vars
  const langEnv = process.env.LC_ALL || process.env.LANG || ''
  const envLocale = parseLangEnv(langEnv)
  if (envLocale) return envLocale

  // 4. OS detection
  const osLocale = detectOSLocale()
  if (osLocale) return osLocale

  // 5. Fallback
  return 'en-US'
}

function normalizeLocale(raw: string): string | null {
  const lower = raw.toLowerCase().replace('_', '-')
  if (lower.startsWith('zh')) return 'zh-CN'
  if (lower.startsWith('en')) return 'en-US'
  return null
}

function parseLangEnv(env: string): Locale | null {
  if (!env || env === 'C' || env === 'POSIX') return null
  return normalizeLocale(env) as Locale | null
}

function detectOSLocale(): Locale | null {
  try {
    if (process.platform === 'darwin') {
      const out = execSync('defaults read -g AppleLocale 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 1000,
      }).trim()
      return normalizeLocale(out) as Locale | null
    }
    if (process.platform === 'win32') {
      // Use Intl as fallback — the kernel32 approach is too complex for startup
      return normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale) as Locale | null
    }
    // Linux: try LANG env one more time, then Intl
    return normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale) as Locale | null
  } catch {
    return null
  }
}
