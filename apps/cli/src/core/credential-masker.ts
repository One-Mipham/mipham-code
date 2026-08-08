import { homedir } from 'node:os'
import type { CredentialMaskingConfig, CredentialFileRule } from '../shared/index.ts'

/** Sentinel value used to replace masked credentials. */
export const CREDENTIAL_SENTINEL = '__MIPHAM_CREDENTIAL_MASKED__'

/**
 * Check if a file path matches any credential file rule.
 * Returns the matching rule, or null if no match.
 */
export function matchCredentialFile(
  filePath: string,
  config: CredentialMaskingConfig,
): CredentialFileRule | null {
  if (!config.enabled || config.files.length === 0) return null

  const expanded = expandHome(filePath)
  for (const rule of config.files) {
    if (matchPath(expanded, rule.path)) {
      return rule
    }
  }
  return null
}

/**
 * Apply credential masking to file content.
 * - 'full' mode: return sentinel value only
 * - 'extract' mode: replace regex-matched tokens with sentinel
 */
export function maskContent(content: string, rule: CredentialFileRule): string {
  // jwt and aws types use `type` instead of `mode` — passthrough for now
  if (!('mode' in rule)) {
    return content
  }

  if (rule.mode === 'full') {
    return CREDENTIAL_SENTINEL
  }

  // extract mode
  let masked = content
  for (const extractRule of rule.extract) {
    const replacement = extractRule.replacement || CREDENTIAL_SENTINEL
    try {
      const regex = new RegExp(extractRule.pattern, 'gm')
      masked = masked.replace(regex, replacement)
    } catch {
      // Invalid regex — skip this rule silently
    }
  }
  return masked
}

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

/**
 * Get the file display name for a sentinel value (for model visibility).
 * The model sees the sentinel, doesn't know the original file path.
 */
export function getSentinelDisplay(hint?: string): string {
  if (hint) {
    return `[Credential file masked: ${hint}]`
  }
  return CREDENTIAL_SENTINEL
}

// ── Internal helpers ──

/**
 * Expand ~ to the user's home directory.
 */
function expandHome(p: string): string {
  if (p.startsWith('~')) {
    return homedir() + p.slice(1)
  }
  return p
}

/**
 * Match a file path against a glob-like pattern.
 * Supports:
 * - ** globstar (matches any number of path segments)
 * - * wildcard within a single path segment
 * - ~ home directory expansion
 * - basename-only matching (e.g. ".env*" matches any .env file)
 */
function matchPath(filePath: string, pattern: string): boolean {
  const expandedPattern = expandHome(pattern)
  const normalizedFile = filePath.replace(/\\/g, '/')
  const normalizedPattern = expandedPattern.replace(/\\/g, '/')

  // Exact match
  if (normalizedFile === normalizedPattern) {
    return true
  }

  // File ends with pattern (for relative basename matching like ".env*")
  if (normalizedFile.endsWith('/' + normalizedPattern)) {
    return true
  }

  // Convert glob pattern to regex
  const regex = globToRegex(normalizedPattern)
  return regex.test(normalizedFile)
}

/**
 * Convert a glob pattern to a RegExp.
 * - ** → .* (matches any path segments)
 * - *  → [^/]* (matches within a single segment)
 * - ?  → . (single char)
 * - All other special regex chars are escaped.
 */
function globToRegex(pattern: string): RegExp {
  let regexStr = ''
  let i = 0
  while (i < pattern.length) {
    const ch = pattern[i]!
    if (ch === '*' && pattern[i + 1] === '*') {
      // ** — match zero or more path segments
      regexStr += '.*'
      i += 2
      // Skip trailing slash after **
      if (pattern[i] === '/') i++
      continue
    }
    if (ch === '*') {
      regexStr += '[^/]*'
      i++
      continue
    }
    if (ch === '?') {
      regexStr += '.'
      i++
      continue
    }
    // Escape regex special chars
    if ('\\^$.|+()[]{}'.includes(ch)) {
      regexStr += '\\' + ch
    } else {
      regexStr += ch
    }
    i++
  }
  return new RegExp('^' + regexStr + '$')
}
