import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/mipham-test-cron-poller`,
  }
})

import { rmSync, existsSync, mkdirSync, utimesSync } from 'node:fs'
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

// ============================================================
// 轮询只认自己这个目录的任务。
//
// 存储是全局单店（~/.mipham/cron/），轮询器每个会话都在跑，而 prompt 会被塞进
// **当前会话**执行 —— 不过滤目录，就等于「在 A 项目建的日程，被 B 项目里开着的
// 会话执行」，prompt 在错误的代码库里展开。同时别的目录的任务不该被这次轮询
// 推进（那会让它在自己目录里少发一次）。
//
// 这组不需要自己的清理块：断言都按 id 取，前面 describe 留下的任务要么已被推进
// 到未来、要么已被删。顺带一提，**别**在这里加 `rmSync(homedir(), …)` —— 本仓库
// 有过「测试对真 home 删真 config」的事故（那类路径靠 mock 挡，mock 一旦失效就是
// 真删）。
// ============================================================

describe('cron-poller — 目录归属', () => {
  it('只发本目录的任务；别的目录的任务既不发出、也不被推进', () => {
    writeJob(makeJob({ id: 'in-alpha', cwd: '/proj/alpha', prompt: 'alpha-work', nextFire: past }))
    writeJob(makeJob({ id: 'in-beta', cwd: '/proj/beta', prompt: 'beta-work', nextFire: past }))

    const enqueue = vi.fn()
    const fired = checkCronJobs(enqueue, now, '/proj/alpha')

    expect(fired).toBe(1)
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(enqueue).toHaveBeenCalledWith('alpha-work')

    const remaining = readAllJobs()
    const beta = remaining.find((j) => j.id === 'in-beta')!
    expect(beta.nextFire).toBe(past) // 一点没动
    expect(beta.lastFired).toBeNull()

    const alpha = remaining.find((j) => j.id === 'in-alpha')!
    expect(alpha.lastFired).toBe(now.toISOString())
  })

  it('没有 cwd 的旧文件仍然照发（不静默停掉用户已建的日程）', () => {
    writeJob(makeJob({ id: 'legacy', prompt: 'legacy-work', nextFire: past }))

    const enqueue = vi.fn()
    const fired = checkCronJobs(enqueue, now, '/proj/alpha')

    expect(fired).toBe(1)
    expect(enqueue).toHaveBeenCalledWith('legacy-work')
  })
})

// ============================================================
// 同一个到期任务只许被触发一次。
//
// 存储是全局单店，同一目录里开两个 CLI 会话就有两个轮询器；每个都是
// `readAllJobs → enqueue → writeJob`，中间没有任何互斥。两边都会在对方写回
// 之前看到同一个到期任务 —— 任务跑两遍（重复的副作用、重复的 token）。
//
// 复现方式：在 `enqueue` 回调里同步再调一次 `checkCronJobs`。这恰好制造出
// 真实竞态的那个状态 —— 第二个轮询者已经读完目录（看到旧的到期状态），
// 而第一个还没写回。**这条测试在修复前必须是红的**。
// ============================================================

const cronDir = join(homedir(), '.mipham', 'cron')
const lockPath = (id: string): string => join(cronDir, `${id}.json.lock`)

describe('cron-poller — 同一任务只有一个轮询者能触发', () => {
  it('两个轮询者都读到同一个到期任务时，只入队一次', () => {
    writeJob(makeJob({ id: 'race', cwd: '/proj/lock-race', prompt: 'race-work', nextFire: past }))

    const nested = vi.fn()
    let entered = false
    const enqueue = vi.fn(() => {
      if (entered) return
      entered = true
      // 第二个轮询者读到的是写回之前的状态 —— 真实竞态的窗口。
      checkCronJobs(nested, now, '/proj/lock-race')
    })

    const fired = checkCronJobs(enqueue, now, '/proj/lock-race')

    expect(enqueue.mock.calls.length + nested.mock.calls.length).toBe(1)
    expect(fired).toBe(1)
  })

  it('另一个轮询者正持有该任务的锁时，本次跳过', () => {
    writeJob(makeJob({ id: 'busy', cwd: '/proj/lock-busy', prompt: 'busy-work', nextFire: past }))
    mkdirSync(lockPath('busy'), { recursive: true })

    const enqueue = vi.fn()
    const fired = checkCronJobs(enqueue, now, '/proj/lock-busy')

    expect(enqueue).not.toHaveBeenCalled()
    expect(fired).toBe(0)
    rmSync(lockPath('busy'), { recursive: true, force: true })
  })

  it('持锁者崩溃留下的过期锁会被接管（不能永久静默）', () => {
    writeJob(
      makeJob({ id: 'stale', cwd: '/proj/lock-stale', prompt: 'stale-work', nextFire: past }),
    )
    mkdirSync(lockPath('stale'), { recursive: true })
    const old = new Date(Date.now() - 10 * 60_000)
    utimesSync(lockPath('stale'), old, old)

    const enqueue = vi.fn()
    const fired = checkCronJobs(enqueue, now, '/proj/lock-stale')

    expect(fired).toBe(1)
    expect(enqueue).toHaveBeenCalledWith('stale-work')
  })
})
