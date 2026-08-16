/**
 * CLI argument validation for the `mipham` entry point.
 *
 * After every known subcommand (`update`, `daemon`, `attach`, ...) has been
 * dispatched, any remaining argument is a likely typo. This module classifies
 * a leftover argument as an unknown command (positional) or unknown option
 * (leading `-`/`--`) and suggests the closest known alternative via
 * Levenshtein distance, instead of silently launching the interactive CLI.
 */

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

const KNOWN_FLAGS = ['--version', '-v', '-V', '--help', '-h', '--dump-config', '--safe-mode']

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
  const firstArg = args.find((a) => !a.startsWith('-'))
  if (firstArg && !KNOWN_COMMANDS.includes(firstArg)) {
    return { kind: 'command', arg: firstArg, suggestions: closest(firstArg, KNOWN_COMMANDS) }
  }

  const unknownFlag = args.find((a) => a.startsWith('-') && !KNOWN_FLAGS.includes(a))
  if (unknownFlag) {
    return { kind: 'option', arg: unknownFlag, suggestions: closest(unknownFlag, KNOWN_FLAGS) }
  }

  return null
}
