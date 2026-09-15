import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getMetrics, resetMetrics } from '../../src/core/metrics'
import {
  SCHEMA_VERSION,
  COUNTER_WHITELIST,
  snapshotCounters,
  buildSessionEvent,
} from '../../src/telemetry/payload'

describe('telemetry payload — counter whitelist', () => {
  beforeEach(() => resetMetrics())
  afterEach(() => resetMetrics())

  it('reports unlabelled counters under a bare short name', () => {
    getMetrics().cliInvocations.inc()
    getMetrics().cliInvocations.inc()
    expect(snapshotCounters().cli_invocations).toBe(2)
  })

  it('reports labelled counters with the label value appended', () => {
    getMetrics().toolCalls.inc({ tool_name: 'Bash' })
    getMetrics().toolCalls.inc({ tool_name: 'Bash' })
    getMetrics().toolCalls.inc({ tool_name: 'Read' })
    const counters = snapshotCounters()
    expect(counters['tool_calls.Bash']).toBe(2)
    expect(counters['tool_calls.Read']).toBe(1)
  })

  it('reports slash commands', () => {
    getMetrics().commandCalls.inc({ command_name: '/telemetry' })
    expect(snapshotCounters()['command_calls./telemetry']).toBe(1)
  })

  it('emits ONLY whitelisted families, even when other counters moved', () => {
    // The load-bearing property: a counter added in a future version must not
    // be enrolled into the upload silently.
    const m = getMetrics()
    m.cliInvocations.inc()
    m.modelRequests.inc({ provider: 'anthropic' })
    m.modelRequestErrors.inc({ provider: 'anthropic' })
    m.crsiRuleDisables.inc()

    const keys = Object.keys(snapshotCounters())
    expect(keys).toContain('cli_invocations')
    expect(keys.join(' ')).not.toContain('model_request')
    expect(keys.join(' ')).not.toContain('crsi_rule_disables')
  })

  it('every emitted key traces back to a whitelisted family', () => {
    const m = getMetrics()
    m.cliInvocations.inc()
    m.commandCalls.inc({ command_name: '/help' })
    m.toolCalls.inc({ tool_name: 'Bash' })
    m.crsiRuleApplications.inc()
    m.sisInterceptions.inc()
    m.modelRequests.inc({ provider: 'openai' })

    const families = new Set(
      COUNTER_WHITELIST.map((f) => f.replace(/^mipham_code_/, '').replace(/_total$/, '')),
    )
    for (const key of Object.keys(snapshotCounters())) {
      expect(families.has(key.split('.')[0]!)).toBe(true)
    }
  })

  it('copes with a label value carrying the registry escape sequences', () => {
    getMetrics().toolCalls.inc({ tool_name: 'we"ird' })
    expect(snapshotCounters()['tool_calls.we"ird']).toBe(1)
  })
})

describe('telemetry payload — session event', () => {
  beforeEach(() => resetMetrics())
  afterEach(() => resetMetrics())

  const meta = { installId: 'id-1', startedAt: 1000, endedAt: 3500, crashed: false }

  it('carries the declared schema, identity and timing', () => {
    const event = buildSessionEvent(meta, new Date('2026-09-15T00:00:00.000Z'))
    expect(event.kind).toBe('session')
    expect(event.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(event.payload).toMatchObject({
      installId: 'id-1',
      schemaVersion: SCHEMA_VERSION,
      occurredAt: '2026-09-15T00:00:00.000Z',
      sessionDurationMs: 2500,
      crashed: false,
    })
  })

  it('reports version, runtime and platform — no hostname', () => {
    const { payload } = buildSessionEvent(meta)
    expect(payload.appVersion).toMatch(/^\d+\.\d+\.\d+/)
    expect(payload.runtime).toMatch(/^(node|bun)@/)
    expect(payload.platform).toMatch(/^[a-z0-9]+\/[a-z0-9]+$/)
  })

  it('never reports a negative duration when the clock steps backwards', () => {
    const { payload } = buildSessionEvent({ ...meta, startedAt: 5000, endedAt: 1000 })
    expect(payload.sessionDurationMs).toBe(0)
  })

  it('records whether the session crashed', () => {
    expect(buildSessionEvent({ ...meta, crashed: true }).payload.crashed).toBe(true)
  })

  it('emits exactly the documented top-level fields', () => {
    // Locks the data dictionary to the code — docs/telemetry.md describes these
    // keys, and adding one here without a doc change should be a deliberate act.
    expect(Object.keys(buildSessionEvent(meta).payload).sort()).toEqual([
      'appVersion',
      'counters',
      'crashed',
      'installId',
      'occurredAt',
      'platform',
      'runtime',
      'schemaVersion',
      'sessionDurationMs',
    ])
  })
})
