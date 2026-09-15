import { randomUUID } from 'node:crypto'
import { getMetrics } from '../core/metrics'
import { resolveTelemetry, getOrCreateInstallId, type TelemetryConsent } from './consent'
import { enqueueSync } from './queue'
import { buildSessionEvent } from './payload'
import { buildCrashEvent, hasCrashed, installCrashHandlers } from './crash'
import { flushQueueInBackground } from './transport'

/**
 * Telemetry facade.
 *
 * Data flow — collecting and sending are deliberately decoupled, because
 * `process.on('exit')` cannot await async work:
 *
 *   during a session   counters accumulate in memory (`getMetrics()`); zero I/O
 *   at exit            synchronous: whitelist snapshot + session metadata → queue
 *   next startup       async, fire-and-forget: drain queue → POST → ack or keep
 *
 * Nothing here is a parallel counting system. `getMetrics()` already exists and
 * is the single source for what actually got used; telemetry only *reads* it,
 * and only for the whitelisted families (`payload.ts`).
 */

interface TelemetryState {
  consent: TelemetryConsent
  installId: string
  startedAt: number
  /** Guards against a double flush when both SIGINT and a normal exit fire. */
  flushed: boolean
}

let state: TelemetryState | null = null

/**
 * The exit flush, kept by reference so `resetTelemetryState` can remove
 * exactly this one — `removeAllListeners('exit')` would detach the runner's
 * own teardown and every other exit path in the process.
 */
let onExit: (() => void) | null = null

/**
 * Start telemetry for this process.
 *
 * Safe to call once at startup. Returns the resolved consent so callers (and
 * `/telemetry status`) can report why telemetry is on or off.
 */
export function initTelemetry(cwd: string = process.cwd()): TelemetryConsent {
  const consent = resolveTelemetry(cwd)
  const installId = consent.enabled ? getOrCreateInstallId(cwd) : ''

  state = { consent, installId, startedAt: Date.now(), flushed: false }

  // Crash capture is installed unconditionally, even when telemetry is off:
  // it is what keeps a crash from becoming a silent hang. When telemetry is
  // off the record is simply never uploaded.
  installCrashHandlers()

  // Likewise unconditional. The flush has to be registered while telemetry is
  // still off, because the user can turn it on mid-session (`/telemetry on` →
  // `enableTelemetryNow`) and that session must still be reported. Registering
  // it here rather than in the TUI's own `process.on('exit')` also means the
  // remote-attach and non-interactive paths are covered, not just the one that
  // reaches the TUI setup.
  if (!onExit) {
    onExit = () => shutdownTelemetry()
    process.on('exit', onExit)
  }

  if (consent.enabled) flushQueueInBackground(consent.endpoint)

  return consent
}

/**
 * Record a slash-command invocation.
 *
 * Unconditional, like every other counter in the registry — `getMetrics()` is
 * a metrics registry used by the artifact server too, not a telemetry buffer.
 * Whether the snapshot ever leaves the machine is decided at exit.
 */
export function recordCommand(name: string): void {
  getMetrics().commandCalls.inc({ command_name: name })
}

/** Record a tool invocation that bypassed the engine's `executeTool` funnel. */
export function recordToolCall(name: string): void {
  getMetrics().toolCalls.inc({ tool_name: name })
}

export function isTelemetryEnabled(): boolean {
  return state?.consent.enabled === true
}

export function getTelemetryConsent(): TelemetryConsent | null {
  return state?.consent ?? null
}

/**
 * Form and queue the session payload. **Synchronous by requirement** — this is
 * called from inside `process.on('exit')`, where an await would never settle.
 *
 * A no-op when telemetry is off, which is what makes "off" mean no collection,
 * no queue file, and no network.
 */
export function shutdownTelemetry(now: Date = new Date()): void {
  const current = state
  if (!current || current.flushed) return
  current.flushed = true
  if (!current.consent.enabled) return

  try {
    if (hasCrashed()) {
      const crash = buildCrashEvent(current.installId)
      if (crash) enqueueSync(crash)
    }
    enqueueSync(
      buildSessionEvent({
        installId: current.installId,
        startedAt: current.startedAt,
        endedAt: now.getTime(),
        crashed: hasCrashed(),
      }),
    )
  } catch {
    // A telemetry write must never break the exit path.
  }
}

/** Test seam: drop facade state and unhook the exit flush. */
export function resetTelemetryState(): void {
  state = null
  if (onExit) process.off('exit', onExit)
  onExit = null
}

/**
 * Persist the user's answer and start reporting immediately, so `/telemetry on`
 * takes effect in the running session rather than at the next launch.
 */
export function enableTelemetryNow(cwd: string = process.cwd()): void {
  const consent = resolveTelemetry(cwd)
  state = {
    consent,
    installId: getOrCreateInstallId(cwd),
    startedAt: state?.startedAt ?? Date.now(),
    flushed: false,
  }
}

/** A fresh anonymous id, for `/telemetry reset-id`. */
export function newInstallId(): string {
  return randomUUID()
}
