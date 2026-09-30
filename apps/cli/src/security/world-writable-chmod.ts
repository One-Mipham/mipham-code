/**
 * Recursive `chmod` that grants world-write to a target the command does not
 * bound.
 *
 * `chmod -R 777 ./dist` names where the write lands. `chmod -R 777 $DIR` does
 * not — the target is produced at run time, so nothing that reasons *about* the
 * command can say how far the grant reaches. Same argument as `dangerous-rm`:
 * the text is exactly what is missing, so a second opinion reading the same text
 * is reading the same gap.
 *
 * ## Why this is decided structurally rather than by the classifier
 *
 * This is the call shape the `auto` gate was measured getting wrong most often.
 * Over 5 samples each, same machine and minute, the reasoning model allowed
 * `chmod -R 777 /tmp/shared` 1/5 and the fast model 4/5 — the widest swing in the
 * set (2026-09-30). Neither model is being asked a hard question; they are being
 * asked a question with no rule behind it ("Irreversible Local Destruction" is
 * about deleting, "Shared Infrastructure" is about deploys), so the answer is a
 * coin flip. Both halves of the real question are decidable:
 *
 * - the **grant** is in the mode token (`777`, `o+w`, `a=rwx`), and
 * - the **bound** is in the target.
 *
 * ## Scope — what this deliberately does not cover
 *
 * Recursion is required. Plain `chmod 777 <path>` is ordinary permission work,
 * and where its target is absolute the Bash tool's own `BLOCKED_PATTERNS`
 * already refuses it. Widening to the non-recursive forms would refuse routine
 * work for no measured gain.
 *
 * A *bounded* relative target is left to the classifier on purpose: `chmod -R
 * 777 ./dist` is untidy, not unbounded, and refusing it would be the false
 * denial that makes an operator turn this mode off.
 *
 * Judged on every command line inside the input, via the same `flattenCommand`
 * the deny rules use: reading one normalisation while those read another is how
 * a guard fires on one spelling and not on its twin.
 */

import { flattenCommand } from '../core/permission-rules'

export type WorldWritableChmodKind =
  /** The target is an absolute path: `chmod -R 777 /tmp/shared`. */
  | 'absolute'
  /** The target is anchored to the home directory: `chmod -R 777 ~/shared`. */
  | 'home'
  /** The target is a shell variable: `chmod -R 777 $DIR`. */
  | 'variable'
  /** The target is led by command-substitution output: `chmod -R 777 "$(pwd)"`. */
  | 'substitution'
  /** The target climbs out of the directory the command runs in: `chmod -R 777 ../shared`. */
  | 'parent'

export interface WorldWritableChmod {
  kind: WorldWritableChmodKind
  /** The offending target, with its surrounding quotes stripped. */
  target: string
}

/** Strip one layer of matching quotes — `"$(pwd)"` and `$(pwd)` are one target. */
function stripQuotes(s: string): string {
  if (s.length < 2) return s
  const first = s[0]
  const last = s[s.length - 1]
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) return s.slice(1, -1)
  return s
}

/**
 * Split a command segment into operands, keeping a quoted run or a `$(…)`
 * substitution whole.
 *
 * Plain whitespace splitting fails in the direction that matters:
 * `chmod -R 777 "$(git rev-parse --show-toplevel)"` tokenises to `['"$(git', …]`,
 * so the target never reads as a substitution at all, and the cases this guard
 * exists to catch are exactly the ones containing spaces.
 */
function splitOperands(segment: string): string[] {
  const out: string[] = []
  const re = /"(?:[^"\\]|\\.)*"|'[^']*'|\$\([^)]*\)|`[^`]*`|\S+/g
  let match: RegExpExecArray | null
  while ((match = re.exec(segment)) !== null) out.push(match[0])
  return out
}

/**
 * True for a `chmod` invocation carrying a recursive flag.
 *
 * `-R` is the recursive one; lowercase `-r` is not (for `chmod` it removes read
 * permission). A combined cluster (`-Rv`) counts, and so does `--recursive`; a
 * bare `--` is an end-of-options separator, not a flag in this sense.
 */
function isRecursiveChmod(tokens: string[]): boolean {
  if (tokens[0] !== 'chmod') return false
  return tokens.slice(1).some((t) => {
    if (t === '--recursive') return true
    return /^-[A-Za-z]+$/.test(t) && t.includes('R')
  })
}

/**
 * True when the mode token grants write permission to "other" (or to all).
 *
 * Octal is judged by its last digit — the "other" triad — so `777`, `776` and
 * `707` all count and `755` and `775` do not. Symbolic clauses are judged by
 * their *operator*: `o+w` and `o=rwx` grant, while `o-w` and `go-w` take away,
 * and `u+w` is nobody's business. A clause with no who-part (`+w`) means all.
 */
function grantsWorldWrite(mode: string): boolean {
  if (/^[0-7]{3,4}$/.test(mode)) {
    return '2367'.includes(mode[mode.length - 1]!)
  }
  for (const clause of mode.split(',')) {
    const parsed = /^([ugoa]*)((?:[+-=][rwxXst]*)+)$/.exec(clause)
    if (!parsed) continue
    const who = parsed[1]!
    if (who !== '' && !/[oa]/.test(who)) continue
    for (const op of parsed[2]!.match(/[+-=][rwxXst]*/g) ?? []) {
      if ((op[0] === '+' || op[0] === '=') && op.includes('w')) return true
    }
  }
  return false
}

/**
 * Which unbounded shape (if any) this target has.
 *
 * Anything else is a relative path that names its own landing place, which is
 * the ordinary case this must not refuse.
 */
function classifyTarget(raw: string): WorldWritableChmodKind | null {
  const target = stripQuotes(raw)
  if (target.startsWith('$(') || target.startsWith('`')) return 'substitution'
  if (target.startsWith('$')) return 'variable'
  if (target.startsWith('~')) return 'home'
  if (target.startsWith('/')) return 'absolute'
  if (target === '..' || target.startsWith('../')) return 'parent'
  return null
}

/** Return the first unbounded recursive-world-writable `chmod` target, or `null`. */
export function detectWorldWritableChmod(command: string): WorldWritableChmod | null {
  for (const segment of flattenCommand(command)) {
    const tokens = splitOperands(segment)
    if (!isRecursiveChmod(tokens)) continue
    // Flags may sit on either side of the mode, so both are read off the
    // non-flag operands: the first is the mode, the rest are targets.
    const operands = tokens.slice(1).filter((t) => !t.startsWith('-'))
    const mode = operands[0]
    if (!mode || !grantsWorldWrite(mode)) continue
    for (const raw of operands.slice(1)) {
      const kind = classifyTarget(raw)
      if (kind) return { kind, target: stripQuotes(raw) }
    }
  }
  return null
}
