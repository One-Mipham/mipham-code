import type { HookContext, HookDefinition, HookResult } from '../shared/index'
import type { HookEngine } from './hooks'
import { splitShellSegments } from './permission-rules'
import { shellWords } from '../tools/exec/bash'

/**
 * The merge gate: a review must run in this session before a pull request is
 * merged.
 *
 * `instructions.ts` has carried this rule as prose ("Code-Review Merge Gate")
 * since the CRSI work, and prose is exactly what failed: a session opened its
 * own PR and squash-merged it without a review, because nothing had an
 * implementation point. This module is that point — a PreToolUse guard on
 * `gh pr merge`, with the review recorded by the tool funnel itself.
 */

/** How long a review counts for the session that ran it. */
export const REVIEW_WINDOW_MS = 24 * 60 * 60 * 1000

/** The operator's one-way out: an unchanged env is the only way to waive the gate. */
export const MERGE_GATE_WAIVER_ENV = 'MIPHAM_SKIP_MERGE_GATE'

/** Skills whose successful run counts as a review of what is about to merge. */
export const REVIEW_SKILLS = new Set(['code-review', 'self-review', 'security-review'])

/** `NAME=value` ahead of a command — assigned to that command, not a command word. */
const LEADING_ASSIGNMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*=/

/**
 * Commands that run another command in turn. `sudo gh pr merge` merges just as
 * much as the bare form, and the guard has to see through the wrapper.
 */
const COMMAND_WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'builtin',
  'exec',
  'nohup',
  'nice',
  'time',
])

/**
 * Does this Bash command run `gh pr merge`?
 *
 * Quote-aware on purpose: `git commit -m "gh pr merge 55"` and
 * `echo "gh pr merge"` mention the command without running it. Segments are
 * split with the permission matcher's splitter (which ignores quoting), so a
 * quoted `&&` can still split a segment — the resulting over-match is the safe
 * direction, same trade the matcher makes.
 */
export function isPrMergeCommand(command: string): boolean {
  for (const segment of splitShellSegments(command)) {
    const words = shellWords(segment)
    let i = 0
    while (
      i < words.length &&
      (LEADING_ASSIGNMENT_RE.test(words[i]!) ||
        COMMAND_WRAPPERS.has(words[i]!) ||
        words[i]!.startsWith('-'))
    ) {
      i++
    }
    if (words[i] !== 'gh') continue
    // `gh` takes global flags before the subcommand (`gh -R owner/repo pr …`),
    // so the subcommand is found by its own name rather than by position.
    const args = words.slice(i + 1)
    const at = args.findIndex((word, n) => word === 'pr' && args[n + 1] === 'merge')
    if (at === -1) continue
    const rest = args.slice(at + 2)
    // `--help` prints usage; it does not merge anything.
    if (rest.includes('--help') || rest.includes('-h')) continue
    return true
  }
  return false
}

/**
 * Which sessions have run a review, and when.
 *
 * Time-bounded rather than cleared on session end: the daemon serves many
 * sessions from one process and has no per-session teardown hook here, so an
 * entry is dropped by age instead. A review is a fact about the last day, not
 * a flag that must be reset.
 */
export class ReviewLedger {
  private reviewed = new Map<string, number>()

  markReviewed(sessionId: string, at: number = Date.now()): void {
    this.prune(at)
    this.reviewed.set(sessionId, at)
  }

  hasReviewed(sessionId: string, now: number = Date.now()): boolean {
    const at = this.reviewed.get(sessionId)
    return at !== undefined && now - at <= REVIEW_WINDOW_MS
  }

  private prune(now: number): void {
    for (const [sessionId, at] of this.reviewed) {
      if (now - at > REVIEW_WINDOW_MS) this.reviewed.delete(sessionId)
    }
  }
}

/**
 * Record a tool outcome for the gate — called from the engine's tool funnel.
 *
 * Only a *successful* review skill counts: a skill that was not found, or whose
 * run failed, reviewed nothing.
 */
export function noteToolOutcome(
  ledger: ReviewLedger,
  sessionId: string,
  toolName: string,
  input: Record<string, unknown>,
  success: boolean,
): void {
  if (!success || toolName !== 'Skill') return
  const skill = input.skill
  if (typeof skill === 'string' && REVIEW_SKILLS.has(skill)) ledger.markReviewed(sessionId)
}

export function createMergeGateHook(ledger: ReviewLedger): HookDefinition {
  return {
    event: 'PreToolUse',
    toolName: 'Bash',
    source: 'builtin:merge-gate',
    // A guard that cannot run must not silently allow the merge.
    failureMode: 'closed',
    async handler(ctx: HookContext): Promise<HookResult> {
      const command = ctx.toolInput?.command
      if (typeof command !== 'string' || !isPrMergeCommand(command)) return { allowed: true }
      if (process.env[MERGE_GATE_WAIVER_ENV] === '1') return { allowed: true }
      if (ledger.hasReviewed(ctx.sessionId)) return { allowed: true }
      return {
        allowed: false,
        reason:
          'This command merges a pull request, and no code review has run in this session. ' +
          'Run /code-review (or the code-review skill) and address its findings before merging. ' +
          `If the review genuinely happened outside this session, restart Mipham Code with ${MERGE_GATE_WAIVER_ENV}=1.`,
      }
    },
  }
}

/** Process-wide ledger — the engine records into it, the gate reads it. */
export const reviewLedger = new ReviewLedger()

/**
 * Install the built-in guards. Both startup paths must call this — the one-shot
 * CLI and the daemon — or the gate exists in only one of them.
 */
export function registerBuiltinHooks(engine: HookEngine): void {
  engine.register(createMergeGateHook(reviewLedger))
}
