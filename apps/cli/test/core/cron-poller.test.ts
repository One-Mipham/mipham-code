import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-cron-poller`,
  }
})

import { rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { CronJob } from '../../src/tools/scheduling/cron'
import { writeJob, readAllJobs } from '../../src/tools/scheduling/cron'
import { findDueJobs, advanceJob, checkCronJobs } from '../../src/core/cron-poller'

const now = new Date(2026, 0, 1, 12, 0, 0)
const past = new Date(2026, 0, 1, 11, 0, 0).toISOString()
const future = new Date(2026, 0, 1, 13, 0, 0).toISOString()

function makeJob(overrides: Partial<CronJob>): CronJob {
  return {
    id: 'a',
    cron: '* * * * *',
    prompt: 'p',
    recurring: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    nextFire: past,
    lastFired: null,
    ...overrides,
  }
}

describe('cron-poller — pure helpers', () => {
  it('findDueJobs returns jobs whose nextFire is at or before now', () => {
    const due = makeJob({ id: 'due', nextFire: past })
    const futureJob = makeJob({ id: 'future', nextFire: future })
    const exact = makeJob({ id: 'exact', nextFire: now.toISOString() })

    const result = findDueJobs([due, futureJob, exact], now)
    expect(result.map((j) => j.id)).toEqual(['due', 'exact'])
  })

  it('advanceJob re-schedules a recurring job and returns null for one-shot', () => {
    const recurring = advanceJob(makeJob({ recurring: true }), now)
    expect(recurring!.lastFired).toBe(now.toISOString())
    expect(new Date(recurring!.nextFire).getTime()).toBeGreaterThan(now.getTime())

    expect(advanceJob(makeJob({ recurring: false }), now)).toBeNull()
  })
})

describe('cron-poller — checkCronJobs', () => {
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

  it('enqueues due jobs, advances recurring, deletes one-shot, ignores future', () => {
    writeJob(makeJob({ id: 'recur', cron: '*/5 * * * *', nextFire: past, recurring: true }))
    writeJob(makeJob({ id: 'once', nextFire: past, recurring: false }))
    writeJob(makeJob({ id: 'future', nextFire: future }))

    const enqueue = vi.fn()
    const fired = checkCronJobs(enqueue, now)

    expect(fired).toBe(2)
    expect(enqueue).toHaveBeenCalledTimes(2)
    expect(enqueue).toHaveBeenCalledWith('p')

    // recurring advanced, one-shot deleted, future untouched
    const remaining = readAllJobs()
    const ids = remaining.map((j) => j.id).sort()
    expect(ids).toEqual(['future', 'recur'])
    expect(existsSync(join(homedir(), '.mipham', 'cron', 'once.json'))).toBe(false)

    const recur = remaining.find((j) => j.id === 'recur')!
    expect(recur.lastFired).toBe(now.toISOString())
    expect(new Date(recur.nextFire).getTime()).toBeGreaterThan(now.getTime())
  })
})
