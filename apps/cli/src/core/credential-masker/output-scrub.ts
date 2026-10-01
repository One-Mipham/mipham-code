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
// The password group must NOT exclude `@`: a literal `@` inside a password is
// illegal per URL syntax, yet `postgres://user:p@ss@host` is exactly how people
// paste connection strings into a shell. Excluding `@` made the group stop at the
// *first* `@`, redacting only `p` and leaving `ss@host` in the clear. Greedy
// `[^/\s]+` runs to the last `@` on the line and backtracks, so the whole password
// goes and the host survives.
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^/\s]+)@/gi

/**
 * Zero-width and formatting characters stripped before anything is matched.
 *
 * They carry no meaning in command output, and their only effect here is to
 * split a key name so a name-based pattern cannot see it: `"api​Key": "…"`
 * reads as `apiKey` to a human and as nothing at all to the regex. Stripping
 * first means every pattern below sees the name the reader sees.
 *
 * ZWJ (U+200D) and ZWNJ (U+200C) are **deliberately kept** — they are
 * load-bearing in emoji sequences and in several writing systems, so stripping
 * them would mangle output this has no business touching. A key split with
 * those two therefore still evades; that is a narrower gap than the one closed
 * here, and the only residue that keeps the fix from corrupting real text.
 */
const FORMAT_CHARS = /[\u00ad\u061c\u200b\u200e\u200f\u2060\ufeff]/g

/**
 * `Authorization: Bearer <token>` — the header name is the one credential
 * carrier the configured patterns do not cover, because neither `authorization`
 * nor the scheme words are key-shaped (`apiKey`, `secret`, `token`, `…_pat`).
 * The secret sits behind `Bearer ` and leaks untouched.
 *
 * Keeps the header name and the scheme so the line stays readable; redacts only
 * the credential, quoted or not.
 */
const AUTH_HEADER_PATTERN =
  /(\b(?:authorization|proxy-authorization)\b\s*["']?\s*[:=]\s*["']?(?:bearer|basic|digest|token)\s+)("[^"]*"|'[^']*'|[^\s"']+)/gi

/**
 * A bare `Bearer <token>` / `Basic <b64>` with no header name in front of it —
 * how the value looks once it is in a shell argument, a log line, or a `.env`.
 *
 * The lookahead is the guard against prose: `Bearer authentication` must not be
 * redacted, so the credential has to contain a digit or a base64/JWT punctuation
 * character. An all-lowercase-letter run of that length is a word, not a token.
 */
const BARE_AUTH_SCHEME_PATTERNS: RegExp[] = [
  /\b(bearer)(\s+)(?=[A-Za-z0-9\-._~+/]*[0-9._~+/=\-])[A-Za-z0-9\-._~+/]{12,}=*/gi,
  /\b(basic)(\s+)(?=[A-Za-z0-9+/]*[0-9+/=A-Z])[A-Za-z0-9+/]{12,}={0,2}/g,
]

/**
 * Scrub credential patterns from stdout/stderr output.
 * Uses the configured output_scrubbing patterns to detect and replace
 * credentials that may have leaked into command output.
 */
export function maskOutput(output: string, config: CredentialMaskingConfig): string {
  if (!config.enabled || !config.output_scrubbing.enabled) return output

  // Normalize away zero-width padding before any name is matched (see FORMAT_CHARS).
  let masked = output.replace(FORMAT_CHARS, '')

  // Redact bare secret tokens by prefix (always on, independent of config patterns).
  masked = masked.replace(TOKEN_REDACTION_PATTERN, CREDENTIAL_SENTINEL)

  // Redact URL-embedded passwords — also shape-based, also always on.
  masked = masked.replace(URL_USERINFO_PATTERN, `$1$2:${CREDENTIAL_SENTINEL}@`)

  // Redact Authorization-header credentials — also shape-based, also always on.
  masked = masked.replace(AUTH_HEADER_PATTERN, `$1${CREDENTIAL_SENTINEL}`)
  for (const regex of BARE_AUTH_SCHEME_PATTERNS) {
    masked = masked.replace(regex, `$1$2${CREDENTIAL_SENTINEL}`)
  }

  // Redact bare sk-/sk-ant-/JWT tokens — wire the SecurityGate credential-leak
  // detection into the output path (defense-in-depth beyond the config patterns).
  masked = SecurityGate.redactCredentialLeak(masked)

  for (const pattern of config.output_scrubbing.patterns) {
    try {
      // Strip (?i) inline flags — JS uses the 'i' flag instead
      const clean = pattern.replace(/^\(\?i\)/, '')
      masked = redactValues(masked, new RegExp(clean, 'gim'))
    } catch {
      // Invalid regex — skip
    }
  }
  return masked
}

/**
 * The separator and the value it introduces, in whichever quoting they arrive.
 *
 * The prefix stops **before** the value's opening quote, deliberately: let it
 * swallow that quote and the quoted branch can no longer match, so the bare
 * branch takes `value"}` whole and the closing quote and brace go with it.
 *
 * `bareQuote` carries a value's opening quote when it has no partner inside the
 * match — what a value containing whitespace looks like, since the configured
 * pattern's own `\S+` cut its match short mid-value. Keeping that quote is what
 * leaves `{"pwd": "<SENTINEL> rest"}` parseable instead of quote-less.
 */
const SEPARATOR_AND_VALUE = /(\s*["']?\s*[:=]\s*)(?:"([^"]*)"|'([^']*)'|(["']?)([^\s"']+))/

/** Redact the value inside one pattern match, keeping separator and quoting. */
function redactValue(match: string): string {
  return match.replace(
    SEPARATOR_AND_VALUE,
    (_m, prefix: string, dbl: string | undefined, sgl: string | undefined, bareQuote: string) => {
      if (dbl !== undefined) return `${prefix}"${CREDENTIAL_SENTINEL}"`
      if (sgl !== undefined) return `${prefix}'${CREDENTIAL_SENTINEL}'`
      return `${prefix}${bareQuote}${CREDENTIAL_SENTINEL}`
    },
  )
}

/**
 * Run one configured pattern over `input`, redacting every value it names.
 *
 * An explicit scan rather than `String.replace`, because the resume point has to
 * land **inside** the match. A compact JSON line has no whitespace, so the
 * pattern's own `\S+` runs to the end of it: the first pair's match *contains*
 * every pair after it, and `String.replace` resumes past all of them — redacting
 * only the first. That is not a hypothetical shape; `/config` prints
 * `JSON.stringify(config)`, which is exactly this, several `apiKey`s and all.
 * Resuming just past the value we redacted lets the same pattern see the next
 * pair. (The redaction that destroys the tail instead — replacing `\S+` wholesale
 * — hides the leak rather than fixing it, and mangles the line doing so.)
 */
function redactValues(input: string, scan: RegExp): string {
  const out: string[] = []
  let emitted = 0
  let match: RegExpExecArray | null
  scan.lastIndex = 0
  while ((match = scan.exec(input)) !== null) {
    const hit = match[0]
    if (hit.length === 0) {
      // Zero-length match: step over it or `exec` will not advance.
      scan.lastIndex++
      continue
    }
    const inner = SEPARATOR_AND_VALUE.exec(hit)
    if (!inner) {
      // No separator in the match, so nothing here to redact — emit it untouched
      // and let the scan carry on past it.
      out.push(input.slice(emitted, match.index + hit.length))
      emitted = match.index + hit.length
      continue
    }
    const consumed = inner.index + inner[0].length
    out.push(input.slice(emitted, match.index), redactValue(hit.slice(0, consumed)))
    emitted = match.index + consumed
    // Not `scan.lastIndex = emitted + hit.length`: the rest of the match has to stay
    // in view. It is emitted unchanged by a later iteration (or by the tail below).
    scan.lastIndex = emitted
  }
  out.push(input.slice(emitted))
  return out.join('')
}
