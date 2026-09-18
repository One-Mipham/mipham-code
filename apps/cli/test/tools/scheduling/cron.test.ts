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

// ============================================================
// 任务属于**某个目录的某个会话**。
//
// CronCreate 原先丢掉整个 ctx：落盘的 job 只有 cron/prompt/recurring，id 由
// `cron:prompt` 哈希而来、存储又是全局单店。两个后果都不是理论上的：
//   ① 在 A 目录建的日程，会被**任何**别的目录里跑着的会话执行（prompt 在错误的
//      项目里展开）；
//   ② 两个目录建同一个 cron+prompt，第二个直接覆盖第一个（同一个文件名）。
// ============================================================

describe('CronCreate tool — 任务的归属', () => {
  const ctxIn = (cwd: string, sessionId = 'sess-a'): ToolContext => ({
    cwd,
    sessionId,
    provider: 'test',
    model: 'test-model',
  })

  it('落盘带上 cwd 与 sessionId', async () => {
    await cronCreateTool.execute(
      { cron: '0 9 * * *', prompt: 'scoped-job' },
      ctxIn('/proj/alpha', 'sess-alpha'),
    )

    const job = readAllJobs().find((j) => j.prompt === 'scoped-job')!
    expect(job.cwd).toBe('/proj/alpha')
    expect(job.sessionId).toBe('sess-alpha')
  })

  it('同一 cron+prompt 在两个目录下是两个任务（id 含 cwd，不互相覆盖）', async () => {
    const spec = { cron: '30 4 * * *', prompt: 'same-name-job' }
    await cronCreateTool.execute(spec, ctxIn('/proj/alpha'))
    await cronCreateTool.execute(spec, ctxIn('/proj/beta'))

    const jobs = readAllJobs().filter((j) => j.prompt === 'same-name-job')
    expect(jobs).toHaveLength(2)
    expect(new Set(jobs.map((j) => j.cwd))).toEqual(new Set(['/proj/alpha', '/proj/beta']))
    expect(new Set(jobs.map((j) => j.id)).size).toBe(2)
  })
})
