import type { PermissionRuleEntry } from '../shared/index.ts'
import { matchPath } from './credential-masker/matcher'

// ── Bash command analysis (Read/Write/Edit deny-rule extension) ──
//
// A Read(/etc/passwd) deny rule must also refuse Bash commands that read that
// file (`cat /etc/passwd`, `tac /etc/passwd`, `grep x /etc/passwd`,
// `< /etc/passwd`) — not only the Read tool. Same for Write/Edit rules and
// `> file` redirects / in-place editors. These helpers map a Bash command to
// the file paths it touches, conservatively: over-matching is the safe
// direction for a deny rule, under-matching is not.

/** Commands that read a file and print its contents (bypass Read() rules today). */
const READER_COMMANDS = new Set([
  'cat',
  'tac',
  'head',
  'tail',
  'less',
  'more',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'sed',
  'perl',
  'awk',
  'nl',
  'sort',
  'uniq',
  'cut',
  'diff',
  'comm',
  'join',
  'paste',
  'file',
  'stat',
  'xxd',
  'od',
  'hexdump',
  'strings',
  'wc',
  'view',
  'zcat',
  'bzcat',
])

/** Commands that write/modify a file (bypass Write()/Edit() rules today). */
const WRITER_COMMANDS = new Set([
  'tee',
  'touch',
  'nano',
  'vi',
  'vim',
  'emacs',
  'ed',
  'ex',
  'cp',
  'mv',
  'rm',
  'dd',
  'install',
  'truncate',
])

/**
 * Split a (possibly compound) shell command into simple-command segments, so a
 * Bash(pattern) rule matches any segment rather than only the whole string
 * (`rm -rf /` buried in `foo && rm -rf /` must still match).
 *
 * Separators: `&&` `||` `;` `|` `&` and newline. Redirect operators (`>`,
 * `>>`, `<`) are NOT separators — they belong to the same simple command.
 * Quoting is not parsed (a `&` inside quotes still splits), which only
 * over-matches — the safe direction for deny rules.
 */
export function splitShellSegments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||&|\n|\r/g)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s[0]
    const last = s[s.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return s.slice(1, -1)
    }
  }
  return s
}

function uniq(items: string[]): string[] {
  return [...new Set(items)]
}

/** File paths a Bash command reads or writes. */
export interface BashFileAccess {
  read: string[]
  write: string[]
}

/**
 * Extract the file paths a Bash command reads or writes, so Read()/Write()/
 * Edit() deny rules also apply to Bash (not just the Read/Write/Edit tools).
 * Covers redirects (`<` reads, `>`/`>>` writes) and reader/writer command
 * arguments — including inside `$(...)` and backtick substitutions. Deliberately
 * conservative, not a full shell parser.
 */
export function extractBashFileAccess(command: string): BashFileAccess {
  const read: string[] = []
  const write: string[] = []

  // 1. Redirect targets. Handles `> file` and `>file`, optional fd prefix
  //    (`2>`, `&>`). Heredocs (`<<`) and fd-dup targets (`2>&1`) are skipped —
  //    their "target" is a delimiter or file descriptor, not a path.
  const redirectRe = /(?:^|[\s;|&])([0-9]*&?)?(>>|<<|<|>)\s*([^\s;|&<>]+)/g
  let m: RegExpExecArray | null
  while ((m = redirectRe.exec(command)) !== null) {
    const op = m[2]!
    if (op === '<<') continue // heredoc delimiter
    const target = stripQuotes(m[3]!)
    if (op === '<') read.push(target)
    else write.push(target)
  }

  // 2. Reader/writer command arguments (non-flag args are candidate paths),
  //    recursing into `$(...)` / backtick substitutions.
  scanReaderWriterCommands(command, read, write)

  return { read: uniq(read), write: uniq(write) }
}

/** Extract the inner commands of `$(...)` and backtick substitutions. */
function extractSubstitutions(command: string): string[] {
  const inners: string[] = []
  let m: RegExpExecArray | null
  // `$(...)` — non-nested groups; deeper nesting is handled by the recursion
  // in scanReaderWriterCommands (each level is extracted on the next pass).
  const dollarParen = /\$\(([^()]*)\)/g
  while ((m = dollarParen.exec(command)) !== null) inners.push(m[1]!)
  const backtick = /`([^`]*)`/g
  while ((m = backtick.exec(command)) !== null) inners.push(m[1]!)
  return inners
}

/**
 * Detect reader/writer commands at the front of each shell segment and recurse
 * into command substitutions, so `echo $(cat .git-credentials)` is caught.
 */
function scanReaderWriterCommands(command: string, read: string[], write: string[]): void {
  for (const seg of splitShellSegments(command)) {
    const tokens = seg.split(/\s+/).filter(Boolean)
    if (tokens.length > 0) {
      const base = (tokens[0] || '').split('/').pop() || ''
      const args = tokens.slice(1)
      if (READER_COMMANDS.has(base)) {
        // `sed -i` / `perl -i` read AND write their file args.
        const inPlace = args.some((a) => a === '-i' || a.startsWith('--in-place'))
        for (const arg of args) {
          if (arg.startsWith('-')) continue
          const p = stripQuotes(arg)
          read.push(p)
          if (inPlace) write.push(p)
        }
      } else if (WRITER_COMMANDS.has(base)) {
        for (const arg of args) {
          if (arg.startsWith('-')) continue
          write.push(stripQuotes(arg))
        }
      }
    }
    for (const inner of extractSubstitutions(seg)) {
      scanReaderWriterCommands(inner, read, write)
    }
  }
}

// Match a tool(parameter) rule against an actual tool call.
//
// Pattern formats:
//   "Bash"              → matches any Bash call
//   "Bash(git:*)"       → matches "git status", "git diff --cached", etc.
//   "Bash(npm test:*)"  → matches "npm test -- --coverage"
//   "Write(/etc/*)"     → matches Write to /etc/passwd, /etc/hosts, etc.
//   "Read(**/.ssh/*)"   → matches Read of any path under .ssh
//   "Grep(**/vendor)"   → matches Grep rooted under a vendor directory
//   "Glob(**/.ssh)"     → matches Glob rooted under a .ssh directory
export function matchBashRule(
  pattern: string,
  toolName: string,
  toolInput: Record<string, unknown>,
): boolean {
  // Check if pattern has a parenthesized sub-pattern
  const parenMatch = pattern.match(/^(\w+)\((.+)\)$/)
  if (!parenMatch) {
    // Plain tool name match: "Bash", "Write"
    return toolName === pattern
  }

  const [, baseTool, subPattern] = parenMatch

  // A Read/Write/Edit rule must also refuse a Bash command that touches the
  // same file (via a reader/editor command or a redirect), not only the
  // Read/Write/Edit tool itself. Otherwise `cat .git-credentials` bypasses a
  // `Read(.git-credentials)` deny rule.
  if (toolName === 'Bash' && (baseTool === 'Read' || baseTool === 'Write' || baseTool === 'Edit')) {
    const cmd = String(toolInput.command || '')
    const access = extractBashFileAccess(cmd)
    const paths = baseTool === 'Read' ? access.read : access.write
    return paths.some((p) => matchPath(p, subPattern!))
  }

  if (toolName !== baseTool!) return false

  // For Bash: match against the command string (any segment of a compound
  // command — `rm -rf /` buried in `foo && rm -rf /` still matches).
  if (baseTool === 'Bash') {
    const cmd = String(toolInput.command || '')
    return splitShellSegments(cmd).some((seg) => wildcardMatch(subPattern!, seg))
  }

  // For Write/Edit/Read: match against the file_path with path-glob semantics.
  // Use matchPath (NOT wildcardMatch): wildcardMatch is tuned for Bash commands
  // (`:` → colon-or-whitespace, `*` → `.*`), which is wrong for filesystem
  // paths — `*` would cross `/` and Windows drive letters like `C:\` get mangled.
  if (baseTool === 'Write' || baseTool === 'Edit' || baseTool === 'Read') {
    const path = String(toolInput.file_path || '')
    return matchPath(path, subPattern!)
  }

  // For Grep/Glob: match against the base search path (a directory)
  if (baseTool === 'Grep' || baseTool === 'Glob') {
    const path = String(toolInput.path || '')
    return matchPath(path, subPattern!)
  }

  return false
}

export function wildcardMatch(pattern: string, input: string): boolean {
  const regexStr =
    '^' +
    pattern
      .replace(/[.+^${}()|[\]\\*?]/g, '\\$&') // escape regex specials (incl. * and ?)
      .replace(/:/g, '[:\\s]') // : → match colon or whitespace
      .replace(/\\\*/g, '.*') // * → .*
      .replace(/\\\?/g, '.') + // ? → .
    '$'
  return new RegExp(regexStr).test(input)
}

/**
 * Validate a rule pattern string's structure, mirroring exactly what
 * `matchBashRule` / `ruleMatches` will actually match. A pattern that is
 * syntactically valid but never matches (e.g. `Bash(ls) x`, `Read(foo`,
 * `Bash()`) is silently dead today — this returns a human-readable reason so
 * the caller can report it as an invalid setting instead of ignoring it.
 *
 * Returns null when the pattern is valid, or a reason string when malformed.
 */
export function validateRulePattern(pattern: string): string | null {
  if (!pattern.trim()) return 'rule pattern is empty'

  if (pattern.includes('(')) {
    if (!pattern.includes(')')) return 'unclosed parenthesis'
    // Empty parameter: `Bash()` or `Bash( )`
    if (/\(\s*\)$/.test(pattern)) return 'empty parameter'
    // Must be exactly `ToolName(param)` with nothing before or after.
    if (!/^(\w+)\((.+)\)$/.test(pattern)) {
      return 'unexpected text after the closing parenthesis'
    }
    return null
  }

  // No parenthesis → must be a plain tool name (matched via `pattern === tool.name`).
  if (!/^\w+$/.test(pattern)) return 'not a single tool name'
  return null
}

/** Compile a rule pattern string into a PermissionRuleEntry. */
export function compileRule(pattern: string, level: 'allow' | 'deny' | 'ask'): PermissionRuleEntry {
  const invalid = validateRulePattern(pattern)
  const regexStr =
    '^' +
    pattern
      .replace(/[.+^${}()|[\]\\*?]/g, '\\$&')
      .replace(/:/g, '[:\\s]')
      .replace(/\\\*/g, '.*')
      .replace(/\\\?/g, '.') +
    '$'
  return { pattern, level, compiled: new RegExp(regexStr), ...(invalid ? { invalid } : {}) }
}
