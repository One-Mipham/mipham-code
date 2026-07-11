import type { ContextManager } from './context'

const MINIMAL_KEEP = 5
let drainLevel = 0

/**
 * Layer 4: Emergency Drain — 413 error recovery.
 *
 * Called when a 413 (context too large) error is received.
 * Progressively strips messages until the context fits:
 *
 * Level 1: Drop earliest 50% of messages
 * Level 2+: Keep only system prompt + last 5 messages
 *
 * Returns true if recovery was possible, false if context is already minimal.
 */
export async function emergencyDrain(context: ContextManager): Promise<boolean> {
  const messages = context.getMessages()

  if (messages.length <= MINIMAL_KEEP) {
    return false // Already minimal, cannot drain further
  }

  if (drainLevel === 0) {
    // First attempt: drop earliest 50%
    const keepCount = Math.max(MINIMAL_KEEP, Math.floor(messages.length / 2))
    const kept = messages.slice(-keepCount)
    context.replaceMessages(kept)
    drainLevel++
    return true
  }

  // Subsequent attempts: keep only system + last MINIMAL_KEEP messages
  const kept = messages.slice(-MINIMAL_KEEP)

  // Add a summary placeholder if we're dropping a lot
  if (messages.length > MINIMAL_KEEP * 2) {
    const summaryMsg = {
      role: 'user' as const,
      content: `[Emergency context drain: ${messages.length - MINIMAL_KEEP} earlier messages discarded due to token limit.]`,
    }
    context.replaceMessages([summaryMsg, ...kept])
  } else {
    context.replaceMessages(kept)
  }

  drainLevel++
  return true
}

/** Reset drain level (call at session start). */
export function resetDrainLevel(): void {
  drainLevel = 0
}
