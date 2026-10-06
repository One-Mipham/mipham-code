import { mkdirSync, readFileSync, unlinkSync, readdirSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { ToolDefinition } from '../../shared/index.ts'
import { atomicWriteFileSync } from '../../shared/atomic-write'
import { miphamHome } from '../../core/paths.ts'

/**
 * Active wakeup timers — in-memory, per-session.
 * Key: "sessionId:wakeup"
 */
const activeTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Where pending wakeups are written — one file per session.
 *
 * A `setTimeout` cannot fire into a process that is not running, and here that is
 * not hypothetical: the daemon recycles an idle worker after 30 minutes
 * (`daemon/worker-pool.ts`) while a wakeup may be up to 3600s out. So the *intent*
 * is written here and the timer is rebuilt from it on the next start — a wakeup
 * still in the future is restored exactly, and one that came due while we were gone
 * is handed back to the model instead of vanishing (`resumeWakeups`).
 */
const WAKEUP_DIR = miphamHome('wakeups')

let wakeupHandler: ((sessionId: string, prompt: string, noop?: boolean) => void) | null = null

/** 引擎在启动时注入——timer 到期后回调，把 loop prompt 交回引擎 re-invoke。 */
export function registerWakeupHandler(
  fn: (sessionId: string, prompt: string, noop?: boolean) => void,
): void {
  wakeupHandler = fn
}

/** One session's pending wakeup, as written to disk. */
export interface PersistedWakeup {
  sessionId: string
  prompt: string
  noop: boolean
  reason: string
  /** When the timer was due (ISO). */
  firesAt: string
}

/**
 * File name for a session's slot. Hashed, not used literally: the session id is
 * whatever `--resume <id>` was given, i.e. operator input, and a `../` in it must
 * not walk out of this directory.
 */
function wakeupPath(sessionId: string): string {
  const name = createHash('sha256').update(sessionId).digest('hex').slice(0, 32)
  return join(WAKEUP_DIR, `${name}.json`)
}

function persistWakeup(entry: PersistedWakeup): void {
  if (!existsSync(WAKEUP_DIR)) mkdirSync(WAKEUP_DIR, { recursive: true })
  atomicWriteFileSync(wakeupPath(entry.sessionId), JSON.stringify(entry, null, 2), { mode: 0o644 })
}

function clearPersistedWakeup(sessionId: string): void {
  const path = wakeupPath(sessionId)
  try {
    if (existsSync(path)) unlinkSync(path)
  } catch {
    /* a file we cannot remove does not resurrect a timer we already cancelled */
  }
}

/** Every wakeup left on disk, across all sessions. Unreadable files are skipped. */
export function readPersistedWakeups(): PersistedWakeup[] {
  let files: string[]
  try {
    files = readdirSync(WAKEUP_DIR)
  } catch {
    return []
  }
  const out: PersistedWakeup[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(readFileSync(join(WAKEUP_DIR, file), 'utf-8')) as PersistedWakeup
      if (parsed?.sessionId && parsed.firesAt) out.push(parsed)
    } catch {
      /* skip corrupt files */
    }
  }
  return out
}

/**
 * Arm the session's wakeup timer, replacing whatever timer it already had — one
 * active wakeup per session, enforced here so every arming path (the tool, the
 * restart path) obeys it rather than each remembering to cancel first.
 */
function armTimer(sessionId: string, prompt: string, noop: boolean, delayMs: number): void {
  cancelSessionTimers(sessionId)
  const timerKey = `${sessionId}:wakeup`
  const timeoutId = setTimeout(() => {
    activeTimers.delete(timerKey)
    clearPersistedWakeup(sessionId)
    wakeupHandler?.(sessionId, prompt, noop)
  }, delayMs)
  activeTimers.set(timerKey, timeoutId)
}

/** Drop this session's timers (in memory only — the store is the caller's business). */
function cancelSessionTimers(sessionId: string): number {
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

/** A wakeup that came due while no process was running. */
export interface LostWakeup {
  prompt: string
  reason: string
  firesAt: string
}

/**
 * Rebuild this session's pending wakeup after a restart. Returns the ones that
 * came due while we were gone, and re-arms the rest.
 *
 * A due-while-down wakeup is **returned, not fired**. The delay the model picked
 * measured from when it picked it: re-running that prompt blind hours later is not
 * the loop iteration that was asked for. The caller hands it back to the model,
 * which is the only party that can reschedule or stop. What must never happen is
 * the silent drop — the model believing a wakeup is pending while nothing is armed
 * and nothing is on disk.
 */
export function resumeWakeups(opts: { sessionId: string; now?: Date }): LostWakeup[] {
  const now = (opts.now ?? new Date()).getTime()
  const lost: LostWakeup[] = []

  for (const entry of readPersistedWakeups()) {
    if (entry.sessionId !== opts.sessionId) continue
    const due = new Date(entry.firesAt).getTime()
    if (!Number.isFinite(due)) {
      clearPersistedWakeup(entry.sessionId)
      continue
    }
    if (due <= now) {
      clearPersistedWakeup(entry.sessionId)
      lost.push({ prompt: entry.prompt, reason: entry.reason, firesAt: entry.firesAt })
      continue
    }
    armTimer(entry.sessionId, entry.prompt, entry.noop, due - now)
  }

  return lost
}

export const scheduleWakeupTool: ToolDefinition = {
  name: 'ScheduleWakeup',
  description:
    'Schedule when to resume work in /loop dynamic mode — the user invoked /loop without an interval, asking you to self-pace iterations of a specific task. Do NOT schedule a short-interval wakeup to poll for background work you started — when harness-tracked work finishes, you are re-invoked automatically. The runtime clamps to [60, 3600].',
  category: 'scheduling',
  permission: 'self',
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
      noop: {
        type: 'boolean',
        description: 'true = 本轮无事可报（仅用于 UI 折叠空闲提示，不改变 re-invoke 语义）',
      },
    },
    required: [],
  },

  async execute(params, ctx) {
    const sessionId = ctx.sessionId

    // ── Stop — cancel all timers for this session ──
    if (params.stop === true) {
      const cancelled = cancelAllSessionTimers(sessionId)
      return {
        success: true,
        content: `Loop ended. ${cancelled} pending wakeup(s) cancelled.`,
      }
    }

    // ── Schedule — validate and register timer ──
    const delaySeconds = params.delaySeconds as number
    const prompt = (params.prompt as string) || ''
    const reason = (params.reason as string) || 'scheduled wakeup'
    const noop = params.noop === true

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

    // Cancel any previous timer for this session (one active wakeup per session).
    // Write the intent *before* arming: a wakeup that exists only in memory is the
    // one that disappears when the process does.
    persistWakeup({
      sessionId,
      prompt,
      noop,
      reason,
      firesAt: new Date(Date.now() + delaySeconds * 1000).toISOString(),
    })
    armTimer(sessionId, prompt, noop, delaySeconds * 1000)

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

/** Cancel all timers for a session and forget its pending wakeup. Session cleanup. */
export function cancelAllSessionTimers(sessionId: string): number {
  const count = cancelSessionTimers(sessionId)
  clearPersistedWakeup(sessionId)
  return count
}
