import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

// Isolate the cron tool's storage dir to a temp homedir (same pattern as
// memory-isolation.test.ts) so tests never touch the developer's ~/.mipham/cron.
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-cron`,
  }
})

import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ToolContext } from '../../../src/shared'
import { cronCreateTool, readAllJobs } from '../../../src/tools/scheduling/cron'

const ctx: ToolContext = {
  cwd: '/tmp/test',
  sessionId: 'test-session',
  provider: 'test',
  model: 'test-model',
}

const cronDir = join(homedir(), '.mipham', 'cron')

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

describe('CronCreate tool — job file shape', () => {
  it('writes a job with a computed nextFire and lastFired null', async () => {
    const result = await cronCreateTool.execute(
      { cron: '0 9 * * *', prompt: 'daily-brief', recurring: true },
      ctx,
    )
    expect(result.success).toBe(true)

    const jobs = readAllJobs()
    expect(jobs).toHaveLength(1)
    const job = jobs[0]!
    expect(job.cron).toBe('0 9 * * *')
    expect(job.prompt).toBe('daily-brief')
    expect(job.lastFired).toBeNull()
    expect(new Date(job.nextFire).getTime()).toBeGreaterThan(Date.now())
  })

  it('readAllJobs backfills nextFire for legacy files written before the executor', () => {
    mkdirSync(cronDir, { recursive: true })
    writeFileSync(
      join(cronDir, 'legacy.json'),
      JSON.stringify({
        id: 'legacy',
        cron: '0 9 * * *',
        prompt: 'old-job',
        recurring: true,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      'utf-8',
    )

    const jobs = readAllJobs()
    const legacy = jobs.find((j) => j.id === 'legacy')
    expect(legacy).toBeDefined()
    expect(legacy!.lastFired).toBeNull()
    expect(new Date(legacy!.nextFire).getTime()).toBeGreaterThan(Date.now())
  })
})
