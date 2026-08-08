import { homedir } from 'node:os'
import type { CredentialMaskingConfig, CredentialFileRule } from '../../shared/index.ts'

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

// ── Internal helpers ──

/**
 * Expand ~ to the user's home directory.
 */
export function expandHome(p: string): string {
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
 * - ? single char
 * - ~ home directory expansion
 * - basename-only matching (e.g. ".env*" matches any .env file)
 */
export function matchPath(filePath: string, pattern: string): boolean {
  const expandedPattern = expandHome(pattern)
  const normalizedFile = filePath.replace(/\\/g, '/')
  const normalizedPattern = expandedPattern.replace(/\\/g, '/')

  if (normalizedFile === normalizedPattern) return true

  // File ends with pattern (for relative basename matching like ".env*")
  if (normalizedFile.endsWith('/' + normalizedPattern)) return true

  const regex = globToRegex(normalizedPattern)
  if (regex.test(normalizedFile)) return true

  // Basename-only matching: patterns without path separators match
  // against the last component of the file path (e.g. ".env*" matches any .env file)
  if (!normalizedPattern.includes('/')) {
    const basename = normalizedFile.split('/').pop() || normalizedFile
    if (regex.test(basename)) return true
  }

  return false
}

/**
 * Convert a glob pattern to a RegExp.
 * - ** → .* (matches any path segments)
 * - *  → [^/]* (matches within a single segment)
 * - ?  → . (single char)
 * - All other special regex chars are escaped.
 */
export function globToRegex(pattern: string): RegExp {
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
