import { randomUUID } from 'node:crypto'
import { PACKAGE_VERSION } from '../shared/package-info'
import type { QueuedEvent } from './queue'
import { hashMessage, redactStack, runtimeTag } from './redact'
import { SCHEMA_VERSION } from './payload'

/**
 * Crash capture.
 *
 * Installing `uncaughtException` / `unhandledRejection` listeners is a
 * **dangerous act**, not a bookkeeping one: once a listener exists, Node no
 * longer applies its own default handling. The default is "print the error,
 * exit 1". A handler that merely records the error would therefore turn every
 * crash into a **silent hang** — the process keeps running with a broken
 * state and no diagnostic.
 *
 * So the contract enforced below, and locked by tests, is:
 *   1. write the original stack to stderr — the user must still see the crash;
 *   2. record a redacted copy for the payload;
 *   3. terminate with a non-zero code, so exit paths (`process.on('exit')`)
 *      run and the session is reported as crashed.
 *
 * There were no such listeners anywhere in the repo before this module.
 */

export type CrashOrigin = 'uncaughtException' | 'unhandledRejection' | 'render'

export interface CrashRecord {
  errorName: string
  messageHash: string
  stackFrames: string[]
  frameCount: number
  origin: CrashOrigin
  occurredAt: string
}

/** Sinks, injected so tests can observe termination without killing the runner. */
export interface CrashSinks {
  writeStderr: (text: string) => void
  exit: (code: number) => void
}

const defaultSinks: CrashSinks = {
  writeStderr: (text) => {
    process.stderr.write(text)
  },
  exit: (code) => {
    process.exit(code)
  },
}

let lastCrash: CrashRecord | null = null
let installed = false

/**
 * Our own listeners, kept by reference.
 *
 * `resetCrashState` must remove exactly these — `removeAllListeners` would also
 * tear out the test runner's own handlers, which is how a test seam turns into
 * a silent loss of crash reporting everywhere else.
 */
let onUncaught: ((err: unknown) => void) | null = null
let onRejection: ((reason: unknown) => void) | null = null

/** Normalise anything thrown into an Error, without ever throwing itself. */
function toError(thrown: unknown): Error {
  if (thrown instanceof Error) return thrown
  if (typeof thrown === 'string') return new Error(thrown)
  try {
    return new Error(JSON.stringify(thrown))
  } catch {
    return new Error(String(thrown))
  }
}

/**
 * Record a crash without terminating.
 *
 * Split out from `handleFatal` for the one caller that must survive the error:
 * React's error boundary catches a render failure and keeps the app running, so
 * there is nothing to terminate. Failures here are swallowed — a diagnostic
 * must never be more fragile than the code it is diagnosing.
 */
export function recordCrash(thrown: unknown, origin: CrashOrigin, now: Date = new Date()): void {
  try {
    const error = toError(thrown)
    const { frames, frameCount } = redactStack(error.stack ?? '')
    lastCrash = {
      errorName: error.name,
      messageHash: hashMessage(error.message),
      stackFrames: frames,
      frameCount,
      origin,
      occurredAt: now.toISOString(),
    }
  } catch {
    /* capture is best-effort */
  }
}

/**
 * Record and terminate. Exported so the test can drive it directly — a test
 * that had to trigger a real uncaught exception would take the runner down
 * with it.
 */
export function handleFatal(
  thrown: unknown,
  origin: CrashOrigin,
  sinks: CrashSinks = defaultSinks,
  now: Date = new Date(),
): void {
  const error = toError(thrown)

  // 1. Preserve the observable default behaviour: the user sees the crash.
  //    Written verbatim — this goes to the user's terminal, not the wire.
  try {
    sinks.writeStderr(`\n${error.stack ?? `${error.name}: ${error.message}`}\n`)
  } catch {
    /* a broken stderr must not block termination */
  }

  // 2. Record the redacted copy that may leave the machine.
  recordCrash(error, origin, now)

  // 3. Terminate. Never fall through — that is the silent-hang bug.
  sinks.exit(1)
}

/**
 * Install the listeners once. Idempotent: a second call is a no-op, so a
 * double `initTelemetry()` cannot stack two handlers that each call `exit`.
 */
export function installCrashHandlers(sinks: CrashSinks = defaultSinks): void {
  if (installed) return
  installed = true

  onUncaught = (err: unknown) => handleFatal(err, 'uncaughtException', sinks)
  onRejection = (reason: unknown) => handleFatal(reason, 'unhandledRejection', sinks)

  process.on('uncaughtException', onUncaught)
  process.on('unhandledRejection', onRejection)
}

/** Whether this session crashed — reported in the session payload. */
export function hasCrashed(): boolean {
  return lastCrash !== null
}

export function getLastCrash(): CrashRecord | null {
  return lastCrash
}

/** Test seam: clear recorded state and allow re-installation. */
export function resetCrashState(): void {
  lastCrash = null
  installed = false
  if (onUncaught) process.off('uncaughtException', onUncaught)
  if (onRejection) process.off('unhandledRejection', onRejection)
  onUncaught = null
  onRejection = null
}

/**
 * The `crash` event. Holds a message *digest*, never the message text: error
 * messages routinely embed paths and user data.
 */
export function buildCrashEvent(installId: string): QueuedEvent | null {
  if (!lastCrash) return null
  return {
    id: randomUUID(),
    kind: 'crash',
    payload: {
      installId,
      schemaVersion: SCHEMA_VERSION,
      occurredAt: lastCrash.occurredAt,
      appVersion: PACKAGE_VERSION,
      runtime: runtimeTag(),
      platform: `${process.platform}/${process.arch}`,
      errorName: lastCrash.errorName,
      messageHash: lastCrash.messageHash,
      stackFrames: lastCrash.stackFrames,
      frameCount: lastCrash.frameCount,
      origin: lastCrash.origin,
    },
  }
}
