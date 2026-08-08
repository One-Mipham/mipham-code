import { CREDENTIAL_SENTINEL } from './types'
import type { CredentialMaskingConfig } from '../../shared/index.ts'

/**
 * Filter sensitive environment variables before spawning a subprocess.
 * Returns a sanitized copy of process.env with matching vars removed.
 */
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
