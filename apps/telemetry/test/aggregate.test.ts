import { describe, expect, it } from 'vitest'
import { loadAllowlist } from '../src/allowlist.js'
import {
  Aggregator,
  DIMENSION_CAPS,
  dayKey,
  durationBucket,
  emptyAggregate,
  emptyMutableAggregate,
  estimateInstalls,
  frameCountBucket,
  mergeInstallStates,
  mergeInto,
  offsetBucket,
} from '../src/aggregate.js'
import { Hll } from '../src/hll.js'
import { OTHER } from '../src/schema.js'
import { validateEvent, type NormalizedEvent } from '../src/validate.js'
import { INSTALL_ID, SECOND_INSTALL_ID, crashEvent, sessionEvent } from './fixtures.js'

const ALLOWLIST = loadAllowlist()
const RECEIVED_AT = Date.parse('2026-09-15T12:00:00.000Z')

/** Normalise a fixture through the real boundary, as the server does. */
function normalized(event: unknown): NormalizedEvent {
  const result = validateEvent(event, ALLOWLIST)
  if (!result.ok) throw new Error(`fixture was rejected: ${result.reason}`)
  return result.event
}

function aggregator(): Aggregator {
  return new Aggregator('2026-09-15', emptyAggregate('2026-09-15'))
}

describe('the partition key is the receipt day, in UTC', () => {
  it('formats YYYY-MM-DD and rolls at UTC midnight, not local', () => {
    expect(dayKey(new Date('2026-09-15T00:00:00.000Z'))).toBe('2026-09-15')
    expect(dayKey(new Date('2026-09-15T23:59:59.999Z'))).toBe('2026-09-15')
    expect(dayKey(new Date('2026-09-16T00:00:00.000Z'))).toBe('2026-09-16')
  })
})

describe('occurredAt is a bounded offset, never a partition', () => {
  const at = (iso: string): string => offsetBucket(iso, RECEIVED_AT)

  it('buckets by how stale the event is', () => {
    expect(at('2026-09-15T12:00:00.000Z')).toBe('0')
    expect(at('2026-09-15T11:59:00.000Z')).toBe('1')
    expect(at('2026-09-15T11:57:30.000Z')).toBe('2')
    expect(at('2026-09-14T12:00:00.000Z')).toBe('3_7')
    expect(at('2026-09-01T12:00:00.000Z')).toBe('gt_7')
  })

  it('separates a wrong client clock from a merely late event', () => {
    // Within the skew tolerance a slightly-future stamp is ordinary clock skew.
    expect(at('2026-09-15T12:04:00.000Z')).toBe('0')
    expect(at('2026-09-15T13:00:00.000Z')).toBe('future')
  })

  it('has an invalid bucket, so an unparsable stamp is counted rather than dropped', () => {
    expect(offsetBucket(undefined, RECEIVED_AT)).toBe('invalid')
    expect(at('not a date')).toBe('invalid')
  })
})

describe('the remaining dimensions are closed sets', () => {
  it('buckets session duration', () => {
    expect(durationBucket(undefined)).toBe('unknown')
    expect(durationBucket(0)).toBe('zero')
    expect(durationBucket(59_999)).toBe('lt_1m')
    expect(durationBucket(60_000)).toBe('1_5m')
    expect(durationBucket(5 * 60_000)).toBe('5_30m')
    expect(durationBucket(30 * 60_000)).toBe('30m_2h')
    expect(durationBucket(2 * 60 * 60_000)).toBe('gt_2h')
  })

  it('buckets stack depth', () => {
    expect(frameCountBucket(undefined)).toBe('unknown')
    expect(frameCountBucket(0)).toBe('0')
    expect(frameCountBucket(5)).toBe('1_5')
    expect(frameCountBucket(10)).toBe('6_10')
    expect(frameCountBucket(15)).toBe('11_15')
    expect(frameCountBucket(16)).toBe('gt_15')
  })
})

describe('received counts traffic; accepted counts events', () => {
  it('are incremented by different layers, so the pair is informative', () => {
    const agg = aggregator()
    // `record` only ever sees events that already passed validation, so it must
    // not be the one counting bodies — otherwise the two are always equal and
    // "parsed but refused" is invisible.
    agg.record(normalized(sessionEvent()), RECEIVED_AT)
    expect(agg.server.received).toBe(0)
    expect(agg.server.accepted).toBe(1)

    agg.noteReceived()
    expect(agg.server.received).toBe(1)
  })
})

describe('record', () => {
  it('aggregates a session fixture into every dimension it carries', () => {
    const agg = aggregator()
    // A live event: stamped at the moment it was received.
    const event = normalized(sessionEvent({}, {}, new Date(RECEIVED_AT)))
    expect(agg.record(event, RECEIVED_AT)).toBe('new')

    expect(agg.server.accepted).toBe(1)
    expect(agg.server.duplicates).toBe(0)
    expect(agg.byKind.session).toBe(1)
    expect(agg.session.byAppVersion['0.81.6']).toBe(1)
    expect(agg.session.byRuntime['bun@1.2.3']).toBe(1)
    expect(agg.session.byPlatform['darwin/arm64']).toBe(1)
    expect(agg.session.byOccurredOffset['0']).toBe(1)
    expect(agg.session.byDurationBucket['1_5m']).toBe(1)
    expect(agg.session.byCrashed.false).toBe(1)
    expect(agg.session.counters['tool_calls.Read']).toBe(3)
    expect(agg.estimatedInstalls).toBe(1)
  })

  it('keeps "we do not know" distinct from "no crash"', () => {
    const agg = aggregator()
    agg.record(normalized(sessionEvent({ crashed: undefined })), RECEIVED_AT)
    agg.record(normalized(sessionEvent({ crashed: false }, { id: 'b' })), RECEIVED_AT)
    expect(agg.session.byCrashed).toEqual({ unknown: 1, false: 1 })
  })

  it('counts a duplicate, and counts it again in the dimensions', () => {
    const agg = aggregator()
    const event = normalized(sessionEvent())

    expect(agg.record(event, RECEIVED_AT)).toBe('new')
    expect(agg.record(event, RECEIVED_AT)).toBe('duplicate')

    // The duplicate is *visible* as traffic and as a re-count. Discarding it
    // would make it indistinguishable from an event that never arrived.
    expect(agg.server.accepted).toBe(2)
    expect(agg.server.duplicates).toBe(1)
    expect(agg.session.byPlatform['darwin/arm64']).toBe(2)
  })

  it('aggregates a crash fixture without touching the session dimensions', () => {
    const agg = aggregator()
    agg.record(normalized(crashEvent()), RECEIVED_AT)

    expect(agg.byKind.crash).toBe(1)
    expect(agg.byKind.session).toBeUndefined()
    expect(agg.crash.byErrorName.TypeError).toBe(1)
    expect(agg.crash.byOrigin.uncaughtException).toBe(1)
    expect(agg.crash.byMessageHash.a1b2c3d4e5f60718).toBe(1)
    expect(agg.crash.byFrameCountBucket['1_5']).toBe(1)
    expect(agg.session.counters).toEqual({})
  })

  it('records an unknown-kind event without aggregating it anywhere', () => {
    const agg = aggregator()
    const result = validateEvent({ id: 'u1', kind: 'future-kind', payload: {} }, ALLOWLIST)
    if (!result.ok) throw new Error('unexpected rejection')
    expect(agg.record(result.event, RECEIVED_AT)).toBe('new')

    // Keyed by the *normalised* kind, not the wire string: an unrecognised kind
    // is collapsed to `unknown` here so no downstream reader can mistake it for
    // a real one.
    expect(agg.byKind.unknown).toBe(1)
    expect(agg.session.byPlatform).toEqual({})
    expect(agg.crash.byErrorName).toEqual({})
    // Its id is still tracked, so a re-delivery is a duplicate.
    expect(agg.record(result.event, RECEIVED_AT)).toBe('duplicate')
  })

  it('feeds installId to the sketch and stores it nowhere', () => {
    const agg = aggregator()
    const snapshot = agg.toState()
    expect(JSON.stringify(snapshot)).not.toContain(INSTALL_ID)

    agg.record(normalized(sessionEvent()), RECEIVED_AT)
    expect(agg.estimatedInstalls).toBe(1)
    expect(JSON.stringify(agg.toState())).not.toContain(INSTALL_ID)
  })
})

describe('dimension caps fold rather than grow', () => {
  it('folds past the cap and keeps the count in __other__', () => {
    const agg = aggregator()
    const cap = DIMENSION_CAPS.runtime
    for (let i = 0; i < cap + 5; i++) {
      agg.record(normalized(sessionEvent({ runtime: `node@${i}` }, { id: `r${i}` })), RECEIVED_AT)
    }
    const runtime = agg.session.byRuntime
    // cap real keys plus the fold bucket, and nothing else.
    expect(Object.keys(runtime)).toHaveLength(cap + 1)
    expect(runtime[OTHER]).toBe(5)
  })

  it('does not let __other__ consume a slot of its own', () => {
    // If the fold bucket counted against the cap, a dimension at the cap would
    // hold cap+1 keys forever and every later value would fold one early.
    const agg = aggregator()
    const cap = DIMENSION_CAPS.platform
    for (let i = 0; i < cap + 3; i++) {
      agg.record(
        normalized(sessionEvent({ platform: `linux/arch${i}` }, { id: `p${i}` })),
        RECEIVED_AT,
      )
    }
    expect(Object.keys(agg.session.byPlatform)).toHaveLength(cap + 1)
    expect(agg.session.byPlatform[OTHER]).toBe(3)
  })
})

describe('merging days', () => {
  it('sums every counter and every dimension', () => {
    const a = aggregator()
    const b = new Aggregator('2026-09-16', emptyAggregate('2026-09-16'))
    a.record(normalized(sessionEvent()), RECEIVED_AT)
    b.record(normalized(crashEvent()), RECEIVED_AT)

    const merged = emptyMutableAggregate()
    mergeInto(merged, a.toState())
    mergeInto(merged, b.toState())

    expect(merged.server.accepted).toBe(2)
    expect(merged.byKind).toEqual({ session: 1, crash: 1 })
    expect(merged.session.byRuntime['bun@1.2.3']).toBe(1)
    expect(merged.crash.byErrorName.TypeError).toBe(1)
  })

  it('unions the sketches, so an install active on two days counts once', () => {
    const dayOne = aggregator()
    const dayTwo = new Aggregator('2026-09-16', emptyAggregate('2026-09-16'))
    dayOne.record(normalized(sessionEvent()), RECEIVED_AT)
    dayTwo.record(normalized(sessionEvent({}, { id: 'second' })), RECEIVED_AT)

    const merged = emptyMutableAggregate()
    mergeInto(merged, dayOne.toState())
    mergeInto(merged, dayTwo.toState())

    // Two events, one install. Summing per-day estimates would report 2.
    expect(merged.server.accepted).toBe(2)
    expect(estimateInstalls(merged.installs)).toBe(1)
  })

  it('merges a sketch into an empty one and back', () => {
    const sketch = new Hll()
    sketch.add(INSTALL_ID)
    sketch.add(SECOND_INSTALL_ID)
    const state = sketch.toState()

    expect(estimateInstalls(mergeInstallStates(state, { registers: '' }))).toBe(2)
    expect(estimateInstalls(mergeInstallStates({ registers: '' }, state))).toBe(2)
  })

  it('discards a corrupt sketch wholesale rather than partly applying it', () => {
    const sketch = new Hll()
    sketch.add('x')
    const truncated = { registers: sketch.toState().registers.slice(0, 8) }
    // A half-restored sketch silently underestimates; starting over is honest.
    expect(estimateInstalls(truncated)).toBe(0)
  })
})

describe('the distinct-install sketch is approximate but close', () => {
  it('estimates within a few percent up to a few thousand installs', () => {
    const sketch = new Hll()
    const truth = 3_000
    for (let i = 0; i < truth; i++) sketch.add(`install-${i}`)
    const estimate = sketch.estimate()
    expect(estimate).toBeGreaterThan(truth * 0.9)
    expect(estimate).toBeLessThan(truth * 1.1)
  })

  it('is exact for the small counts a new deployment sees', () => {
    const sketch = new Hll()
    for (let i = 0; i < 20; i++) sketch.add(`install-${i}`)
    expect(sketch.estimate()).toBe(20)
  })

  it('ignores an empty id, which would otherwise occupy a register', () => {
    const sketch = new Hll()
    sketch.add('')
    expect(sketch.estimate()).toBe(0)
  })
})
