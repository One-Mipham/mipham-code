import { homedir } from 'node:os'
import { isAbsolute, join, normalize } from 'node:path'
import { realpathSync } from 'node:fs'
import type { PermissionRuleEntry } from '../shared/index.ts'
import { expandHome, matchPath } from './credential-masker/matcher'

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

/** `timeout` 的 duration 形态：`5` / `0.5` / `30s` / `2m` / `1h` / `1d`。 */
const TIMEOUT_DURATION_RE = /^\d+(\.\d+)?[smhd]?$/

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
 * 展开候选路径里**已知**的变量：前导 `~`、`$HOME`/`${HOME}`。
 *
 * 为什么需要：规则里写的是绝对路径（`Read(/Users/me/.ssh/id_rsa)`），而用户敲的
 * 是同一个文件的另一种拼法（`cat ~/.ssh/id_rsa`）—— 不展开即等于放行。展开后
 * 两种拼法落到同一个字符串上，绝对路径形与路径通配形（如「.ssh 下任意文件」）
 * 规则都能命中。
 *
 * **只展开 HOME**。`$FOO` 这类未知变量原样保留：展开它需要求值环境，静默展开成
 * 空串会让 `/x/$FOO/y` 变成 `/x//y` —— 那是**新增**一个漏判方向，比不展开更坏。
 * `$PWD` 同理需要 cwd，而 `matchBashRule` 的调用点拿不到 cwd，故未覆盖。这两条
 * 都是本函数已知的边界，不是遗漏。
 *
 * `~` 只在**开头**展开（`a/~/b` 里的 `~` 是普通字符，shell 也不展开它）。
 */
export function expandKnownPathVars(p: string): string {
  const home = homedir() // 每次取，不在模块加载时绑定（HOME 可能被测试隔离改写）
  let out = p
  if (out === '~') out = home
  else if (out.startsWith('~/')) out = join(home, out.slice(2))
  return out.replace(/\$\{?HOME\}?/g, home)
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

  // 展开放在出口这一处，而不是每个 push 点 —— 重定向与读/写命令、以及它们的
  // 递归内层都汇进这两个数组，一处展开即全覆盖。
  return { read: uniq(read.map(expandKnownPathVars)), write: uniq(write.map(expandKnownPathVars)) }
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
  // 进程替换 `<(cmd)` / `>(cmd)`：`cat <(cat secret)` 里读 secret 的是里层的
  // `cat`，外层只是把它的 stdout 当成一个文件名。参数排除 `<>` 是因为
  // `<(cat secret)` 的捕获若允许 `>`，遇到 `>(...)` 形态会被提前截断；非嵌套组
  // 由调用方的递归处理。
  const procSub = /[<>]\(([^()<>]*)\)/g
  while ((m = procSub.exec(command)) !== null) inners.push(m[1]!)
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
    // `timeout` 的位置参数是 duration，**不是**必然存在：`timeout 5 cmd` 有，
    // `timeout --preserve-status cmd` 没有。无条件 `i++` 会把后者真正的命令
    // （`cat`）当成 duration 吃掉，基命令退化成它的第一个参数。
    if (name === 'timeout' && i < tokens.length && TIMEOUT_DURATION_RE.test(tokens[i]!)) i++
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

/**
 * `matchBashRule` 真正会按参数匹配工具名的集合。**与 matchBashRule 的分支一一
 * 对应** —— 那里 `return false` 的工具，参数化规则在 validateRulePattern 里必须
 * 被拒（否则规则永远不命中，是静默空防护）。改一边必须改另一边。
 */
const PARAMETERISED_TOOLS = new Set(['Bash', 'Read', 'Write', 'Edit', 'Grep', 'Glob'])

/**
 * The **landing** spelling of a path *or a pattern*: the realpath of its
 * longest **existing** prefix, with everything after that prefix kept verbatim.
 * Returns the input unchanged when nothing along it exists.
 *
 * A prefix walk rather than a bare `realpathSync`, for two reasons:
 *
 * - A rule may legitimately name a leaf that does not exist yet
 *   (`Write(/tmp/new.txt)`) — `realpathSync` on it throws, so a leaf-only
 *   resolve would decide that a path the tool is about to create has no
 *   landing at all.
 * - macOS resolves `/tmp` → `/private/tmp` (likewise `/etc`, `/var`), so a
 *   pattern has to be resolved **the same way as the path** or `/tmp/**` stops
 *   matching its own files. Resolving only one side is what turns a tightening
 *   into a silent refusal.
 *
 * A prefix whose segments carry a glob metacharacter is not a path on disk
 * (`/tmp/*` denotes "whatever is under /tmp"), so the walk steps over it: the
 * glob-free prefix gets resolved and `*` / `**` / `?` survive verbatim.
 */
function resolveLanding(p: string): string {
  const parts = expandHome(p).replace(/\\/g, '/').split('/')
  for (let i = parts.length; i > 0; i--) {
    const prefix = parts.slice(0, i).join('/')
    if (!prefix || /[*?]/.test(prefix)) continue
    try {
      const real = realpathSync(prefix)
      const rest = parts.slice(i).join('/')
      return rest ? `${real}/${rest}` : real
    } catch {
      // Not on disk — try its parent.
    }
  }
  return p
}

/**
 * Where `p` would read if nothing along it were a symlink — the same string
 * spelled without touching the disk. Used only to ask "did resolving this path
 * change anything", never as a match candidate.
 */
function lexicallySpelled(p: string): string {
  const expanded = expandHome(p).replace(/\\/g, '/')
  if (isAbsolute(expanded) || /^[A-Za-z]:\//.test(expanded)) return normalize(expanded)
  return normalize(join(process.cwd(), expanded))
}

/**
 * Match a path rule against the path an operation *lands* on, not just the one
 * it was spelled with. `notes.txt` symlinked to `.env` **is** a read of `.env`,
 * and the rule only ever sees the spelling the model sent.
 *
 * Deny/ask (`segmentMode === 'any'`): a miss is a hole, and the resolved form
 * can only *add* matches — this direction is strictly fail-closed, and cannot
 * un-protect anything protected today.
 *
 * Allow (`'all'`) is the direction where a grant can leak, so the landing has to
 * be inside the same grant: an allow rule granting every `.txt` file no longer
 * auto-approves a `.txt` symlink that lands on `.env`. The extra judgement is
 * gated on the path actually having been redirected — if resolving it changes
 * nothing, there is no second spelling to disagree about and the decision is
 * identical to the literal one. Patterns are resolved on the same axes as paths
 * precisely so that gate does not misfire on `/tmp/**`, on a pattern naming a
 * symlink on purpose, or on a leaf that does not exist yet.
 */
function matchPathRule(path: string, pattern: string, segmentMode: 'any' | 'all'): boolean {
  const literal = matchPath(path, pattern)
  const landing = resolveLanding(path)
  // The pattern canonicalised on the same axes as the path (`/tmp/**` →
  // `/private/tmp/**`). `expandHome` first: `matchPath` expands the pattern but
  // never the path, so a `~` pattern has to be absolute before it is resolved.
  const canon = resolveLanding(expandHome(pattern))

  if (segmentMode === 'all') {
    if (!literal) return false
    if (landing === lexicallySpelled(path)) return true
    return matchPath(landing, canon)
  }

  if (literal) return true
  if (matchPath(landing, canon)) return true
  try {
    // The pre-existing check, kept verbatim so this direction stays a
    // mechanical superset of what it used to match (it differs only for a path
    // whose own name contains a glob character).
    return matchPath(realpathSync(path), expandHome(pattern))
  } catch {
    // Nothing on disk to resolve (ENOENT, EACCES, a path the model invented) —
    // there is no second spelling to try, and the literal already missed.
    return false
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
  segmentMode: 'any' | 'all' = 'any',
): boolean {
  // Check if pattern has a parenthesized sub-pattern
  const parenMatch = pattern.match(/^(\w+)\((.+)\)$/)
  if (!parenMatch) {
    // Plain tool name match: "Bash", "Write"
    return toolName === pattern
  }

  const [, baseTool, subPattern] = parenMatch

  // How a *compound* command is judged when only some parts match:
  //   'any' (deny / ask) — one matching part is enough. Deliberately wide: a
  //     deny rule that misses a part is a hole, so `foo && rm -rf /` must be
  //     caught by `Bash(rm *)`.
  //   'all' (allow) — every part must match. An allow rule is a *grant*, and
  //     granting on one matching part hands over the whole compound command:
  //     `Bash(git:*)` plus `git status && rm -rf ./src` used to return
  //     `bypass` with no prompt at all.
  // The `length > 0` guard is load-bearing: `[].every()` is `true`, so a
  // command with no matchable segment (or no extracted file access) would
  // otherwise satisfy **any** allow rule — a fail-open of its own.
  const qualifies = (items: string[], match: (s: string) => boolean): boolean =>
    segmentMode === 'all' ? items.length > 0 && items.every(match) : items.some(match)

  // A Read/Write/Edit rule must also refuse a Bash command that touches the
  // same file (via a reader/editor command or a redirect), not only the
  // Read/Write/Edit tool itself. Otherwise `cat .git-credentials` bypasses a
  // `Read(.git-credentials)` deny rule.
  if (toolName === 'Bash' && (baseTool === 'Read' || baseTool === 'Write' || baseTool === 'Edit')) {
    const cmd = String(toolInput.command || '')
    const access = extractBashFileAccess(cmd)
    const paths = baseTool === 'Read' ? access.read : access.write
    return qualifies(paths, (p) => matchPathRule(p, subPattern!, segmentMode))
  }

  if (toolName !== baseTool!) return false

  // For Bash: match against the command string (any segment of a compound
  // command — `rm -rf /` buried in `foo && rm -rf /` still matches — or a
  // `$(...)`/backtick substitution, so `Bash(rm *)` catches `x=$(rm -rf ~)`).
  if (baseTool === 'Bash') {
    const cmd = String(toolInput.command || '')
    return qualifies(flattenCommand(cmd), (seg) => wildcardMatch(subPattern!, seg))
  }

  // For Write/Edit/Read: match against the file_path with path-glob semantics.
  // Use matchPath (NOT wildcardMatch): wildcardMatch is tuned for Bash commands
  // (`:` → colon-or-whitespace, `*` → `.*`), which is wrong for filesystem
  // paths — `*` would cross `/` and Windows drive letters like `C:\` get mangled.
  if (baseTool === 'Write' || baseTool === 'Edit' || baseTool === 'Read') {
    const path = String(toolInput.file_path || '')
    return matchPathRule(path, subPattern!, segmentMode)
  }

  // For Grep/Glob: match against the base search path (a directory)
  if (baseTool === 'Grep' || baseTool === 'Glob') {
    const path = String(toolInput.path || '')
    return matchPathRule(path, subPattern!, segmentMode)
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
 * 校验的是**结构 + 工具名**（后者见 PARAMETERISED_TOOLS）。**不**校验子模式本身
 * 能否匹配任何东西 —— `Bash(zzz *)` 合法、装得上、只是不会命中，那是用户自己的
 * 选择，不是配置错误。
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
    const shape = pattern.match(/^(\w+)\((.+)\)$/)
    if (!shape) {
      return 'unexpected text after the closing parenthesis'
    }
    // 工具名必须落在 matchBashRule 真正会按参数匹配的那一集合里，否则这条规则是
    // **静默空防护**：语法合法、装得上、永远不命中，而用户以为配了保护。
    const tool = shape[1]!
    if (!PARAMETERISED_TOOLS.has(tool)) {
      return `parameterised rules are not supported for tool "${tool}" (it would never match)`
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
