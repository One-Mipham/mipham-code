import { CREDENTIAL_SENTINEL } from './types'
import type { CredentialMaskingConfig } from '../../shared/index.ts'

/**
 * Scrub credential patterns from stdout/stderr output.
 * Uses the configured output_scrubbing patterns to detect and replace
 * credentials that may have leaked into command output.
 */
export function maskOutput(output: string, config: CredentialMaskingConfig): string {
  if (!config.enabled || !config.output_scrubbing.enabled) return output

  let masked = output
  for (const pattern of config.output_scrubbing.patterns) {
    try {
      // Strip (?i) inline flags — JS uses the 'i' flag instead
      const clean = pattern.replace(/^\(\?i\)/, '')
      const regex = new RegExp(clean, 'gim')
      masked = masked.replace(regex, (match) => {
        // Replace everything after the separator (= or :)
        return match.replace(/\s*[:=]\s*\S+/, `=${CREDENTIAL_SENTINEL}`)
      })
    } catch {
      // Invalid regex — skip
    }
  }
  return masked
}
