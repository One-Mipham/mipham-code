import type { ToolDefinition } from '../../shared/index.ts'

/**
 * Active wakeup timers — in-memory, per-session.
 * Key: "sessionId:wakeup"
 */
const activeTimers = new Map<string, ReturnType<typeof setTimeout>>()

export const scheduleWakeupTool: ToolDefinition = {
  name: 'ScheduleWakeup',
  description:
    'Schedule when to resume work in /loop dynamic mode — the user invoked /loop without an interval, asking you to self-pace iterations of a specific task. Do NOT schedule a short-interval wakeup to poll for background work you started — when harness-tracked work finishes, you are re-invoked automatically. The runtime clamps to [60, 3600].',
  category: 'scheduling',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      delaySeconds: {
        type: 'number',
        description: 'Seconds from now to wake up. Clamped to [60, 3600] by the runtime.',
      },
      reason: {
        type: 'string',
        description: 'One short sentence explaining the chosen delay.',
      },
      prompt: {
        type: 'string',
        description: 'The /loop input to fire on wake-up.',
      },
      stop: {
        type: 'boolean',
        description: 'Set to true to end the dynamic loop immediately.',
      },
    },
    required: [],
  },

  async execute(params, ctx) {
    const sessionId = ctx.sessionId

    // ── Stop — cancel all timers for this session ──
    if (params.stop === true) {
      let cancelled = 0
      for (const [key, timer] of activeTimers) {
        if (key.startsWith(sessionId + ':')) {
          clearTimeout(timer)
          activeTimers.delete(key)
          cancelled++
        }
      }
      return {
        success: true,
        content: `Loop ended. ${cancelled} pending wakeup(s) cancelled.`,
      }
    }

    // ── Schedule — validate and register timer ──
    const delaySeconds = params.delaySeconds as number
    const prompt = (params.prompt as string) || ''
    const reason = (params.reason as string) || 'scheduled wakeup'

    if (!delaySeconds || typeof delaySeconds !== 'number') {
      return {
        success: false,
        content: '',
        error: 'delaySeconds is required and must be a number in [60, 3600].',
      }
    }

    if (delaySeconds < 60 || delaySeconds > 3600) {
      return {
        success: false,
        content: '',
        error: `delaySeconds must be in [60, 3600], got ${delaySeconds}.`,
      }
    }

    // Cancel any previous timer for this session (one active wakeup per session)
    for (const [key, timer] of activeTimers) {
      if (key.startsWith(sessionId + ':')) {
        clearTimeout(timer)
        activeTimers.delete(key)
      }
    }

    const timerKey = `${sessionId}:wakeup`
    const timeoutId = setTimeout(() => {
      activeTimers.delete(timerKey)
    }, delaySeconds * 1000)

    activeTimers.set(timerKey, timeoutId)

    const mins = Math.floor(delaySeconds / 60)
    const secs = delaySeconds % 60
    const humanDelay = mins > 0 ? `${mins}m${secs > 0 ? `${secs}s` : ''}` : `${secs}s`

    return {
      success: true,
      content:
        `⏰ Wakeup scheduled in ${humanDelay} (${reason})\n` +
        `Prompt: "${prompt.slice(0, 100)}${prompt.length > 100 ? '...' : ''}"`,
    }
  },
}

/** Cancel all timers for a session. Called on session cleanup. */
export function cancelAllSessionTimers(sessionId: string): number {
  let count = 0
  for (const [key, timer] of activeTimers) {
    if (key.startsWith(sessionId + ':')) {
      clearTimeout(timer)
      activeTimers.delete(key)
      count++
    }
  }
  return count
}
