import { CREDENTIAL_SENTINEL } from './types'
import type { CredentialMaskingConfig } from '../../shared/index.ts'
import { SecurityGate } from '../../security/gate'

/**
 * Well-known secret token prefixes. These are high-signal formats that must
 * never leak into output, independent of the configured patterns.
 * - GitHub: ghp_ (personal access), gho_ (OAuth), ghs_ (server), ghu_/ghr_ (user/server-to-server), github_pat_ (fine-grained)
 * - GitLab: glpat- (personal access), gldt- (deploy), glrt- (runner), gloas- (OAuth app)
 */
const TOKEN_REDACTION_PATTERN =
  /\b(?:ghp_|gho_|ghs_|ghu_|ghr_|github_pat_|glpat-|gldt-|glrt-|gloas-)[A-Za-z0-9_-]{8,}/g

/**
 * Credentials embedded in a URL's userinfo — `scheme://user:password@host`.
 *
 * Nothing in the *name* gives this away: `DATABASE_URL` holds no secret word,
 * so a name-based pattern cannot see it (and masking every `*_URL` would take
 * out every non-secret endpoint too). The shape is the only reliable tell.
 * Redacts the password and keeps user + host, or the line stops being readable.
 */
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s@]+)@/gi

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

  // Redact URL-embedded passwords — also shape-based, also always on.
  masked = masked.replace(URL_USERINFO_PATTERN, `$1$2:${CREDENTIAL_SENTINEL}@`)

  // Redact bare sk-/sk-ant-/JWT tokens — wire the SecurityGate credential-leak
  // detection into the output path (defense-in-depth beyond the config patterns).
  masked = SecurityGate.redactCredentialLeak(masked)

  for (const pattern of config.output_scrubbing.patterns) {
    try {
      // Strip (?i) inline flags — JS uses the 'i' flag instead
      const clean = pattern.replace(/^\(\?i\)/, '')
      const regex = new RegExp(clean, 'gim')
      masked = masked.replace(regex, (match) => {
        // Replace everything after the separator (= or :), swallowing the quote
        // a JSON-shaped hit puts in front of it (`"apiKey": "…"`).
        return match.replace(/\s*["']?\s*[:=]\s*["']?\S+/, `=${CREDENTIAL_SENTINEL}`)
      })
    } catch {
      // Invalid regex — skip
    }
  }
  return masked
}
