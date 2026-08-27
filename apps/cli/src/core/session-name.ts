/**
 * Generate the session name (ID) used for cross-session tracking, inbox routing,
 * and session persistence.
 *
 * Includes milliseconds so two sessions launched in the same second do not
 * collide on the shared inbox directory / active-session registry. (2026-08-27
 * review: the old `slice(0, 19)` dropped ms and let same-second launches share
 * one inbox, leaking / misdelivering cross-session messages.)
 */
export function generateSessionName(resume: string | undefined, now: Date = new Date()): string {
  return resume || `session-${now.toISOString().replace(/[:.]/g, '-')}`
}
