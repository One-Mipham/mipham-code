import type { ContextManager } from './context'
import type { CompactionProgressTracker } from './compaction-progress'

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
 * Returns drain result with progress summary.
 */
export interface DrainResult {
  /** Whether recovery was possible */
  recovered: boolean
  /** Messages before drain */
  beforeCount: number
  /** Messages after drain */
  afterCount: number
  /** Current drain level */
  level: number
  /** Human-readable summary */
  summary: string
}

export async function emergencyDrain(
  context: ContextManager,
  progress?: CompactionProgressTracker,
): Promise<DrainResult> {
  const messages = context.getMessages()

  if (messages.length <= MINIMAL_KEEP) {
    return {
      recovered: false,
      beforeCount: messages.length,
      afterCount: messages.length,
      level: drainLevel,
      summary: `Cannot drain further: already at minimal ${messages.length} messages.`,
    }
  }

  progress?.update({
    phase: 'emergency-drain',
    message: `Emergency drain level ${drainLevel + 1}: recovering from 413 error...`,
    percent: 50,
  })

  if (drainLevel === 0) {
    // First attempt: drop earliest 50%
    const keepCount = Math.max(MINIMAL_KEEP, Math.floor(messages.length / 2))
    const kept = messages.slice(-keepCount)
    context.replaceMessages(kept)
    drainLevel++
    progress?.update({
      phase: 'emergency-drain',
      message: `Drain level 1: dropped ${messages.length - keepCount} messages (${messages.length} → ${keepCount})`,
      percent: 80,
      messagesAfter: keepCount,
    })
    return {
      recovered: true,
      beforeCount: messages.length,
      afterCount: keepCount,
      level: drainLevel,
      summary: `Emergency drain level 1: ${messages.length} → ${keepCount} messages (dropped earliest 50%).`,
    }
  }

  // Subsequent attempts: keep only system + last MINIMAL_KEEP messages
  const kept = messages.slice(-MINIMAL_KEEP)

  // Add a summary placeholder if we're dropping a lot
  if (messages.length > MINIMAL_KEEP * 2) {
    const summaryMsg = {
      role: 'user' as const,
      content: `[Emergency context drain level ${drainLevel + 1}: ${messages.length - MINIMAL_KEEP} earlier messages discarded due to token limit.]`,
    }
    context.replaceMessages([summaryMsg, ...kept])
  } else {
    context.replaceMessages(kept)
  }

  drainLevel++
  progress?.update({
    phase: 'emergency-drain',
    message: `Drain level ${drainLevel}: ${messages.length} → ${kept.length} messages`,
    percent: 90,
    messagesAfter: kept.length,
  })

  return {
    recovered: true,
    beforeCount: messages.length,
    afterCount: kept.length,
    level: drainLevel,
    summary: `Emergency drain level ${drainLevel}: ${messages.length} → ${kept.length} messages.`,
  }
}

/** Reset drain level (call at session start). */
export function resetDrainLevel(): void {
  drainLevel = 0
}

/** Get current drain level for display. */
export function getDrainLevel(): number {
  return drainLevel
}
