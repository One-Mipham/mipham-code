import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'

// The home has to be in place *before the imports run*, not merely before the
// first test: `config/loader.ts` captures `MIPHAM_HOME` from `homedir()` at
// module scope, so assigning to this ref in the module body would be too late
// and every settings.json lookup would silently miss. `queue.ts` reads
// `homedir()` lazily, which is why only the settings-driven tests notice.
const homeRef = vi.hoisted(() => ({
  value: `${process.env.TMPDIR ?? '/tmp'}/mipham-test-tel-facade-home`,
}))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => homeRef.value }
})

import { tmpdir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resetMetrics, getMetrics } from '../../src/core/metrics'
import { queuePath, readQueue } from '../../src/telemetry/queue'
import { handleFatal, resetCrashState } from '../../src/telemetry/crash'
import {
  initTelemetry,
  shutdownTelemetry,
  recordCommand,
  isTelemetryEnabled,
  resetTelemetryState,
} from '../../src/telemetry/index'

const HOME = homeRef.value
const PROJECT = `${tmpdir()}/mipham-test-tel-facade-project`
const USER_SETTINGS = join(HOME, '.mipham', 'settings.json')

let fetchMock: ReturnType<typeof vi.fn>

function optIn(extra: Record<string, unknown> = {}): void {
  mkdirSync(join(HOME, '.mipham'), { recursive: true })
  writeFileSync(USER_SETTINGS, JSON.stringify({ telemetry: { enabled: true, ...extra } }))
}

beforeEach(() => {
  rmSync(HOME, { recursive: true, force: true })
  rmSync(PROJECT, { recursive: true, force: true })
  mkdirSync(PROJECT, { recursive: true })
  resetMetrics()
  resetTelemetryState()
  resetCrashState()
  fetchMock = vi.fn().mockImplementation(async () => new Response('{}', { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  resetTelemetryState()
  resetCrashState()
  resetMetrics()
  vi.unstubAllGlobals()
  delete process.env.MIPHAM_TELEMETRY
})

afterAll(() => {
  rmSync(HOME, { recursive: true, force: true })
  rmSync(PROJECT, { recursive: true, force: true })
})

describe('telemetry facade — off by default', () => {
  it('sends nothing and writes no queue file before anyone opts in', () => {
    const consent = initTelemetry(PROJECT)
    expect(consent.enabled).toBe(false)
    expect(isTelemetryEnabled()).toBe(false)

    shutdownTelemetry()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(existsSync(queuePath())).toBe(false)
  })

  it('writes no queue file under the hard kill switch', () => {
    optIn()
    process.env.MIPHAM_TELEMETRY = 'off'

    initTelemetry(PROJECT)
    shutdownTelemetry()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(existsSync(queuePath())).toBe(false)
  })
})

describe('telemetry facade — flush is synchronous', () => {
  // The whole reason collecting and sending are separate: process.on('exit')
  // cannot await, so the queue must be complete the moment the call returns.

  it('has the session on disk immediately after shutdown returns', () => {
    optIn()
    initTelemetry(PROJECT)

    shutdownTelemetry()

    const queued = readQueue()
    expect(queued).toHaveLength(1)
    expect(queued[0]!.kind).toBe('session')
  })

  it('flushes only once, even when both SIGINT and exit fire', () => {
    optIn()
    initTelemetry(PROJECT)
    shutdownTelemetry()
    shutdownTelemetry()
    expect(readQueue()).toHaveLength(1)
  })

  it('is a no-op when initTelemetry was never called', () => {
    expect(() => shutdownTelemetry()).not.toThrow()
    expect(existsSync(queuePath())).toBe(false)
  })
})

describe('telemetry facade — what the payload carries', () => {
  it('reports the counts of commands and tools actually used', () => {
    optIn()
    initTelemetry(PROJECT)
    recordCommand('/help')
    recordCommand('/help')
    recordCommand('/telemetry')
    getMetrics().toolCalls.inc({ tool_name: 'Bash' })

    shutdownTelemetry()

    const counters = readQueue()[0]!.payload.counters as Record<string, number>
    expect(counters['command_calls./help']).toBe(2)
    expect(counters['command_calls./telemetry']).toBe(1)
    expect(counters['tool_calls.Bash']).toBe(1)
    expect(counters['cli_invocations']).toBe(0)
  })

  it('stamps a stable anonymous install id', () => {
    optIn()
    initTelemetry(PROJECT)
    shutdownTelemetry()
    const first = readQueue()[0]!.payload.installId
    expect(first).toMatch(/^[0-9a-f-]{36}$/)

    resetTelemetryState()
    initTelemetry(PROJECT)
    shutdownTelemetry()
    const events = readQueue()
    expect(events[1]!.payload.installId).toBe(first)
  })

  it('carries no paths, user names or environment values', () => {
    optIn()
    process.env.SECRET_CANARY = 'do-not-upload-me'
    initTelemetry(PROJECT)
    shutdownTelemetry()

    const serialised = JSON.stringify(readQueue())
    expect(serialised).not.toContain('do-not-upload-me')
    expect(serialised).not.toContain(PROJECT)
    expect(serialised).not.toContain(HOME)
    delete process.env.SECRET_CANARY
  })
})

describe('telemetry facade — isolation', () => {
  it("keeps this session's install id out of the real home directory", () => {
    // Same hazard the memory subsystem hit ("Alice"): code that resolves home
    // from process.env.HOME escapes the global homedir() mock and writes to the
    // developer's live ~/.mipham. Asserted on this run's random UUID rather than
    // on the directory existing — a developer who has genuinely opted in has
    // that directory, and the test would then fail for the wrong reason.
    optIn()
    initTelemetry(PROJECT)
    shutdownTelemetry()

    const id = readQueue()[0]!.payload.installId as string
    const realSettings = process.env.HOME
      ? join(process.env.HOME, '.mipham', 'settings.json')
      : null
    if (realSettings && existsSync(realSettings)) {
      expect(readFileSync(realSettings, 'utf-8')).not.toContain(id)
    }
  })
})

describe('telemetry facade — crash reporting', () => {
  it('queues both a crash event and a session marked as crashed', () => {
    optIn()
    initTelemetry(PROJECT)

    // Drive the crash recorder directly rather than raising a real uncaught
    // exception, which would take the test runner down with it.
    handleFatal(new Error('kaboom'), 'uncaughtException', {
      writeStderr: () => {},
      exit: () => {},
    })

    shutdownTelemetry()

    const queued = readQueue()
    expect(queued.map((e) => e.kind)).toEqual(['crash', 'session'])
    expect(queued[1]!.payload.crashed).toBe(true)
    expect(queued[0]!.payload.errorName).toBe('Error')
  })

  it('does not queue a crash event when the session was clean', () => {
    optIn()
    initTelemetry(PROJECT)
    shutdownTelemetry()
    expect(readQueue().map((e) => e.kind)).toEqual(['session'])
    expect(readQueue()[0]!.payload.crashed).toBe(false)
  })

  it('records a crash even when telemetry is off, but uploads nothing', () => {
    // Crash capture is installed unconditionally — it is what keeps a crash
    // from becoming a silent hang. With telemetry off the record stays local.
    const sink = { exit: vi.fn(), writeStderr: vi.fn() }
    initTelemetry(PROJECT)
    handleFatal(new Error('ignored'), 'uncaughtException', sink)

    expect(sink.exit).toHaveBeenCalledWith(1)
    shutdownTelemetry()
    expect(existsSync(queuePath())).toBe(false)
  })
})

describe('telemetry facade — startup flush', () => {
  it('drains the previous session queue when an endpoint is configured', async () => {
    optIn({ endpoint: 'https://telemetry.example/v1/events' })
    // A previous run left an event behind.
    const { enqueueSync } = await import('../../src/telemetry/queue')
    enqueueSync({ id: 'leftover', kind: 'session', payload: {} })

    initTelemetry(PROJECT)

    // Wait on the *end* of the flush, not on fetch itself: the request is
    // issued mid-loop and the queue is only acked once every event is done.
    // Waiting for the call lands in that gap and reads a queue still full.
    await vi.waitFor(() => expect(readQueue()).toEqual([]))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not flush at startup when no endpoint is set', () => {
    optIn()
    initTelemetry(PROJECT)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
