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
  // Text formatters/transforms that take an input file and write to stdout.
  // These were missing, so `Read(secret)` was bypassed by `fmt secret` /
  // `column -t secret` — the file sits after the command's own options.
  'fmt',
  'column',
  'pr',
  'fold',
  'expand',
  'unexpand',
  'rev',
  'look',
  'bat',
  // Structured readers and byte-level utilities that read their file argument.
  'jq',
  'yq',
  'base64',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'shasum',
  'cksum',
  'sum',
  'cmp',
  'iconv',
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
 * Commands that wrap another command as their payload. A Read/Edit deny rule
 * must still apply when the reader/writer is wrapped (`sudo cat X`, `env -C / X`,
 * `timeout 5 X`) — otherwise the wrapper silently bypasses the rule.
 */
const PREFIX_COMMANDS = new Set([
  'sudo',
  'doas',
  'nohup',
  'command',
  'exec',
  'nice',
  'timeout',
  'env',
  'xargs',
  'eval',
  'stdbuf',
])

/** Value-taking options of wrapper commands (consume the following token). */
const PREFIX_VALUE_OPTIONS = new Set([
  '-u',
  '--user',
  '-g',
  '--group',
  '-h',
  '--host',
  '-p',
  '--prompt', // sudo/doas
  '-n',
  '--adjustment', // nice (and xargs --max-args)
  '-k',
  '--kill-after',
  '-s',
  '--signal', // timeout
  '-C',
  '--chdir',
  '--unset',
  '-S',
  '--split-string', // env
  '-a',
  '--arg-file',
  '-E',
  '--eof',
  '-I',
  '--replace',
  '-P',
  '--max-procs', // xargs
])

/**
 * Shell interpreters whose `-c` argument is itself a complete command line.
 *
 * Deliberately NOT added to PREFIX_COMMANDS: that table shares
 * PREFIX_VALUE_OPTIONS, where `-s` means `timeout --signal` — a shell's option
 * grammar (`-c`, merged clusters like `-lc`, `-o <name>`) has nothing in common
 * with a wrapper's value-taking options, and its payload is a *new command line*
 * to re-parse rather than "the real command".
 *
 * This table is a security surface, not a compatibility surface: every name
 * added is another matching path. Deliberately excluded — interpreters that
 * evaluate *another language* (`node -e`, `python -c`, `awk`), remote execution
 * (`ssh host '…'`, `docker exec`), script files (`bash x.sh`, `source x.sh`,
 * whose payload is a file rather than a command line), and `find -exec`.
 */
const SHELL_COMMANDS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh', 'ash'])

/** Shell short-option letters that consume the next token as a value (`-o pipefail`). */
const SHELL_VALUE_LETTERS = 'o'

/** Shell long options that consume the next token as a value. */
const SHELL_VALUE_OPTIONS = new Set(['--init-file', '--rcfile'])

/** How many `-c` / `$()` payload levels are re-parsed. Shared by both recursion
 *  paths — a single counter is what makes the bound hold; separate counters
 *  would let `bash -c 'bash -c "$(…)"'` alternate past it. */
const MAX_COMMAND_DEPTH = 5

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

/** Shell 结构符号：分组与取反 —— 它们自身不是命令，紧跟其后的是。 */
const LEADING_SHELL_PUNCT = new Set(['(', '{', '!'])

/** Shell 关键字：其后才是真正的命令（`do rm -rf x` 执行的命令是 `rm`）。 */
const LEADING_SHELL_KEYWORDS = new Set([
  'do',
  'then',
  'else',
  'elif',
  'if',
  'while',
  'until',
  'for',
  'case',
  'time',
  'coproc',
])

/** 一条前导赋值：`NAME=value`（name 是合法标识符，`=` 前无引号）。 */
const LEADING_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * 剥掉一段 shell 片段**前导**的噪声 token，露出真正的基命令。
 *
 * 为什么需要它：`Bash(rm *)` / `Read(secret)` 这类规则要匹配的是**命令本身**，
 * 而 shell 允许在命令前放赋值（`IFS=x rm -rf x`）、分组符号（`( rm -rf x )`）、
 * 关键字（`for …; do rm -rf x; done`）。这些都不改变「执行了什么命令」，却足以
 * 让匹配器看不到 `rm`，于是 deny 规则被一个空格级的改写绕过。
 *
 * 只剥前导、可反复剥（`FOO=1 ! rm …`）。剥多了一律是过匹配，而 deny 规则的过
 * 匹配是安全方向。关键字自己的裸 flag 也一并剥掉（`time -p rm …` 里的 `-p`），
 * 否则关键字被剥走后会剩下 `-p rm …`，仍然看不见 `rm`。
 *
 * 不剥尾随符号（`rm -rf x )` 里的 `)`）：`wildcardMatch` 的 `*` 已经吃掉它。
 */
export function stripLeadingShellNoise(segment: string): string {
  let tokens = segment.trim().split(/\s+/).filter(Boolean)
  let stripped = false
  let skipFlags = false
  for (;;) {
    const head = tokens[0]
    if (!head) break
    if (skipFlags && /^--?[A-Za-z]/.test(head)) {
      tokens = tokens.slice(1)
      stripped = true
      continue
    }
    skipFlags = false
    const bare = head.replace(/^[({!]+/, '') // `(!` 这类连写
    if (bare !== head) {
      tokens = bare ? [bare, ...tokens.slice(1)] : tokens.slice(1)
      stripped = true
      continue
    }
    if (LEADING_SHELL_PUNCT.has(head) || LEADING_ASSIGNMENT_RE.test(head)) {
      tokens = tokens.slice(1)
      stripped = true
      continue
    }
    if (LEADING_SHELL_KEYWORDS.has(head)) {
      tokens = tokens.slice(1)
      stripped = true
      skipFlags = true // `time -p rm …` —— 关键字自己的裸 flag 不是命令
      continue
    }
    break
  }
  return stripped ? tokens.join(' ') : segment
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
 * Flatten a command into every matchable sub-command: its shell segments plus
 * the commands nested inside `$(...)`/backtick substitutions and shell `-c`
 * payloads (recursively, bounded by MAX_COMMAND_DEPTH). So a `Bash(rm *)` deny
 * rule also matches `REPORTTIME=$(rm -rf ~)` — zsh evaluates substitutions in
 * REPORTTIME/REPORTMEMORY/DIRSTACKSIZE assignments immediately — and
 * `bash -c 'rm -rf /'`. Over-matching is the safe direction for a deny rule.
 */
function flattenCommand(command: string, depth = 0): string[] {
  const out: string[] = []
  for (const seg of splitShellSegments(command)) {
    out.push(seg)
    const stripped = stripPrefixCommand(seg)
    if (stripped !== seg) out.push(stripped)
    // 剥掉前导噪声后的形态也要参与匹配：`IFS=x rm -rf x` / `( rm -rf x )` /
    // `for …; do rm -rf x; done` 执行的仍是 `rm`，规则必须看得见它。同一个函数
    // 也被 scanReaderWriterCommands 用（Read/Write/Edit 桥接那条路径）—— 两条
    // 路径共用一份归一化，只接一条就是只修一半。
    const denoised = stripLeadingShellNoise(seg)
    if (denoised !== seg) out.push(denoised)
    for (const inner of extractSubstitutions(seg)) {
      out.push(...flattenCommand(inner, depth + 1))
    }
    // A shell `-c` payload is a command line in its own right, so `Bash(rm *)`
    // must also match `bash -c 'rm -rf /'`. Past the depth bound recursion stops
    // outright rather than pushing the raw payload: the raw text
    // (`bash -c 'rm -rf /'`) matches no `rm …` pattern anyway, and stopping
    // keeps the boundary predictable.
    const { payload } = effectiveCommand(seg.split(/\s+/).filter(Boolean))
    if (payload && depth < MAX_COMMAND_DEPTH) out.push(...flattenCommand(payload, depth + 1))
  }
  return out
}

/**
 * Resolve the effective command and its arguments after any wrapper prefix
 * commands (`sudo`, `env`, `timeout`, …). Skips the wrapper and its own options
 * (flags, the values of value-taking flags, `env`'s `VAR=value` assignments, and
 * `timeout`'s positional duration) to reach the real command. Conservative, not a
 * full parser: only recognized wrappers are stripped, so an unrecognized token is
 * always treated as the command (never skipped) — which over-matches, the safe
 * direction for a deny rule.
 */
function effectiveCommand(tokens: string[]): {
  base: string
  args: string[]
  payload: string | null
} {
  let i = 0
  let payload: string | null = null
  while (i < tokens.length) {
    const name = (tokens[i] || '').split('/').pop() || ''
    if (!PREFIX_COMMANDS.has(name)) break
    i++ // skip the wrapper
    while (i < tokens.length && tokens[i]!.startsWith('-')) {
      const opt = tokens[i]!
      i++
      if (PREFIX_VALUE_OPTIONS.has(opt) && i < tokens.length) i++ // skip the flag's value
    }
    if (name === 'env') {
      while (i < tokens.length && tokens[i]!.includes('=')) i++ // `VAR=value` assignments
    }
    if (name === 'timeout') i++ // positional duration
    // `eval`'s remaining arguments are themselves a command line, and must be
    // captured here rather than via the SHELL_COMMANDS branch below: `eval "cat
    // secret"` tokenizes to ['eval', '"cat', 'secret"'], so the base degrades to
    // `"cat` — a name no command set contains. The quotes land on *different*
    // tokens, so de-quoting a single token cannot recover it either.
    if (name === 'eval' && payload === null && i < tokens.length) {
      payload = stripQuotes(tokens.slice(i).join(' '))
    }
  }
  if (i >= tokens.length) return { base: '', args: [], payload }
  const base = (tokens[i] || '').split('/').pop() || ''
  if (payload === null && SHELL_COMMANDS.has(base)) payload = shellPayload(tokens, i)
  return { base, args: tokens.slice(i + 1), payload }
}

/**
 * The command string a shell runs via `-c` (`bash -c 'cat X'`). Only `-c` yields
 * a nested command line — a script-file operand (`bash x.sh`) does not — so the
 * scan stops at the first non-flag token, per getopt: `bash script.sh -c foo` is
 * NOT a payload. Short options are walked as a cluster because shells accept
 * `-lc` / `-xc` / `-euo pipefail`, which a flat option table (PREFIX_VALUE_OPTIONS)
 * can never match.
 *
 * The payload is reassembled from every remaining token rather than taken from
 * the one right after `-c`: it is a single shell word that routinely contains
 * spaces (`'while read f; do cat "$f"; done'`), so whitespace tokenization has
 * split it apart.
 */
function shellPayload(tokens: string[], start: number): string | null {
  let i = start + 1
  while (i < tokens.length) {
    const t = tokens[i]!
    if (!/^[-+]/.test(t) || t === '-' || t === '+') return null // first operand ends option parsing
    if (t === '--') return null
    if (t.startsWith('--')) {
      i += SHELL_VALUE_OPTIONS.has(t) ? 2 : 1
      continue
    }
    const body = t.slice(1)
    let consumed = 0
    let inline: string | null = null
    for (let k = 0; k < body.length; k++) {
      const letter = body[k]!
      if (letter === 'c') {
        inline = body.slice(k + 1) // `-c'cat X'` attaches the payload to the flag
        break
      }
      if (SHELL_VALUE_LETTERS.includes(letter)) {
        if (k + 1 >= body.length) consumed = 1 // value is the next token
        break
      }
    }
    if (inline !== null) {
      const tail = tokens.slice(i + 1).join(' ')
      return stripQuotes([inline, tail].filter(Boolean).join(' ')) || null
    }
    i += 1 + consumed
  }
  return null
}

/** A command with any wrapper prefix commands stripped, so `sudo rm -rf /`
 *  matches a `Bash(rm *)` rule. Returns the input unchanged when there is no
 *  wrapper (or nothing but wrappers). */
function stripPrefixCommand(command: string): string {
  const tokens = command.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return command
  const { base, args } = effectiveCommand(tokens)
  if (!base) return command
  return [base, ...args].join(' ')
}

/**
 * Detect reader/writer commands at the front of each shell segment and recurse
 * into command substitutions and shell `-c` payloads, so both
 * `echo $(cat .git-credentials)` and `bash -c 'cat .git-credentials'` are caught.
 */
function scanReaderWriterCommands(
  command: string,
  read: string[],
  write: string[],
  depth = 0,
): void {
  for (const seg of splitShellSegments(command)) {
    // 先剥前导噪声再 tokenize：`IFS=x cat secret` / `! cat secret` /
    // `time -p cat secret` 读的是同一个文件，Read() 规则必须看得见 `cat`。
    // 与 flattenCommand 共用 stripLeadingShellNoise —— 两条路径一份归一化。
    const tokens = stripLeadingShellNoise(seg).split(/\s+/).filter(Boolean)
    if (tokens.length > 0) {
      const { base, args, payload } = effectiveCommand(tokens)
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
      // Re-parse a shell `-c` payload: `bash -c 'cat secret'` reads `secret`
      // just as directly as `cat secret` does.
      if (payload && depth < MAX_COMMAND_DEPTH) {
        scanReaderWriterCommands(payload, read, write, depth + 1)
      }
    }
    for (const inner of extractSubstitutions(seg)) {
      scanReaderWriterCommands(inner, read, write, depth + 1)
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
  // command — `rm -rf /` buried in `foo && rm -rf /` still matches — or a
  // `$(...)`/backtick substitution, so `Bash(rm *)` catches `x=$(rm -rf ~)`).
  if (baseTool === 'Bash') {
    const cmd = String(toolInput.command || '')
    return flattenCommand(cmd).some((seg) => wildcardMatch(subPattern!, seg))
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
