import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  scheduleWakeupTool,
  registerWakeupHandler,
} from '../../../src/tools/scheduling/schedule-wakeup'

describe('ScheduleWakeup re-invocation', () => {
  afterEach(() => vi.useRealTimers())

  it('calls the registered wakeup handler when the timer fires', async () => {
    vi.useFakeTimers()
    const handler = vi.fn()
    registerWakeupHandler(handler)

    await scheduleWakeupTool.execute(
      { delaySeconds: 60, reason: 'poll CI', prompt: 'loop-1' },
      { cwd: '/tmp', sessionId: 'sess-1', provider: '', model: '' },
    )
    expect(handler).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60_000)
    expect(handler).toHaveBeenCalledWith('sess-1', 'loop-1')
  })

  it('does not call handler after stop:true cancels the timer', async () => {
    vi.useFakeTimers()
    const handler = vi.fn()
    registerWakeupHandler(handler)

    await scheduleWakeupTool.execute(
      { delaySeconds: 60, reason: 'poll', prompt: 'loop-1' },
      { cwd: '/tmp', sessionId: 'sess-1', provider: '', model: '' },
    )
    await scheduleWakeupTool.execute(
      { stop: true },
      { cwd: '/tmp', sessionId: 'sess-1', provider: '', model: '' },
    )
    vi.advanceTimersByTime(60_000)
    expect(handler).not.toHaveBeenCalled()
  })
})
