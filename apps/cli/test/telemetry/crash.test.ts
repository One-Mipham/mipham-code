import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => '/Users/zqxuser' }
})

import {
  handleFatal,
  installCrashHandlers,
  hasCrashed,
  getLastCrash,
  buildCrashEvent,
  resetCrashState,
  type CrashSinks,
} from '../../src/telemetry/crash'
import { SCHEMA_VERSION } from '../../src/telemetry/payload'

const CWD = '/Users/zqxuser/proj'

function spies(): CrashSinks & { stderr: string[]; exitCodes: number[] } {
  const stderr: string[] = []
  const exitCodes: number[] = []
  return {
    stderr,
    exitCodes,
    writeStderr: (t) => stderr.push(t),
    exit: (c) => exitCodes.push(c),
  }
}

describe('crash — termination contract', () => {
  beforeEach(() => resetCrashState())
  afterEach(() => resetCrashState())

  it('always terminates with a non-zero code', () => {
    // The single most dangerous failure mode: a handler that records but does
    // not exit turns every crash into a silent hang.
    const sink = spies()
    handleFatal(new Error('boom'), 'uncaughtException', sink)
    expect(sink.exitCodes).toEqual([1])
  })

  it('terminates even when the thrown value is not an Error', () => {
    const sink = spies()
    handleFatal('just a string', 'unhandledRejection', sink)
    expect(sink.exitCodes).toEqual([1])

    const sink2 = spies()
    handleFatal(undefined, 'unhandledRejection', sink2)
    expect(sink2.exitCodes).toEqual([1])
  })

  it('terminates even when the thrown value cannot be serialised', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const sink = spies()
    handleFatal(circular, 'uncaughtException', sink)
    expect(sink.exitCodes).toEqual([1])
  })

  it('still terminates when the stderr sink itself throws', () => {
    const sink = spies()
    sink.writeStderr = () => {
      throw new Error('stderr is gone')
    }
    expect(() => handleFatal(new Error('boom'), 'uncaughtException', sink)).not.toThrow()
    expect(sink.exitCodes).toEqual([1])
  })

  it('preserves Node default behaviour: the user still sees the stack', () => {
    const sink = spies()
    handleFatal(new Error('boom'), 'uncaughtException', sink)
    expect(sink.stderr.join('')).toContain('boom')
    expect(sink.stderr.join('')).toContain('Error')
  })
})

describe('crash — capture', () => {
  beforeEach(() => resetCrashState())
  afterEach(() => resetCrashState())

  it('reports no crash before one happens', () => {
    expect(hasCrashed()).toBe(false)
    expect(buildCrashEvent('id')).toBeNull()
  })

  it('records name, origin and time', () => {
    handleFatal(
      new TypeError('x'),
      'unhandledRejection',
      spies(),
      new Date('2026-09-15T01:02:03.000Z'),
    )
    const record = getLastCrash()
    expect(record).toMatchObject({
      errorName: 'TypeError',
      origin: 'unhandledRejection',
      occurredAt: '2026-09-15T01:02:03.000Z',
    })
    expect(hasCrashed()).toBe(true)
  })

  it('sends a digest of the message, never the message', () => {
    handleFatal(
      new Error('could not open /Users/zqxuser/proj/secret.txt'),
      'uncaughtException',
      spies(),
    )
    const payload = buildCrashEvent('id')!.payload
    expect(payload.messageHash).toMatch(/^[0-9a-f]{16}$/)
    expect(JSON.stringify(payload)).not.toContain('secret.txt')
    expect(JSON.stringify(payload)).not.toContain('could not open')
  })

  it('redacts the home path and the user name out of the stack', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(CWD)
    try {
      const err = new Error('boom')
      err.stack = [
        'Error: boom',
        `    at handler (${CWD}/src/a.ts:10:5)`,
        '    at processTicksAndRejections (node:internal/process/task_queues:95:5)',
      ].join('\n')
      handleFatal(err, 'uncaughtException', spies())

      const frames = getLastCrash()!.stackFrames.join('\n')
      expect(frames).toContain('at handler (<cwd>/src/a.ts:10:5)')
      expect(frames).not.toContain('zqxuser')
      expect(frames).not.toContain(CWD)
    } finally {
      cwdSpy.mockRestore()
    }
  })

  it('does not leak a sibling directory name when the crash is outside cwd', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(CWD)
    try {
      const err = new Error('boom')
      err.stack = `Error: boom\n    at other (/Users/zqxuser/acme-merger/src/b.ts:1:1)`
      handleFatal(err, 'uncaughtException', spies())

      const frames = getLastCrash()!.stackFrames.join('\n')
      expect(frames).toContain('~/<dir>/src/b.ts:1:1')
      expect(frames).not.toContain('acme-merger')
    } finally {
      cwdSpy.mockRestore()
    }
  })

  it('carries version, runtime and platform for triage', () => {
    handleFatal(new Error('boom'), 'uncaughtException', spies())
    const payload = buildCrashEvent('id-1')!.payload
    expect(payload.installId).toBe('id-1')
    expect(payload.appVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(payload.platform).toMatch(/^[a-z0-9]+\/[a-z0-9]+$/)
  })

  it('emits exactly the documented top-level fields', () => {
    handleFatal(new Error('boom'), 'uncaughtException', spies())
    expect(Object.keys(buildCrashEvent('id')!.payload).sort()).toEqual([
      'appVersion',
      'errorName',
      'frameCount',
      'installId',
      'messageHash',
      'occurredAt',
      'origin',
      'platform',
      'runtime',
      'schemaVersion',
    ])
  })

  it('keeps the frames local: recorded on the machine, absent from the wire', () => {
    // v2 的全部要点。记录里**有**帧（本地诊断用），事件里**没有**（服务端从来不存，
    // 发了只是白送 ~3 KB 与一个隐私面）。两件事必须同时成立 —— 只测「事件里没有」
    // 的话，把 redactStack 整个删掉也能绿。
    handleFatal(new Error('boom'), 'uncaughtException', spies())

    expect(getLastCrash()!.stackFrames.length).toBeGreaterThan(0)
    expect(buildCrashEvent('id')!.payload).not.toHaveProperty('stackFrames')
    expect(buildCrashEvent('id')!.payload.schemaVersion).toBe(SCHEMA_VERSION)
  })
})

describe('crash — handler installation', () => {
  beforeEach(() => resetCrashState())
  afterEach(() => resetCrashState())

  it('installs exactly one listener per event, even when called twice', () => {
    // Two handlers would each call exit(); stacking must be impossible.
    //
    // Measured as a *delta*, not an absolute count: the test runner registers
    // its own uncaughtException listener, so asserting "exactly 1" would be
    // asserting something about vitest rather than about this module — and it
    // would only have passed while `resetCrashState` was wrongly stripping
    // listeners it did not own.
    const before = {
      uncaught: process.listeners('uncaughtException').length,
      rejection: process.listeners('unhandledRejection').length,
    }

    installCrashHandlers(spies())
    installCrashHandlers(spies())

    expect(process.listeners('uncaughtException')).toHaveLength(before.uncaught + 1)
    expect(process.listeners('unhandledRejection')).toHaveLength(before.rejection + 1)
  })

  it('uninstalls only its own listeners, leaving everyone else registered', () => {
    // The reset is a test seam, but `removeAllListeners` would reach far past
    // this module: it takes out the runner's handler too, so a crash during
    // any later test would go unreported while the suite stayed green.
    const foreign = (): void => {}
    process.on('uncaughtException', foreign)
    try {
      installCrashHandlers(spies())
      resetCrashState()
      expect(process.listeners('uncaughtException')).toContain(foreign)
    } finally {
      process.off('uncaughtException', foreign)
    }
  })

  it('wires the listeners to the termination path', () => {
    const sink = spies()
    installCrashHandlers(sink)
    process.emit('uncaughtException', new Error('from the listener'))
    expect(sink.exitCodes).toEqual([1])
    expect(hasCrashed()).toBe(true)
  })

  it('wires unhandled rejections the same way', () => {
    const sink = spies()
    installCrashHandlers(sink)
    process.emit('unhandledRejection', new Error('rejected'), Promise.resolve())
    expect(sink.exitCodes).toEqual([1])
    expect(getLastCrash()!.origin).toBe('unhandledRejection')
  })
})
