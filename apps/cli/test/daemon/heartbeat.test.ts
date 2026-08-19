import { describe, it, expect, vi } from 'vitest'
import {
  collectPendingItems,
  buildHeartbeatMessage,
  heartbeatTick,
  startHeartbeat,
} from '../../src/daemon/heartbeat'
import type { DaemonGoal, DaemonSchedule } from '../../src/daemon/types'

function goal(overrides: Partial<DaemonGoal> = {}): DaemonGoal {
  return {
    id: 1,
    sessionId: 's1',
    description: '实现心跳通知',
    status: 'active',
    progress: null,
    createdAt: 'ts',
    updatedAt: 'ts',
    ...overrides,
  }
}

function schedule(overrides: Partial<DaemonSchedule> = {}): DaemonSchedule {
  return {
    id: 1,
    sessionId: 's1',
    cronExpr: '0 9 * * *',
    prompt: '检查 CI',
    enabled: true,
    lastFired: null,
    nextFire: 'ts',
    ...overrides,
  }
}

describe('collectPendingItems', () => {
  it('collects active goals and enabled schedules only', () => {
    const pending = collectPendingItems(
      [
        goal({ status: 'active', description: 'a' }),
        goal({ status: 'completed', description: 'done' }),
        goal({ status: 'paused', description: 'paused' }),
      ],
      [schedule({ enabled: true, prompt: 's1' }), schedule({ enabled: false, prompt: 's2' })],
    )
    expect(pending.goalCount).toBe(1)
    expect(pending.scheduleCount).toBe(1)
    expect(pending.summaries).toHaveLength(2)
  })

  it('returns zero counts when nothing pending', () => {
    const pending = collectPendingItems(
      [goal({ status: 'completed' })],
      [schedule({ enabled: false })],
    )
    expect(pending.goalCount).toBe(0)
    expect(pending.scheduleCount).toBe(0)
    expect(pending.summaries).toEqual([])
  })
})

describe('buildHeartbeatMessage', () => {
  it('returns null when nothing pending', () => {
    expect(buildHeartbeatMessage({ goalCount: 0, scheduleCount: 0, summaries: [] })).toBeNull()
  })

  it('renders counts and item summaries', () => {
    const msg = buildHeartbeatMessage({
      goalCount: 2,
      scheduleCount: 1,
      summaries: ['🎯 a', '🎯 b', '⏰ c'],
    })
    expect(msg).toContain('2 个待办 goal')
    expect(msg).toContain('1 个定时任务')
    expect(msg).toContain('🎯 a')
  })

  it('truncates long summary lists with an overflow note', () => {
    const summaries = Array.from({ length: 15 }, (_, i) => `🎯 ${i}`)
    const msg = buildHeartbeatMessage({ goalCount: 15, scheduleCount: 0, summaries })
    expect(msg).toContain('另外 5 项')
    expect(msg).not.toContain('🎯 14')
  })
})

describe('heartbeatTick', () => {
  it('pushes a message when there are pending items', () => {
    const push = vi.fn()
    heartbeatTick(
      {
        listGoals: () => [goal({ status: 'active', description: 'g1' })],
        listSchedules: () => [] as DaemonSchedule[],
      },
      push,
    )
    expect(push).toHaveBeenCalledTimes(1)
    expect(push.mock.calls[0]![0]).toContain('1 个待办 goal')
  })

  it('does not push when nothing pending', () => {
    const push = vi.fn()
    heartbeatTick(
      { listGoals: () => [] as DaemonGoal[], listSchedules: () => [] as DaemonSchedule[] },
      push,
    )
    expect(push).not.toHaveBeenCalled()
  })
})

describe('startHeartbeat', () => {
  it('returns a stop function that clears the interval', () => {
    const stop = startHeartbeat({
      source: { listGoals: () => [] as DaemonGoal[], listSchedules: () => [] as DaemonSchedule[] },
      push: vi.fn(),
      intervalMs: 60_000,
    })
    expect(typeof stop).toBe('function')
    stop()
  })
})
