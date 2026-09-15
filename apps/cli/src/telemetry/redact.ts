import { createHash } from 'node:crypto'
import { homedir } from 'node:os'

/**
 * Redaction for crash reports.
 *
 * Nothing in this module is reusable from the existing scrubbers: the four
 * families in the repo (`credential-masker/`, `security/gate.ts`,
 * `shared/sanitize.ts`, `skills/sanitizer.ts`) all match *credential shapes* —
 * token prefixes, JWTs, `sk-ant-…`. None of them removes a user name out of a
 * path. The only home→`~` helper is `ui/chat.tsx` `displayCwd()`, which is
 * unexported, has zero call sites, and only ever looks at `process.cwd()` — it
 * cannot touch a path inside an error object or a stack frame.
 *
 * So the guarantee below has to be carried by tests, not by reuse.
 */

/** Frames kept by default. `Error.stackTraceLimit` is 10; we allow headroom. */
export const MAX_STACK_FRAMES = 15

/** Marker substituted for the working directory — hides the project name. */
const CWD_MARKER = '<cwd>'

/** Marker substituted for the home directory. */
const HOME_MARKER = '~'

/**
 * Marker substituted for the first directory segment under home.
 *
 * Home replacement alone still discloses the user's own naming: a frame in
 * `~/acme-secret-merger-2026/src/a.ts` would render as exactly that. The
 * data dictionary promises no project names, so the segment right after `~` is
 * collapsed too. Structure and the frame's own file name survive — which is
 * what makes a frame useful — but the user's label for a directory does not.
 */
const DIR_MARKER = '<dir>'

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Replace absolute home/cwd paths with their markers, anywhere in the string.
 *
 * Order matters and is not arbitrary: cwd is normally *inside* home, so
 * replacing home first would leave `~/proj/src/a.ts` — which leaks the project
 * directory name. Replacing cwd first yields `<cwd>/src/a.ts`, which does not.
 * This ordering is asserted by a test.
 *
 * Paths that are neither under cwd nor under home are left alone. Those are
 * system/package locations (e.g. `/usr/local/lib/node_modules/…`) that contain
 * no user data, and keeping them is what makes a frame useful for debugging.
 */
export function redactText(input: string, cwd?: string): string {
  let out = input

  if (cwd && cwd.length > 1) {
    out = out.replace(new RegExp(escapeRegExp(cwd), 'g'), CWD_MARKER)
  }

  let home = ''
  try {
    home = homedir()
  } catch {
    /* homedir() can throw when neither HOME nor the passwd entry resolves */
  }
  if (home && home.length > 1) {
    out = out.replace(new RegExp(escapeRegExp(home), 'g'), HOME_MARKER)
  }

  // Collapse the first segment after `~` (both separators — Windows stacks use
  // backslashes) so a user-chosen directory name is not disclosed. The matched
  // separator is echoed back rather than normalised, so a Windows path does not
  // come out with mixed separators.
  out = out.replace(
    /~([\\/])[^\\/\s:)]+/g,
    (_match, sep: string) => `${HOME_MARKER}${sep}${DIR_MARKER}`,
  )

  return out
}

export interface RedactedStack {
  /** Redacted frame lines, truncated to `maxFrames`. */
  frames: string[]
  /** Frame count *before* truncation — truncation loses data, this bounds the loss. */
  frameCount: number
}

/**
 * Extract and redact the frame lines of a V8 stack.
 *
 * The first line of a stack is `"TypeError: <message>"` — it is dropped
 * outright, never redacted, because the message routinely embeds paths and user
 * data. `crash.ts` sends only `hashMessage(error.message)` instead.
 */
export function redactStack(
  stack: string,
  opts: { cwd?: string; maxFrames?: number } = {},
): RedactedStack {
  const { cwd = process.cwd(), maxFrames = MAX_STACK_FRAMES } = opts

  const frameLines = stack.split('\n').filter((line) => /^\s*at\s/.test(line))
  const redacted = frameLines.map((line) => redactText(line.trim(), cwd))

  return {
    frames: redacted.slice(0, maxFrames),
    frameCount: frameLines.length,
  }
}

/**
 * sha256 of the error message, first 16 hex chars.
 *
 * Only the digest is reportable. The plaintext message is not — same reason the
 * stack's first line is dropped.
 */
export function hashMessage(message: string): string {
  return createHash('sha256').update(message).digest('hex').slice(0, 16)
}

/** Runtime tag for the session payload, e.g. `bun@1.2` / `node@22`. */
export function runtimeTag(): string {
  const versions = process.versions as Record<string, string | undefined>
  if (versions.bun) return `bun@${versions.bun}`
  return `node@${(versions.node ?? '0').split('.')[0]}`
}
