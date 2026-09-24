/**
 * Recursive `rm` whose target cannot be read off the command text.
 *
 * `rm -rf node_modules` names what it deletes. `rm -rf "$(pwd)"` does not — the
 * target is produced at run time, so no allow rule, no mode and no reviewer can
 * see how far the deletion reaches.
 *
 * This is deliberately **not** a blocklist of dangerous paths. Those already
 * exist (`tools/exec/bash.ts` BLOCKED_PATTERNS refuses `/`, `~`, `*`, `.` and
 * absolute paths). What is left uncovered is the case where the *path is not in
 * the text at all* — and that case is invisible to every string-matching guard,
 * which is why it has to be recognised structurally instead.
 *
 * Judged on every command line inside the input, via the same `flattenCommand`
 * the deny-rule path uses: reading one normalization while the deny rules read
 * another is how a guard fires on one spelling and not on its twin.
 */

import { flattenCommand } from '../core/permission-rules'

export type DangerousRmKind =
  /** The target is led by command-substitution output: `rm -rf "$(pwd)"`. */
  | 'substitution'
  /** A variable plus one top-level directory name: `rm -rf $ROOT/usr`. */
  | 'variable-top-level'
  /** The target is anchored to a working-directory variable: `rm -rf $PWD`. */
  | 'cwd-derived'
  /** Nothing but backslashes: `rm -rf \`. */
  | 'backslash-only'

export interface DangerousRm {
  kind: DangerousRmKind
  /** The offending target, with its surrounding quotes stripped. */
  target: string
}

/**
 * Variables whose value is the directory the shell is in.
 *
 * The danger is not an unknown value — it is that the value is *movable*: an
 * earlier segment of the same command line (`cd /tmp && …`) decides it, so the
 * target is anchored to whatever directory the command happens to reach.
 */
const CWD_VARS = new Set(['PWD', 'OLDPWD'])

/**
 * Directory names that sit at the filesystem root.
 *
 * These are what make an empty variable dangerous. If `$VAR` is unset, the shell
 * drops it and `rm -rf $VAR/usr` runs as `rm -rf /usr` — the variable does not
 * fail loudly, it *disappears*, and what is left behind is an absolute path to a
 * system directory. `$VAR/node_modules` collapsing to `/node_modules` is not in
 * that class, so the directory name is what decides, not the variable.
 */
const TOP_LEVEL_DIRS = new Set([
  'bin',
  'boot',
  'dev',
  'etc',
  'home',
  'lib',
  'lib64',
  'opt',
  'proc',
  'root',
  'run',
  'sbin',
  'srv',
  'sys',
  'tmp',
  'usr',
  'var',
])

/** Strip one layer of matching quotes — `"$(pwd)"` and `$(pwd)` are one target. */
function stripQuotes(s: string): string {
  if (s.length < 2) return s
  const first = s[0]
  const last = s[s.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) return s.slice(1, -1)
  return s
}

/**
 * Split an argument region into operands, keeping a quoted run or a `$(…)`
 * substitution whole.
 *
 * Plain whitespace splitting is not enough here, and it fails in the direction
 * that matters: `rm -rf "$(git rev-parse --show-toplevel)"` tokenizes to
 * `['"$(git', 'rev-parse', '--show-toplevel)"']`, so the target never reads as a
 * substitution at all. The cases this guard exists to catch are exactly the ones
 * that contain spaces.
 */
function splitOperands(args: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  let depth = 0

  for (let i = 0; i < args.length; i++) {
    const ch = args[i]!

    if (quote) {
      cur += ch
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      cur += ch
      continue
    }
    if (ch === '$' && args[i + 1] === '(') {
      depth++
      cur += '$('
      i++
      continue
    }
    if (depth > 0) {
      if (ch === ')') depth--
      cur += ch
      continue
    }
    if (/\s/.test(ch)) {
      if (cur) out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }

  if (cur) out.push(cur)
  return out
}

/**
 * True for an `rm` invocation carrying a recursive flag.
 *
 * Force (`-f`) is deliberately not required: `rm -r "$(pwd)"` deletes just as
 * much as `rm -rf "$(pwd)"` and asks fewer questions on the way in.
 */
function isRecursiveRm(tokens: string[]): boolean {
  if (tokens[0] !== 'rm') return false
  return tokens.slice(1).some((t) => {
    if (t === '--recursive') return true
    // A combined cluster (`-rf`, `-fr`, `-r`). A `--flag` long form is not one.
    return /^-[A-Za-z]+$/.test(t) && t.includes('r')
  })
}

/** Which enumerated shape (if any) this target has. */
function classifyTarget(raw: string): DangerousRmKind | null {
  const target = stripQuotes(raw)

  if (/^\\+$/.test(target)) return 'backslash-only'

  // Led by command-substitution output. A substitution *anywhere* in the target
  // is not enough to judge, but a target that starts with one is anchored to a
  // value decided at run time — including the prefix form, where the suffix only
  // narrows an unknown directory to a named entry inside it.
  const sub = target.match(/^(\$\([^)]*\)|`[^`]*`)(\/.*)?$/)
  if (sub) return 'substitution'

  const m = target.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(\/\S*)?$/)
  if (!m) return null
  const name = m[1]!
  const rest = m[2]
  if (CWD_VARS.has(name)) return 'cwd-derived'

  // A variable followed by exactly one more segment, and that segment is a
  // filesystem-root directory name. Deeper paths are a named subdirectory, which
  // is the ordinary case this must not refuse.
  if (rest) {
    const segments = rest.split('/').filter(Boolean)
    if (segments.length === 1 && TOP_LEVEL_DIRS.has(segments[0]!)) return 'variable-top-level'
  }
  return null
}

/** Return the first unbounded recursive-`rm` target in `command`, or `null`. */
export function detectDangerousRm(command: string): DangerousRm | null {
  for (const segment of flattenCommand(command)) {
    const tokens = splitOperands(segment)
    if (!isRecursiveRm(tokens)) continue
    for (const token of tokens.slice(1)) {
      if (token.startsWith('-')) continue
      const kind = classifyTarget(token)
      if (kind) return { kind, target: stripQuotes(token) }
    }
  }
  return null
}
