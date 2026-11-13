import { CREDENTIAL_SENTINEL } from './types'
import type { CredentialMaskingConfig } from '../../shared/index.ts'

/**
 * Filter sensitive environment variables before spawning a subprocess.
 * Returns a sanitized copy of process.env with matching vars removed.
 */
/** Which variable names the config calls sensitive (same patterns `filterEnv`
 *  uses — one definition of "sensitive", two dispositions). */
export function isSensitiveEnvKey(key: string, config: CredentialMaskingConfig): boolean {
  for (const pattern of config.env_filter.patterns) {
    try {
      // Strip (?i) inline flags — JS uses the 'i' flag instead
      const clean = pattern.replace(/^\(\?i\)/, '')
      if (new RegExp(clean, 'i').test(key)) return true
    } catch {
      // Invalid regex — skip
    }
  }
  return false
}

/**
 * Remove sensitive variables outright — for processes *this program* starts on
 * its own behalf (git, ripgrep).
 *
 * `filterEnv` keeps the name and swaps in a sentinel so the model's shell can
 * tell a value was withheld. That is the wrong shape here: these children never
 * act on the user's behalf, so a credential helper or hook under them should
 * find nothing at all, not a well-formed string that merely isn't the secret.
 */
export function stripEnv(
  env: Record<string, string | undefined>,
  config: CredentialMaskingConfig,
): Record<string, string | undefined> {
  if (!config.enabled || !config.env_filter.enabled) return { ...env }

  const stripped: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    if (!isSensitiveEnvKey(key, config)) stripped[key] = value
  }
  return stripped
}

export function filterEnv(
  env: Record<string, string | undefined>,
  config: CredentialMaskingConfig,
): Record<string, string | undefined> {
  if (!config.enabled || !config.env_filter.enabled) return { ...env }

  const filtered: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(env)) {
    let blocked = false
    for (const pattern of config.env_filter.patterns) {
      try {
        // Strip (?i) inline flags — JS uses the 'i' flag instead
        const clean = pattern.replace(/^\(\?i\)/, '')
        const regex = new RegExp(clean, 'i')
        if (regex.test(key)) {
          blocked = true
          break
        }
      } catch {
        // Invalid regex — skip
      }
    }
    if (blocked) {
      // Replace with sentinel so tools can detect they're filtered
      filtered[key] = CREDENTIAL_SENTINEL
    } else {
      filtered[key] = value
    }
  }

  return filtered
}
