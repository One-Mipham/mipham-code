import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest'

// Isolate the wakeup store to a temp homedir (same pattern as cron.test.ts) so a
// test never writes into — or deletes from — the developer's real ~/.mipham.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-wakeups`,
  }
})

import { rmSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'
import {
  scheduleWakeupTool,
  registerWakeupHandler,
  resumeWakeups,
  readPersistedWakeups,
  cancelAllSessionTimers,
} from '../../../src/tools/scheduling/schedule-wakeup'
import type { PersistedWakeup } from '../../../src/tools/scheduling/schedule-wakeup'

const ctx = (sessionId: string) => ({ cwd: '/tmp', sessionId, provider: '', model: '' })
const wakeupDir = join(homedir(), '.mipham', 'wakeups')
const filesOnDisk = (): PersistedWakeup[] => (existsSync(wakeupDir) ? readPersistedWakeups() : [])

beforeAll(() => {
  try {
    rmSync(join(homedir(), '.mipham'), { recursive: true, force: true })
  } catch {
    /* ok */
  }
})

afterAll(() => {
  try {
    rmSync(join(homedir(), '.mipham'), { recursive: true, force: true })
  } catch {
    /* ok */
  }
})

describe('ScheduleWakeup re-invocation', () => {
  afterEach(() => {
    vi.useRealTimers()
    cancelAllSessionTimers('sess-1')
    cancelAllSessionTimers('sess-2')
  })

  it('calls the registered wakeup handler when the timer fires', async () => {
    vi.useFakeTimers()
    const handler = vi.fn()
    registerWakeupHandler(handler)

    await scheduleWakeupTool.execute(
      { delaySeconds: 60, reason: 'poll CI', prompt: 'loop-1' },
      ctx('sess-1'),
    )
    expect(handler).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60_000)
    expect(handler).toHaveBeenCalledWith('sess-1', 'loop-1', false)
  })

  it('does not call handler after stop:true cancels the timer', async () => {
    vi.useFakeTimers()
    const handler = vi.fn()
    registerWakeupHandler(handler)

    await scheduleWakeupTool.execute(
      { delaySeconds: 60, reason: 'poll', prompt: 'loop-1' },
      ctx('sess-1'),
    )
    await scheduleWakeupTool.execute({ stop: true }, ctx('sess-1'))
    vi.advanceTimersByTime(60_000)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('ScheduleWakeup — the pending wakeup survives the process', () => {
  afterEach(() => {
    vi.useRealTimers()
    cancelAllSessionTimers('sess-1')
    cancelAllSessionTimers('sess-2')
  })

  it('writes the pending wakeup to disk, and clears it once it fires', async () => {
    vi.useFakeTimers()
    registerWakeupHandler(vi.fn())

    await scheduleWakeupTool.execute(
      { delaySeconds: 300, reason: 'poll CI', prompt: 'loop-1' },
      ctx('sess-1'),
    )

    const [entry] = filesOnDisk()
    expect(entry).toMatchObject({ sessionId: 'sess-1', prompt: 'loop-1', reason: 'poll CI' })
    expect(new Date(entry!.firesAt).getTime()).toBe(Date.now() + 300_000)

    vi.advanceTimersByTime(300_000)
    expect(filesOnDisk()).toHaveLength(0)
  })

  it('stop:true clears the file too — an ended loop must not come back on restart', async () => {
    vi.useFakeTimers()
    registerWakeupHandler(vi.fn())

    await scheduleWakeupTool.execute(
      { delaySeconds: 60, reason: 'poll', prompt: 'loop-1' },
      ctx('sess-1'),
    )
    expect(filesOnDisk()).toHaveLength(1)

    await scheduleWakeupTool.execute({ stop: true }, ctx('sess-1'))
    expect(filesOnDisk()).toHaveLength(0)
  })

  it('a wakeup stored for another session is not this session`s business', async () => {
    vi.useFakeTimers()
    const handler = vi.fn()
    registerWakeupHandler(handler)

    await scheduleWakeupTool.execute(
      { delaySeconds: 600, reason: 'other', prompt: 'other-loop' },
      ctx('sess-2'),
    )

    expect(resumeWakeups({ sessionId: 'sess-1' })).toEqual([])
    vi.advanceTimersByTime(600_000)
    // sess-1 never armed anything; the timer that fired belongs to sess-2 alone.
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith('sess-2', 'other-loop', false)
  })
})

describe('resumeWakeups — rebuilding a wakeup after a restart', () => {
  afterEach(() => {
    vi.useRealTimers()
    cancelAllSessionTimers('sess-1')
    cancelAllSessionTimers('sess-2')
  })

  it('re-arms a wakeup that is still in the future, for the time it has left', async () => {
    vi.useFakeTimers()
    const handler = vi.fn()
    registerWakeupHandler(handler)

    await scheduleWakeupTool.execute(
      { delaySeconds: 300, reason: 'poll CI', prompt: 'loop-1' },
      ctx('sess-1'),
    )
    // 100s of the 300 elapse, then the process restarts: same store, no live timer.
    vi.advanceTimersByTime(100_000)
    cancelAllSessionTimers('sess-1')
    writeBackTheFile({
      sessionId: 'sess-1',
      prompt: 'loop-1',
      reason: 'poll CI',
      firesAt: new Date(Date.now() + 200_000),
    })

    expect(resumeWakeups({ sessionId: 'sess-1' })).toEqual([])

    // The remaining 200s, not the original 300 and not zero.
    vi.advanceTimersByTime(199_000)
    expect(handler).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1_000)
    expect(handler).toHaveBeenCalledWith('sess-1', 'loop-1', false)
  })

  it('reports a wakeup that came due while we were down instead of firing it', async () => {
    vi.useFakeTimers()
    const handler = vi.fn()
    registerWakeupHandler(handler)

    writeBackTheFile({
      sessionId: 'sess-1',
      prompt: 'loop-1',
      reason: 'poll CI',
      firesAt: new Date(Date.now() - 60_000),
    })

    const lost = resumeWakeups({ sessionId: 'sess-1' })

    expect(lost).toEqual([
      { prompt: 'loop-1', reason: 'poll CI', firesAt: new Date(Date.now() - 60_000).toISOString() },
    ])
    // Reported once, not left to be reported again on the next start.
    expect(filesOnDisk()).toHaveLength(0)
    // And not run blind: the caller decides what the model hears.
    vi.advanceTimersByTime(3_600_000)
    expect(handler).not.toHaveBeenCalled()
  })

  it('drops an unparseable firesAt rather than arming a timer for NaN', () => {
    vi.useFakeTimers()
    registerWakeupHandler(vi.fn())

    writeBackTheFile({ sessionId: 'sess-1', prompt: 'loop-1', reason: 'x', firesAt: 'not-a-date' })

    expect(resumeWakeups({ sessionId: 'sess-1' })).toEqual([])
    expect(filesOnDisk()).toHaveLength(0)
  })
})

/**
 * Plant a wakeup file directly — the on-disk state a killed process leaves behind,
 * written the way the module writes it (same hashed file name) so the test exercises
 * the real read path rather than a shape of its own.
 */
function writeBackTheFile(entry: {
  sessionId: string
  prompt: string
  reason: string
  firesAt: Date | string
}): void {
  mkdirSync(wakeupDir, { recursive: true })
  const name = createHash('sha256').update(entry.sessionId).digest('hex').slice(0, 32)
  const firesAt = entry.firesAt instanceof Date ? entry.firesAt.toISOString() : entry.firesAt
  writeFileSync(join(wakeupDir, `${name}.json`), JSON.stringify({ noop: false, ...entry, firesAt }))
}
