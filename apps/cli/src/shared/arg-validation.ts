/**
 * CLI argument validation for the `mipham` entry point.
 *
 * After every known subcommand (`update`, `daemon`, `attach`, ...) has been
 * dispatched, any remaining argument is a likely typo. This module classifies
 * a leftover argument as an unknown command (positional) or unknown option
 * (leading `-`/`--`) and suggests the closest known alternative via
 * Levenshtein distance, instead of silently launching the interactive CLI.
 *
 * It also owns the **value** domain of the one flag whose value is a named thing:
 * `parsePermissionFlag` below. Keeping the flag's spelling and its accepted values in
 * one module is what stops "the flag is known" and "the flag's value is understood"
 * from drifting apart.
 */

import { ALL_MODES } from '../core/permission-config'
import type { PermissionMode } from './types'

export interface UnknownArgument {
  kind: 'command' | 'option'
  arg: string
  suggestions: string[]
}

const KNOWN_COMMANDS = [
  'update',
  'upgrade',
  'plugin',
  'workflow',
  'daemon',
  'attach',
  'agents',
  'agent',
  'goal',
  'schedule',
  'token',
  'help',
]

const KNOWN_FLAGS = [
  '--version',
  '-v',
  '-V',
  '--help',
  '-h',
  '--dump-config',
  '--safe-mode',
  '--resume',
  '--permission',
  '--provider',
  '--model',
]

/**
 * Flags that consume the **next** argument as their value. That value is not a
 * command, so it must not go through the unknown-command check: with
 * `mipham --resume "my session"` the old scan found the first token that didn't
 * start with `-`, concluded the user had typed a command, and reported
 * `Unknown command: mipham my session` — blaming the session name and never
 * mentioning `--resume`, the one argument that was actually wrong.
 *
 * `--permission` is here for the same reason and for one more: `mipham attach <id>
 * --permission plan` reads the session id through `firstPositional`, and without this
 * entry it would have taken `plan` for a session id.
 *
 * `--provider`/`--model` are the same defect a third time, and here it was *measured*
 * rather than reasoned about: both shipped IDE integrations build
 * `mipham --provider <id> --model <id>` from their settings (`infrastructure/vscode/
 * extension.js`, `MiphamAction.kt`), and that command was answered with
 * `Unknown command: mipham deepseek` — the provider *value* blamed, the flag that was
 * actually wrong never mentioned, exit 1, no CLI. Their values are open (a provider may
 * be user-defined), so — unlike `--permission` — this module owns only their spelling.
 */
const VALUE_FLAGS = ['--resume', '--permission', '--provider', '--model']

/**
 * The first token that would be read as a command, skipping flags and the values
 * of value-taking flags. `null` when there is none.
 *
 * Exported for `bin/mipham.ts`'s attach path, which picks its session id the same
 * way: `args[1]` alone is wrong as soon as a value-taking flag comes first.
 */
export function firstPositional(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg.startsWith('-')) {
      if (VALUE_FLAGS.includes(arg)) i++ // its value is not a command
      continue
    }
    return arg
  }
  return null
}

/** Levenshtein edit distance between two strings. */
function levenshtein(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i]![0] = i
  for (let j = 0; j <= n; j++) dp[0]![j] = j
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i]![j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1]![j - 1]!
          : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!)
  return dp[m]![n]!
}

/** Closest candidates within `maxDist` edits, nearest first. */
function closest(target: string, candidates: string[], maxDist = 3): string[] {
  return candidates
    .map((c) => ({ c, dist: levenshtein(target, c) }))
    .filter((x) => x.dist <= maxDist)
    .sort((a, b) => a.dist - b.dist)
    .map((x) => x.c)
}

/**
 * Return the first unknown argument (command or option), or null if all
 * arguments are recognized. Positional commands are checked first so an
 * unknown command keeps its existing message; unknown options (e.g.
 * `--cersion`, a typo of `--version`) are reported when no positional
 * command is present, instead of falling through to the interactive CLI.
 */
export function detectUnknownArgument(args: string[]): UnknownArgument | null {
  const firstArg = firstPositional(args)
  if (firstArg && !KNOWN_COMMANDS.includes(firstArg)) {
    return { kind: 'command', arg: firstArg, suggestions: closest(firstArg, KNOWN_COMMANDS) }
  }

  const unknownFlag = args.find((a) => a.startsWith('-') && !KNOWN_FLAGS.includes(a))
  if (unknownFlag) {
    return { kind: 'option', arg: unknownFlag, suggestions: closest(unknownFlag, KNOWN_FLAGS) }
  }

  return null
}

/**
 * `--permission <mode>` — the mode the session starts in.
 *
 * The accepted set is `ALL_MODES`, i.e. **exactly what the daemon accepts over the
 * wire** (its `set_mode` whitelist, pinned equal by
 * `test/integrity/permission-status-parity.test.ts` P7e). One set, three doors —
 * `config.yml`, this flag, the attach protocol — so a value legal at one door cannot be
 * silently illegal at another. The list itself is never written out here: it is derived
 * from `ALL_MODES` in both the message and `mipham --help`, because a hand-kept copy is
 * what drifts the day a mode is added.
 *
 * Deliberately **not** the legacy three-level spellings (`self`/`ask`/`bypass`) that
 * `setDefaultLevel` still maps. A flag is typed by the person reading its error message,
 * which names the spellings it takes; and `bypass` is a value the daemon rejects, so
 * accepting it here would make the same flag work locally and fail under
 * `mipham attach` — silently, since the daemon's answer is a correction, not an error.
 *
 * An unrecognized value is an **error**, never a fallback to `default`: `default` is
 * *wider* than most of what a user would have meant (`plan`, `acceptEdits`), so falling
 * back is a silent widening — the fail-open shape this file exists to prevent. Same
 * reasoning as bin's `--resume` guard, which refuses an unknown session name rather than
 * quietly starting a fresh one.
 *
 * Space form only (`--permission plan`), like `--resume`. The `=` form is refused **here**
 * rather than left to `detectUnknownArgument`, because `mipham attach` never runs that
 * scan (it returns before it) — without this line `mipham attach <id> --permission=plan`
 * would attach with the flag silently doing nothing, on the one path where nothing else
 * would have caught it.
 */
export function parsePermissionFlag(
  args: string[],
): { kind: 'absent' } | { kind: 'ok'; mode: PermissionMode } | { kind: 'error'; message: string } {
  const eqForm = args.find((a) => a.startsWith('--permission='))
  if (eqForm) {
    return {
      kind: 'error',
      message: `--permission takes its value as a separate argument: mipham --permission <mode> (got "${eqForm}")`,
    }
  }

  const at = args.indexOf('--permission')
  if (at === -1) return { kind: 'absent' }

  const raw = args[at + 1]
  if (!raw || raw.startsWith('-')) {
    return { kind: 'error', message: `Usage: mipham --permission <${ALL_MODES.join('|')}>` }
  }
  if (!ALL_MODES.includes(raw as PermissionMode)) {
    return {
      kind: 'error',
      message: `Unknown permission mode: ${raw}\nValid modes: ${ALL_MODES.join(', ')}`,
    }
  }
  return { kind: 'ok', mode: raw as PermissionMode }
}
