/**
 * 到点的 cron 必须真的跑起来 —— 即使这一刻没有人为这个会话开过工。
 *
 * 修复前的形态：`checkAndFire` 只问 `pool.getWorker()`，没有就 `continue`。而 worker
 * 是**惰性创建**的（只有收到入站 prompt 或 set_mode 才有），被空闲回收之后同样没有。
 * 于是一条 cron 在两个 tick 之间从来没有「恰好有个 worker」就永远不跑，且一声不响。
 *
 * 判据分两半：给了 spawner 时**能自己把 worker 拉起来**；给不出时**不推进
 * nextFire**（下一 tick 再试），而不是把这一次悄悄当成已经跑过。
 */

import { describe, it, expect, vi } from 'vitest'
import { ScheduleManager } from '../../src/daemon/schedule-manager'
import type { DaemonDatabase } from '../../src/daemon/database'
import type { WorkerPool } from '../../src/daemon/worker-pool'
import type { SessionWorker } from '../../src/daemon/session-worker'

function schedule(id: number, sessionId = 's1') {
  return {
    id,
    sessionId,
    prompt: 'check the build',
    cronExpr: '*/5 * * * *',
    enabled: true,
    lastFired: null,
    nextFire: '2000-01-01T00:00:00.000Z',
  }
}

function setup(opts: { active?: SessionWorker } = {}) {
  const fired: number[] = []
  const db = {
    getDueSchedules: () => [schedule(1)],
    updateScheduleFireTimes: (id: number) => fired.push(id),
  } as unknown as DaemonDatabase
  const pool = {
    getWorker: () => opts.active,
  } as unknown as WorkerPool
  return { manager: new ScheduleManager(db, pool), fired }
}

function fakeWorker() {
  const prompts: string[] = []
  const worker = {
    processPrompt: vi.fn(async (p: string) => {
      prompts.push(p)
    }),
  }
  return { worker: worker as unknown as SessionWorker, prompts }
}

describe('ScheduleManager.checkAndFire', () => {
  it('没有活动 worker 时，用 spawner 把会话拉起来再投递', () => {
    const { manager, fired } = setup()
    const { worker, prompts } = fakeWorker()
    manager.setWorkerSpawner(() => worker)

    manager.checkAndFire()

    expect(prompts).toEqual(['check the build'])
    expect(fired).toEqual([1]) // 这一次算跑过了，nextFire 推进
  })

  it('已经有活动 worker 时不去创建（池里有就用池里的）', () => {
    const active = fakeWorker()
    const { manager } = setup({ active: active.worker })
    const spawn = vi.fn()
    manager.setWorkerSpawner(spawn)

    manager.checkAndFire()

    expect(active.prompts).toEqual(['check the build'])
    expect(spawn).not.toHaveBeenCalled()
  })

  it('spawner 也拉不起来 ⇒ 不推进 nextFire，下一 tick 还会重试', () => {
    const { manager, fired } = setup()
    manager.setWorkerSpawner(() => null)

    manager.checkAndFire()

    expect(fired).toEqual([]) // 没有假装跑过、没有把这一次丢掉
  })

  it('没登记 spawner 的调用方（测试/嵌入式）行为不变：跳过、不推进', () => {
    const { manager, fired } = setup()

    manager.checkAndFire()

    expect(fired).toEqual([])
  })
})
