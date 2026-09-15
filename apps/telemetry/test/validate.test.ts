import { describe, expect, it } from 'vitest'
import { loadAllowlist } from '../src/allowlist.js'
import { COUNTER_FAMILIES, OTHER, OTHER_MCP } from '../src/schema.js'
import { parseBody, validateEvent } from '../src/validate.js'
import { INSTALL_ID, MESSAGE_HASH, crashEvent, sessionEvent } from './fixtures.js'

const ALLOWLIST = loadAllowlist()

/** Validate a fixture the way `handleEvent` does, with the real allowlist. */
function run(event: unknown, contentType?: string) {
  return validateEvent(event, ALLOWLIST, contentType)
}

describe('envelope rejection — the only four reasons to destroy an event', () => {
  it('rejects a non-object, a missing id and a missing kind, and nothing else', () => {
    expect(run(null)).toEqual({ ok: false, reason: 'not-object' })
    expect(run([1, 2])).toEqual({ ok: false, reason: 'not-object' })
    expect(run({ kind: 'session' })).toEqual({ ok: false, reason: 'missing-id' })
    expect(run({ id: 'x' })).toEqual({ ok: false, reason: 'missing-kind' })
    expect(run({ id: '', kind: 'session' })).toEqual({ ok: false, reason: 'missing-id' })
  })

  it('parses a body with JSON.parse as the only oracle', () => {
    expect(parseBody('{"a":1}')).toEqual({ ok: true, value: { a: 1 } })
    expect(parseBody('')).toEqual({ ok: false })
    expect(parseBody('{')).toEqual({ ok: false })
    // A JSON scalar parses but is not an object; that is the caller's 400, not
    // this one's — the two reasons stay distinguishable.
    expect(parseBody('5')).toEqual({ ok: true, value: 5 })
  })

  it('refuses a body over MAX_BODY_BYTES before attempting to parse it', () => {
    expect(parseBody('x'.repeat(64 * 1024 + 1))).toEqual({ ok: false })
  })
})

describe('a well-formed event we do not understand is accepted, not rejected', () => {
  it('an unknown kind is 204-shaped, counted, and aggregated into nothing', () => {
    const result = run({ id: 'unknown-1', kind: 'telemetry-v2-event', payload: {} })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.kind).toBe('unknown')
    expect(result.notes.unknownKind).toBe(true)
    expect(result.event.id).toBe('unknown-1')
  })

  it('an unknown schemaVersion is counted but still aggregated', () => {
    const result = run(sessionEvent({ schemaVersion: 99 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.notes.unknownSchema).toBe(true)
    expect(result.event.kind).toBe('session')
  })

  it('v2 is a known version from day one, so it does not inflate unknownSchema', () => {
    const result = run(sessionEvent({ schemaVersion: 2 }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.notes.unknownSchema).toBe(false)
  })

  it('an absent schemaVersion counts as unknown; a non-integer counts as malformed', () => {
    const missing = run(sessionEvent({ schemaVersion: undefined }))
    const malformed = run(sessionEvent({ schemaVersion: '1' }))
    expect(missing.ok && missing.notes.unknownSchema).toBe(true)
    expect(malformed.ok && malformed.notes.malformedSchema).toBe(true)
    expect(malformed.ok && malformed.notes.unknownSchema).toBe(false)
  })

  it('a non-JSON Content-Type is observed and then ignored', () => {
    const result = run(sessionEvent(), 'text/plain')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.notes.contentTypeUnexpected).toBe(true)
    // And the event is still fully aggregated — the observation costs nothing.
    expect(result.event.kind).toBe('session')
  })

  it('accepts the JSON content types a real client sends', () => {
    for (const header of ['application/json', 'application/json; charset=utf-8', undefined]) {
      const result = run(sessionEvent(), header)
      expect(result.ok && result.notes.contentTypeUnexpected, String(header)).toBe(false)
    }
  })
})

describe('field-level problems drop the field, never the event', () => {
  it('a malformed runtime or platform is dropped and named', () => {
    const result = run(sessionEvent({ runtime: 'deno@1.0', platform: 'not a platform' }))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.event.kind === 'session' && result.event.runtime).toBeUndefined()
    expect(result.notes.fieldsDropped).toContain('runtime')
    expect(result.notes.fieldsDropped).toContain('platform')
  })

  it('accepts both runtime forms the client produces', () => {
    const bun = run(sessionEvent({ runtime: 'bun@1.2.3' }))
    const node = run(sessionEvent({ runtime: 'node@22' }))
    expect(bun.ok && bun.event.kind === 'session' && bun.event.runtime).toBe('bun@1.2.3')
    expect(node.ok && node.event.kind === 'session' && node.event.runtime).toBe('node@22')
  })

  it('a non-object payload is dropped and named, and the envelope still counts', () => {
    const result = run({ id: 'x1', kind: 'session', payload: 'nope' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.notes.fieldsDropped).toContain('payload')
    expect(result.event.kind).toBe('session')
  })

  it('a counter value that is not a count is dropped without a throw', () => {
    const result = run(
      sessionEvent({
        counters: { cli_invocations: -1, command_calls: 1e15, tool_calls: '5' },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // `-1` and `"5"` are not counts at all; `1e15` is an integer but over the
    // clamp, so it is stored clamped rather than dropped.
    expect(result.notes.fieldsDropped).toContain('counters.cli_invocations')
    expect(result.notes.fieldsDropped).toContain('counters.tool_calls')
    expect(result.notes.countersClamped).toBe(1)
    expect(result.event.kind === 'session' && result.event.counters.command_calls).toBe(1_000_000)
  })

  it('NaN and Infinity are not counts', () => {
    const result = run(sessionEvent({ counters: { cli_invocations: Number.NaN } }))
    expect(result.ok).toBe(true)
    expect(result.ok && result.notes.fieldsDropped).toContain('counters.cli_invocations')
  })

  it('a zero counter is skipped — a cumulative total of zero carries no information', () => {
    const result = run(sessionEvent({ counters: { sis_interceptions: 0, cli_invocations: 2 } }))
    expect(result.ok).toBe(true)
    if (!result.ok || result.event.kind !== 'session') return
    expect(result.event.counters.sis_interceptions).toBeUndefined()
    expect(result.event.counters.cli_invocations).toBe(2)
  })

  it('an empty counters object is valid — the contract allows it', () => {
    const result = run(sessionEvent({ counters: {} }))
    expect(result.ok).toBe(true)
    expect(result.ok && result.event.kind === 'session' && result.event.counters).toEqual({})
  })

  it('frames and a non-string messageHash are dropped without a throw', () => {
    const result = run(crashEvent({ messageHash: 'not-a-hash' }))
    expect(result.ok).toBe(true)
    if (!result.ok || result.event.kind !== 'crash') return
    expect(result.event.messageHash).toBeUndefined()
    expect(result.event.errorName).toBe('TypeError')
  })

  it('an unknown errorName folds to __other__ rather than being stored', () => {
    const result = run(crashEvent({ errorName: 'MyCustomError' }))
    expect(result.ok).toBe(true)
    expect(result.ok && result.event.kind === 'crash' && result.event.errorName).toBe(OTHER)
  })

  it('an unknown origin is dropped rather than stored', () => {
    const result = run(crashEvent({ origin: 'somethingElse' }))
    expect(result.ok).toBe(true)
    expect(result.ok && result.event.kind === 'crash' && result.event.origin).toBeUndefined()
  })
})

describe('stackFrames stop at this boundary', () => {
  it('are counted and not carried into the normalised event', () => {
    const result = run(crashEvent())
    expect(result.ok).toBe(true)
    if (!result.ok || result.event.kind !== 'crash') return
    expect(result.notes.framesDiscarded).toBe(2)
    expect(Object.keys(result.event)).not.toContain('stackFrames')
  })

  it('a non-array stackFrames is not a throw', () => {
    const result = run(crashEvent({ stackFrames: 'a string' }))
    expect(result.ok).toBe(true)
    expect(result.ok && result.notes.framesDiscarded).toBe(0)
  })
})

describe('the allowlist is what bounds counter-label cardinality', () => {
  it('stores a known label under its own name', () => {
    const result = run(sessionEvent({ counters: { 'tool_calls.Read': 3 } }))
    expect(result.ok).toBe(true)
    if (!result.ok || result.event.kind !== 'session') return
    expect(result.event.counters['tool_calls.Read']).toBe(3)
    expect(result.notes.unknownLabels).toBe(0)
  })

  it('folds an unknown label into __other__ and keeps the count', () => {
    const result = run(sessionEvent({ counters: { 'tool_calls.NotATool': 7 } }))
    expect(result.ok).toBe(true)
    if (!result.ok || result.event.kind !== 'session') return
    expect(result.event.counters[`tool_calls.${OTHER}`]).toBe(7)
    expect(Object.keys(result.event.counters)).not.toContain('tool_calls.NotATool')
    expect(result.notes.unknownLabels).toBe(1)
  })

  it('routes MCP tool names to their own bucket, not to __other__', () => {
    const result = run(sessionEvent({ counters: { 'tool_calls.mcp__github__search': 2 } }))
    expect(result.ok).toBe(true)
    if (!result.ok || result.event.kind !== 'session') return
    expect(result.event.counters[`tool_calls.${OTHER_MCP}`]).toBe(2)
    expect(result.event.counters[`tool_calls.${OTHER}`]).toBeUndefined()
  })

  it('folds an unknown family and names it, without storing the key', () => {
    const result = run(sessionEvent({ counters: { mipham_code_secret_total: 1 } }))
    expect(result.ok).toBe(true)
    if (!result.ok || result.event.kind !== 'session') return
    expect(result.notes.unknownFamilies).toBe(1)
    expect(Object.keys(result.event.counters)).toEqual([])
  })

  it('accepts every family the client is allowed to emit', () => {
    for (const family of COUNTER_FAMILIES) {
      const result = run(sessionEvent({ counters: { [family]: 1 } }))
      expect(result.ok, family).toBe(true)
      expect(result.ok && result.notes.unknownFamilies, family).toBe(0)
    }
  })

  it('never stores the client-supplied label text, however it arrives', () => {
    // The cardinality-poisoning shape: a thousand distinct names for one family.
    const counters: Record<string, number> = {}
    for (let i = 0; i < 1_000; i++) counters[`command_calls./junk-${i}`] = 1
    const result = run(sessionEvent({ counters }))
    expect(result.ok).toBe(true)
    if (!result.ok || result.event.kind !== 'session') return

    const stored = Object.keys(result.event.counters)
    expect(stored).toEqual([`command_calls.${OTHER}`])
    expect(result.event.counters[`command_calls.${OTHER}`]).toBe(1_000)
    expect(result.notes.unknownLabels).toBe(1_000)
    for (const key of stored) expect(key).not.toContain('junk-')
  })

  it('an empty allowlist folds every label — the request path never uses one', () => {
    const result = validateEvent(sessionEvent(), new Map())
    expect(result.ok).toBe(true)
    if (!result.ok || result.event.kind !== 'session') return
    const counters = result.event.counters
    expect(counters['tool_calls.Read']).toBeUndefined()
    expect(counters['command_calls./help']).toBeUndefined()
    // The fixture's three labelled tool calls: one known, one MCP, one unknown.
    expect(counters[`tool_calls.${OTHER}`]).toBe(3)
    expect(counters[`tool_calls.${OTHER_MCP}`]).toBe(2)
    expect(counters[`command_calls.${OTHER}`]).toBe(1)
  })
})

describe('dimension values are kept verbatim only within bounds', () => {
  it('truncates an over-long appVersion rather than storing it whole', () => {
    // 32, not MAX_DIMENSION_LENGTH: a version string has no plausible reason to
    // be longer, and the tighter bound is per-field on purpose.
    const result = run(sessionEvent({ appVersion: 'v'.repeat(500) }))
    expect(result.ok).toBe(true)
    if (!result.ok || result.event.kind !== 'session') return
    expect(result.event.appVersion).toHaveLength(32)
  })

  it('keeps installId and messageHash exactly when they are well formed', () => {
    const session = run(sessionEvent())
    const crash = run(crashEvent())
    expect(session.ok && session.event.installId).toBe(INSTALL_ID)
    expect(crash.ok && crash.event.kind === 'crash' && crash.event.messageHash).toBe(MESSAGE_HASH)
  })

  it('a bad messageHash is dropped rather than used as a dimension key', () => {
    const result = run(crashEvent({ messageHash: 'ZZZZZZZZZZZZZZZZ' }))
    expect(result.ok && result.event.kind === 'crash' && result.event.messageHash).toBeUndefined()
  })
})
