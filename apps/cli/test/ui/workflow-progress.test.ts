import { describe, it, expect, beforeEach } from 'vitest'
import { getEventBus, WorkflowEventBus } from '../../src/workflow/event-bus.js'

// We test the state-tracking logic, not the Ink rendering
// (Ink component testing requires a TTY, so we test the data layer)
describe('WorkflowProgress state', () => {
  let bus: WorkflowEventBus

  beforeEach(() => {
    bus = getEventBus()
    ;(bus as any).activeRunId = null
    bus.removeAllListeners()
  })

  it('builds agent status map from events', () => {
    const agents = new Map<
      string,
      { label: string; phase: string; status: 'running' | 'done' | 'failed'; durationMs: number }
    >()

    bus.on('agent:start', (e) => {
      agents.set(e.agentId, { label: e.label, phase: e.phase, status: 'running', durationMs: 0 })
    })
    bus.on('agent:end', (e) => {
      const a = agents.get(e.agentId)
      if (a) {
        a.status = e.success ? 'done' : 'failed'
        a.durationMs = e.durationMs
      }
    })

    bus.startRun('test')
    bus.emitEvent({ type: 'agent:start', agentId: 'a1', label: 'grep', phase: 'Scan' })
    bus.emitEvent({ type: 'agent:start', agentId: 'a2', label: 'lint', phase: 'Scan' })
    bus.emitEvent({
      type: 'agent:end',
      agentId: 'a1',
      label: 'grep',
      success: true,
      durationMs: 1200,
    })

    expect(agents.get('a1')!.status).toBe('done')
    expect(agents.get('a1')!.durationMs).toBe(1200)
    expect(agents.get('a2')!.status).toBe('running')
  })

  it('tracks phases in order', () => {
    const phases: string[] = []

    bus.on('phase:start', (e) => {
      phases.push(e.phase)
    })

    bus.startRun('test')
    bus.emitEvent({ type: 'phase:start', phase: 'Scan', timestamp: Date.now() })
    bus.emitEvent({ type: 'phase:start', phase: 'Verify', timestamp: Date.now() })

    expect(phases).toEqual(['Scan', 'Verify'])
  })

  it('detects done event and marks all complete', () => {
    let done = false
    bus.on('done', () => {
      done = true
    })

    bus.startRun('test')
    bus.emitEvent({ type: 'done', runId: 'test', totalAgents: 3, cacheHits: 1 })

    expect(done).toBe(true)
  })
})
