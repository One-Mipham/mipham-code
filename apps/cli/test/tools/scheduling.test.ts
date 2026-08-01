import { describe, it, expect } from 'vitest'
import type { ToolContext } from '@mipham/shared'
import { scheduleWakeupTool } from '../../src/tools/scheduling/schedule-wakeup.js'
import { cronCreateTool, cronDeleteTool, cronListTool } from '../../src/tools/scheduling/cron.js'

const ctx: ToolContext = {
  cwd: '/tmp/test',
  sessionId: 'test-scheduling',
  provider: 'test',
  model: 'test-model',
}

// ============================================================
// ScheduleWakeup
// ============================================================

describe('ScheduleWakeup tool definition', () => {
  it('has correct metadata', () => {
    expect(scheduleWakeupTool.name).toBe('ScheduleWakeup')
    expect(scheduleWakeupTool.category).toBe('scheduling')
    expect(scheduleWakeupTool.permission).toBe('auto')
  })
})

describe('ScheduleWakeup execution', () => {
  it('rejects delaySeconds below 60', async () => {
    const result = await scheduleWakeupTool.execute(
      { delaySeconds: 10, reason: 'test', prompt: 'check' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('60')
  })

  it('rejects delaySeconds above 3600', async () => {
    const result = await scheduleWakeupTool.execute(
      { delaySeconds: 7200, reason: 'test', prompt: 'check' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('3600')
  })

  it('schedules a valid wakeup', async () => {
    const result = await scheduleWakeupTool.execute(
      { delaySeconds: 300, reason: 'poll deployment', prompt: 'check status' },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.content).toContain('5m')
    expect(result.content).toContain('check status')
    expect(result.content).toContain('poll deployment')
  })

  it('stop=true cancels pending wakeups', async () => {
    const result = await scheduleWakeupTool.execute({ stop: true }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('Loop ended')
  })

  it('rejects missing delaySeconds', async () => {
    const result = await scheduleWakeupTool.execute({ reason: 'test', prompt: 'check' }, ctx)
    expect(result.success).toBe(false)
  })
})

// ============================================================
// CronCreate / CronDelete / CronList
// ============================================================

describe('CronCreate tool definition', () => {
  it('has correct metadata', () => {
    expect(cronCreateTool.name).toBe('CronCreate')
    expect(cronCreateTool.category).toBe('scheduling')
  })

  it('requires cron and prompt', () => {
    const params = cronCreateTool.parameters as { required: string[] }
    expect(params.required).toEqual(['cron', 'prompt'])
  })
})

describe('CronList tool definition', () => {
  it('has correct metadata', () => {
    expect(cronListTool.name).toBe('CronList')
    expect(cronListTool.category).toBe('scheduling')
  })
})

describe('CronDelete tool definition', () => {
  it('has correct metadata', () => {
    expect(cronDeleteTool.name).toBe('CronDelete')
    expect(cronDeleteTool.category).toBe('scheduling')
  })

  it('requires id', () => {
    const params = cronDeleteTool.parameters as { required: string[] }
    expect(params.required).toEqual(['id'])
  })
})

describe('CronCreate + CronList integration', () => {
  it('creates a cron job and lists it', async () => {
    const created = await cronCreateTool.execute(
      { cron: '0 */6 * * *', prompt: 'daily health check', recurring: true },
      ctx,
    )
    expect(created.success).toBe(true)
    expect(created.content).toContain('Created')

    const jobId = created.content!.match(/ID: ([a-f0-9]+)/)![1]!

    const list = await cronListTool.execute({}, ctx)
    expect(list.success).toBe(true)
    expect(list.content).toContain('daily health check')

    // Cleanup
    await cronDeleteTool.execute({ id: jobId }, ctx)
  })

  it('CronDelete removes a job', async () => {
    const created = await cronCreateTool.execute(
      { cron: '0 9 * * 1-5', prompt: 'weekday morning check', recurring: true },
      ctx,
    )
    const jobId = created.content!.match(/ID: ([a-f0-9]+)/)![1]!

    const deleted = await cronDeleteTool.execute({ id: jobId }, ctx)
    expect(deleted.success).toBe(true)
    expect(deleted.content).toContain('deleted')
  })
})
