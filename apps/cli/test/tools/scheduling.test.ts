import { describe, it, expect } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import type { ToolContext } from '../../src/shared'
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

  // ============================================================
  // 加 cwd 之前写下的任务文件没有归属 —— 轮询照发（不静默停掉用户的日程），
  // 代价是它在**任何**目录都执行。列表是唯一能看见那件事的地方。
  //
  // 旧文件只能直接写盘：`CRON_DIR` 是模块常量，没有注入点。nextFire 放到 2099，
  // 万一清理失败它也绝不会被轮询到 —— 一个没有 cwd 的任务真跑起来就是真执行。
  // ============================================================
  const LEGACY_ID = 'legacy0no0cwd'

  function writeLegacyJob(): string {
    const dir = join(homedir(), '.mipham', 'cron')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `${LEGACY_ID}.json`)
    writeFileSync(
      path,
      JSON.stringify({
        id: LEGACY_ID,
        cron: '0 3 * * *',
        prompt: 'legacy job without cwd',
        recurring: true,
        createdAt: '2026-09-01T00:00:00.000Z',
        nextFire: '2099-01-01T00:00:00.000Z',
        lastFired: null,
      }),
      'utf-8',
    )
    return path
  }

  it('没有 cwd 的旧任务在列表里标 [无归属]，并给出处置办法', async () => {
    const path = writeLegacyJob()
    try {
      const list = await cronListTool.execute({}, ctx)

      // 断言钉在**这一行**上：整份输出里也有 '⚠️ [无归属]' 那两行提示，用
      // `toContain` 断言整块内容的话，把行内标记删掉测试照样绿。
      const row = list.content!.split('\n').find((l) => l.includes(LEGACY_ID))
      expect(row).toBeTruthy()
      expect(row).toContain('[无归属]')
      expect(list.content).toContain('CronDelete')
    } finally {
      rmSync(path, { force: true })
    }
  })

  it('有 cwd 的任务显示自己的目录，不显示 [无归属]（正控）', async () => {
    const created = await cronCreateTool.execute(
      { cron: '0 */6 * * *', prompt: 'scoped job', recurring: true },
      ctx,
    )
    const jobId = created.content!.match(/ID: ([a-f0-9]+)/)![1]!
    try {
      const list = await cronListTool.execute({}, ctx)

      expect(list.content).toContain(`[${ctx.cwd}]`)
      expect(list.content).not.toContain('⚠️ [无归属]')
    } finally {
      await cronDeleteTool.execute({ id: jobId }, ctx)
    }
  })
})
