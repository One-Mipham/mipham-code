import { CREDENTIAL_SENTINEL } from './types'
import type { CredentialMaskingConfig } from '../../shared/index.ts'

/**
 * Well-known secret token prefixes. These are high-signal formats that must
 * never leak into output, independent of the configured patterns.
 * - GitHub: ghp_ (personal access), gho_ (OAuth), ghs_ (server), ghu_/ghr_ (user/server-to-server), github_pat_ (fine-grained)
 * - GitLab: glpat- (personal access), gldt- (deploy), glrt- (runner), gloas- (OAuth app)
 */
const TOKEN_REDACTION_PATTERN =
  /\b(?:ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|glpat-|gldt-|glrt-|gloas-)[A-Za-z0-9_-]{8,}/g

/**
 * Scrub credential patterns from stdout/stderr output.
 * Uses the configured output_scrubbing patterns to detect and replace
 * credentials that may have leaked into command output.
 */
export function maskOutput(output: string, config: CredentialMaskingConfig): string {
  if (!config.enabled || !config.output_scrubbing.enabled) return output

  let masked = output

  // Redact bare secret tokens by prefix (always on, independent of config patterns).
  masked = masked.replace(TOKEN_REDACTION_PATTERN, CREDENTIAL_SENTINEL)

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
