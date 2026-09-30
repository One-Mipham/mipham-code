import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getEventBus } from '../../src/workflow/event-bus'

describe('WorkflowEventBus', () => {
  beforeEach(() => {
    // Reset singleton state between tests
    const bus = getEventBus() as any
    bus.activeRunId = null
    bus.removeAllListeners()
  })

  it('emits and receives phase:start event', () => {
    const bus = getEventBus()
    const handler = vi.fn()
    bus.on('phase:start', handler)

    bus.startRun('test-run-1')
    bus.emitEvent({ type: 'phase:start', phase: 'Scan', timestamp: Date.now() })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0].phase).toBe('Scan')
  })

  it('emits and receives agent:start and agent:end events', () => {
    const bus = getEventBus()
    const startHandler = vi.fn()
    const endHandler = vi.fn()
    bus.on('agent:start', startHandler)
    bus.on('agent:end', endHandler)

    bus.startRun('test-run-2')
    bus.emitEvent({ type: 'agent:start', agentId: 'a1', label: 'grep', phase: 'Scan' })
    bus.emitEvent({
      type: 'agent:end',
      agentId: 'a1',
      label: 'grep',
      success: true,
      durationMs: 1200,
    })

    expect(startHandler).toHaveBeenCalledTimes(1)
    expect(endHandler).toHaveBeenCalledTimes(1)
    expect(endHandler.mock.calls[0]![0].success).toBe(true)
    expect(endHandler.mock.calls[0]![0].durationMs).toBe(1200)
  })

  it('emits done event with summary stats', () => {
    const bus = getEventBus()
    const handler = vi.fn()
    bus.on('done', handler)

    bus.startRun('test-run-3')
    bus.emitEvent({ type: 'done', runId: 'test-run-3', totalAgents: 5, cacheHits: 2 })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0].totalAgents).toBe(5)
  })

  it('getActiveRunId returns null when no run started', () => {
    const bus = getEventBus()
    expect(bus.getActiveRunId()).toBeNull()
  })

  it('getActiveRunId returns current run id', () => {
    const bus = getEventBus()
    bus.startRun('active-run')
    expect(bus.getActiveRunId()).toBe('active-run')
  })

  it('multiple subscribers all receive events', () => {
    const bus = getEventBus()
    const h1 = vi.fn()
    const h2 = vi.fn()
    bus.on('phase:start', h1)
    bus.on('phase:start', h2)

    bus.emitEvent({ type: 'phase:start', phase: 'Verify', timestamp: Date.now() })

    expect(h1).toHaveBeenCalledTimes(1)
    expect(h2).toHaveBeenCalledTimes(1)
  })

  it('startRun clears previous run state', () => {
    const bus = getEventBus()
    bus.startRun('first')
    bus.startRun('second')
    expect(bus.getActiveRunId()).toBe('second')
  })

  /**
   * `error` 是**负载类型**，但它和 EventEmitter 的**崩溃通道**同名：Node 在无人订阅时让
   * `emit('error', …)` 抛 `ERR_UNHANDLED_ERROR`。headless 那条路径（`/workflow` 跑完就退出、
   * 没人挂进度视图）正好无人订阅 ⇒ 失败的 run 用 `Unhandled error. ({ type: 'error', … })`
   * 盖住了它自己的诊断。
   *
   * 判据两头都要钉：**无人订阅时不抛**（否则这条路径又回到「报错报成 Node 的模板」），
   * **有人订阅时照样送达**（否则这个事件类型就等于被删掉了）。
   */
  it('无人订阅时不抛 ERR_UNHANDLED_ERROR（error 是负载类型，不是崩溃通道）', () => {
    const bus = getEventBus()
    expect(bus.listenerCount('error')).toBe(0)
    expect(() => bus.emitEvent({ type: 'error', message: 'boom' })).not.toThrow()
  })

  it('有人订阅时 error 事件照常送达', () => {
    const bus = getEventBus()
    const handler = vi.fn()
    bus.on('error', handler)

    bus.emitEvent({ type: 'error', agentId: 'a1', message: 'provider exploded' })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0]![0].message).toBe('provider exploded')
  })
})
