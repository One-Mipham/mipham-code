import { Deduper, type DeduperState } from './dedup.js'
import { Hll, type HllState } from './hll.js'
import { OTHER } from './schema.js'
import type {
  NormalizedCrashEvent,
  NormalizedEvent,
  NormalizedSessionEvent,
  ValidationNotes,
} from './validate.js'

/**
 * Dimensional aggregation. Nothing here stores a value a client chose.
 *
 * Every dimension is either a closed set the collector owns (bucket names,
 * error classes, crash origins) or a bounded count of distinct keys that folds
 * into `__other__` once the bound is reached. No raw label, no free text, no
 * install id survives this file — the last one is fed to the HLL and dropped.
 *
 * The partition key is the **server's receipt day in UTC**, never the client's
 * `occurredAt`. That field is client-generated and may be arbitrarily old by
 * design (the queue survives restarts), so taking it as a partition would let
 * one client write into any day it liked. It survives only as an offset bucket.
 */

/** Largest distinct keys kept per dimension before folding into `__other__`. */
export const DIMENSION_CAPS = {
  appVersion: 64,
  runtime: 8,
  platform: 16,
  messageHash: 256,
} as const

export type DimensionCounts = Record<string, number>

export interface SessionDimensions {
  byAppVersion: DimensionCounts
  byRuntime: DimensionCounts
  byPlatform: DimensionCounts
  byOccurredOffset: DimensionCounts
  byDurationBucket: DimensionCounts
  byCrashed: DimensionCounts
  /** `family` or `family.label`, labels already resolved against the allowlist. */
  counters: DimensionCounts
}

export interface CrashDimensions {
  byAppVersion: DimensionCounts
  byRuntime: DimensionCounts
  byPlatform: DimensionCounts
  byOccurredOffset: DimensionCounts
  byErrorName: DimensionCounts
  byOrigin: DimensionCounts
  /**
   * `sha256(message)[0..16]` — the top-K of this table is the "which bug is
   * worth fixing" answer, and it carries no message text.
   */
  byMessageHash: DimensionCounts
  byFrameCountBucket: DimensionCounts
}

/**
 * What the collector observed about *itself* while handling traffic.
 *
 * Kept in the same file and reported beside the real rows (see `report.ts`)
 * because every one of these is a way the real rows can be wrong: an event
 * whose counters were folded, a field that was dropped, a rate-limited burst.
 * A table printed without them invites reading "zero" and "not counted"
 * as the same thing.
 */
export interface ServerCounters {
  /**
   * Bodies that reached the handler and parsed as JSON.
   *
   * "Parsed", not "accepted" — an array or a bare string parses and is then
   * refused, so subtracting `accepted` from this is what exposes traffic the
   * collector does not understand.
   */
  received: number
  /** Events aggregated (includes duplicates — they are counted, not dropped). */
  accepted: number
  /** Ids seen before. Counted, so a re-delivery still shows up as traffic. */
  duplicates: number
  /** Envelopes refused with 400, keyed by reason. */
  rejected: DimensionCounts
  /** `schemaVersion` absent or outside `SUPPORTED_SCHEMA_VERSIONS`. */
  unknownSchema: number
  /** `schemaVersion` present but not an integer. */
  malformedSchema: number
  /** `kind` well-formed but unrecognised. Accepted, never aggregated. */
  unknownKind: number
  /** A `Content-Type` that was neither JSON nor absent. Observed, never fatal. */
  contentTypeUnexpected: number
  /** Frame strings accepted on the wire and discarded at the boundary. */
  framesDiscarded: number
  /** Counter entries whose family was outside the five whitelisted names. */
  unknownFamilies: number
  /** Counter entries whose label was outside the allowlist, folded to `__other__`. */
  unknownLabels: number
  /** Payload keys no rule could use, keyed by field name. */
  fieldsDropped: DimensionCounts
  /** Counter values above `MAX_COUNTER_VALUE`, stored clamped. */
  countersClamped: number
  /** Requests whose `Host` was not the canonical one. Counted only — never refused. */
  hostMismatch: number
  /** Requests shed by the rate limiter (responded 503). */
  rateLimited: number
  /** Bodies refused before being read, because they exceeded `MAX_BODY_BYTES`. */
  bodyTooLarge: number
}

export interface Aggregate {
  /** Server receipt day, UTC, `YYYY-MM-DD`. */
  readonly day: string
  readonly server: ServerCounters
  readonly byKind: DimensionCounts
  readonly session: SessionDimensions
  readonly crash: CrashDimensions
  readonly installs: HllState
  readonly dedup: DeduperState
}

/** Offsets shorter than this are ordinary clock skew, not "the event is late". */
const SKEW_TOLERANCE_MS = 5 * 60 * 1000

export function emptyServerCounters(): ServerCounters {
  return {
    received: 0,
    accepted: 0,
    duplicates: 0,
    rejected: {},
    unknownSchema: 0,
    malformedSchema: 0,
    unknownKind: 0,
    contentTypeUnexpected: 0,
    framesDiscarded: 0,
    unknownFamilies: 0,
    unknownLabels: 0,
    fieldsDropped: {},
    countersClamped: 0,
    hostMismatch: 0,
    rateLimited: 0,
    bodyTooLarge: 0,
  }
}

/** `YYYY-MM-DD` in UTC. The partition key, and the only date this file stores. */
export function dayKey(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Bucket the client's `occurredAt` against the moment we received it.
 *
 * Coarse on purpose. A precise offset would be a quasi-identifier (it narrows
 * an event to a timezone, then to a moment), and nothing downstream needs it:
 * the partition is the receipt day, and all this has to answer is "was this
 * live or hours old, and is the client's clock right".
 */
export function offsetBucket(occurredAt: string | undefined, receivedAtMs: number): string {
  if (occurredAt === undefined) return 'invalid'
  const parsed = Date.parse(occurredAt)
  if (Number.isNaN(parsed)) return 'invalid'

  const offset = receivedAtMs - parsed
  if (offset < -SKEW_TOLERANCE_MS) return 'future'
  if (offset < 60_000) return '0'
  if (offset < 120_000) return '1'
  if (offset < 180_000) return '2'
  if (offset <= 7 * 24 * 60 * 60 * 1000) return '3_7'
  return 'gt_7'
}

/** Session length, log-ish buckets. `unknown` when the client omitted it. */
export function durationBucket(ms: number | undefined): string {
  if (ms === undefined) return 'unknown'
  if (ms === 0) return 'zero'
  if (ms < 60_000) return 'lt_1m'
  if (ms < 5 * 60_000) return '1_5m'
  if (ms < 30 * 60_000) return '5_30m'
  if (ms < 2 * 60 * 60_000) return '30m_2h'
  return 'gt_2h'
}

/** Stack depth when the crash was captured. `unknown` when omitted. */
export function frameCountBucket(count: number | undefined): string {
  if (count === undefined) return 'unknown'
  if (count === 0) return '0'
  if (count <= 5) return '1_5'
  if (count <= 10) return '6_10'
  if (count <= 15) return '11_15'
  return 'gt_15'
}

/**
 * Bump `key`, folding into `__other__` once `cap` distinct keys exist.
 *
 * The fold keeps the count and discards the name, which is the property that
 * matters: an attacker who floods a dimension cannot push genuine values out of
 * the table into a bucket nobody reads, because their values land in the same
 * bucket as everything else unrecognised, and the cap is per-day.
 */
function bump(counts: DimensionCounts, key: string, cap: number): void {
  if (counts[key] !== undefined) {
    counts[key]++
    return
  }
  const distinct = Object.keys(counts).length
  // `__other__` itself must not consume a slot, or a dimension at the cap would
  // permanently hold cap+1 keys and the count below would drift.
  const hasOther = counts[OTHER] !== undefined
  if (distinct - (hasOther ? 1 : 0) >= cap) {
    counts[OTHER] = (counts[OTHER] ?? 0) + 1
    return
  }
  counts[key] = 1
}

function emptySessionDimensions(): SessionDimensions {
  return {
    byAppVersion: {},
    byRuntime: {},
    byPlatform: {},
    byOccurredOffset: {},
    byDurationBucket: {},
    byCrashed: {},
    counters: {},
  }
}

function emptyCrashDimensions(): CrashDimensions {
  return {
    byAppVersion: {},
    byRuntime: {},
    byPlatform: {},
    byOccurredOffset: {},
    byErrorName: {},
    byOrigin: {},
    byMessageHash: {},
    byFrameCountBucket: {},
  }
}

export function emptyAggregate(day: string): Aggregate {
  return {
    day,
    server: emptyServerCounters(),
    byKind: {},
    session: emptySessionDimensions(),
    crash: emptyCrashDimensions(),
    installs: { registers: '' },
    dedup: { ids: [], evicted: 0 },
  }
}

/** Restore a mutable accumulator from a decoded daily file. */
export class Aggregator {
  readonly day: string
  server: ServerCounters
  byKind: DimensionCounts
  session: SessionDimensions
  crash: CrashDimensions
  #installs: Hll
  #deduper: Deduper

  constructor(day: string, state?: Aggregate) {
    this.day = day
    this.server = state ? { ...emptyServerCounters(), ...state.server } : emptyServerCounters()
    this.byKind = { ...(state?.byKind ?? {}) }
    this.session = { ...emptySessionDimensions(), ...(state?.session ?? {}) }
    this.crash = { ...emptyCrashDimensions(), ...(state?.crash ?? {}) }
    this.#installs = Hll.fromState(state?.installs)
    this.#deduper = Deduper.fromState(state?.dedup)
  }

  /** Observed on every request, accepted or not. */
  noteHostMismatch(): void {
    this.server.hostMismatch++
  }

  /**
   * A body that parsed as a JSON object, before it was validated.
   *
   * Counted here rather than in `record` because `record` only ever sees events
   * that already passed validation — counting there would make this identical to
   * `accepted` and hide exactly the number worth knowing: how much traffic
   * arrives and is then refused.
   */
  noteReceived(): void {
    this.server.received++
  }

  noteRateLimited(): void {
    this.server.rateLimited++
  }

  noteBodyTooLarge(): void {
    this.server.bodyTooLarge++
  }

  /** An envelope refused with 400. Nothing else is recorded — there is no event. */
  noteRejected(reason: string): void {
    this.server.rejected[reason] = (this.server.rejected[reason] ?? 0) + 1
  }

  /** Fold a `ValidationNotes` into the server counters. */
  noteObservations(notes: ValidationNotes): void {
    if (notes.unknownSchema) this.server.unknownSchema++
    if (notes.malformedSchema) this.server.malformedSchema++
    if (notes.unknownKind) this.server.unknownKind++
    if (notes.contentTypeUnexpected) this.server.contentTypeUnexpected++
    this.server.framesDiscarded += notes.framesDiscarded
    this.server.unknownFamilies += notes.unknownFamilies
    this.server.unknownLabels += notes.unknownLabels
    this.server.countersClamped += notes.countersClamped
    for (const field of notes.fieldsDropped) {
      this.server.fieldsDropped[field] = (this.server.fieldsDropped[field] ?? 0) + 1
    }
  }

  /**
   * Classify by id and aggregate.
   *
   * Returns `'duplicate'` when this id was definitely counted before. The caller
   * still responds 204 — a duplicate is a success from the client's side, and
   * saying anything else would make it retry forever.
   */
  record(event: NormalizedEvent, receivedAtMs: number): 'new' | 'duplicate' {
    const verdict = this.#deduper.check(event.id)
    // Aggregation happens for duplicates too. They are counted, not discarded:
    // dropping them would make a re-delivered event indistinguishable from one
    // that never arrived, which is the failure direction this design refuses.
    if (verdict === 'duplicate') this.server.duplicates++

    this.server.accepted++
    bump(this.byKind, event.kind, 4)
    if (event.installId !== undefined) this.#installs.add(event.installId)

    if (event.kind === 'session') this.#recordSession(event, receivedAtMs)
    else if (event.kind === 'crash') this.#recordCrash(event, receivedAtMs)
    // 'unknown': nothing to aggregate — the id is recorded and that is all.

    return verdict
  }

  #recordSession(event: NormalizedSessionEvent, receivedAtMs: number): void {
    const d = this.session
    if (event.appVersion !== undefined)
      bump(d.byAppVersion, event.appVersion, DIMENSION_CAPS.appVersion)
    if (event.runtime !== undefined) bump(d.byRuntime, event.runtime, DIMENSION_CAPS.runtime)
    if (event.platform !== undefined) bump(d.byPlatform, event.platform, DIMENSION_CAPS.platform)

    const offset = offsetBucket(event.occurredAt, receivedAtMs)
    d.byOccurredOffset[offset] = (d.byOccurredOffset[offset] ?? 0) + 1

    const duration = durationBucket(event.sessionDurationMs)
    d.byDurationBucket[duration] = (d.byDurationBucket[duration] ?? 0) + 1

    // Three states, not two: a client that never set the field is not the same
    // as one reporting a clean exit, and collapsing them would silently turn
    // "we do not know" into "no crash".
    const crashed = event.crashed === undefined ? 'unknown' : String(event.crashed)
    d.byCrashed[crashed] = (d.byCrashed[crashed] ?? 0) + 1

    // Values arrive already clamped by `normalizeCounters`, and the clamp is
    // counted there (it is a decision about the *body*, not about the day).
    for (const [key, value] of Object.entries(event.counters)) {
      d.counters[key] = (d.counters[key] ?? 0) + value
    }
  }

  #recordCrash(event: NormalizedCrashEvent, receivedAtMs: number): void {
    const d = this.crash
    if (event.appVersion !== undefined)
      bump(d.byAppVersion, event.appVersion, DIMENSION_CAPS.appVersion)
    if (event.runtime !== undefined) bump(d.byRuntime, event.runtime, DIMENSION_CAPS.runtime)
    if (event.platform !== undefined) bump(d.byPlatform, event.platform, DIMENSION_CAPS.platform)

    const offset = offsetBucket(event.occurredAt, receivedAtMs)
    d.byOccurredOffset[offset] = (d.byOccurredOffset[offset] ?? 0) + 1

    bump(d.byErrorName, event.errorName, 32)
    if (event.origin !== undefined) bump(d.byOrigin, event.origin, 8)
    if (event.messageHash !== undefined) {
      bump(d.byMessageHash, event.messageHash, DIMENSION_CAPS.messageHash)
    }
    const frames = frameCountBucket(event.frameCount)
    d.byFrameCountBucket[frames] = (d.byFrameCountBucket[frames] ?? 0) + 1
  }

  /** Distinct installs, estimated. Never exact — see `hll.ts`. */
  get estimatedInstalls(): number {
    return this.#installs.estimate()
  }

  toState(): Aggregate {
    return {
      day: this.day,
      server: this.server,
      byKind: this.byKind,
      session: this.session,
      crash: this.crash,
      installs: this.#installs.toState(),
      dedup: this.#deduper.toState(),
    }
  }
}

/** Sum two `DimensionCounts` maps, right into `into`. */
export function mergeCounts(into: DimensionCounts, from: DimensionCounts): void {
  for (const [key, value] of Object.entries(from)) {
    into[key] = (into[key] ?? 0) + value
  }
}

/**
 * Sum a day's dimensions into a running total, for the multi-day report.
 *
 * HLLs merge register-wise (max), which is the whole reason the sketch is
 * stored as registers rather than as a count: summing per-day estimates would
 * double-count an install active on two days.
 */
export function mergeInto(target: MutableAggregate, from: Aggregate): void {
  const s = target.server
  const f = from.server
  s.received += f.received
  s.accepted += f.accepted
  s.duplicates += f.duplicates
  s.unknownSchema += f.unknownSchema
  s.malformedSchema += f.malformedSchema
  s.unknownKind += f.unknownKind
  s.contentTypeUnexpected += f.contentTypeUnexpected
  s.framesDiscarded += f.framesDiscarded
  s.unknownFamilies += f.unknownFamilies
  s.unknownLabels += f.unknownLabels
  s.countersClamped += f.countersClamped
  s.hostMismatch += f.hostMismatch
  s.rateLimited += f.rateLimited
  s.bodyTooLarge += f.bodyTooLarge
  mergeCounts(s.rejected, f.rejected)
  mergeCounts(s.fieldsDropped, f.fieldsDropped)

  mergeCounts(target.byKind, from.byKind)
  for (const key of Object.keys(target.session) as (keyof SessionDimensions)[]) {
    mergeCounts(target.session[key], from.session[key])
  }
  for (const key of Object.keys(target.crash) as (keyof CrashDimensions)[]) {
    mergeCounts(target.crash[key], from.crash[key])
  }

  target.installs = mergeInstallStates(target.installs, from.installs)
}

export interface MutableAggregate {
  server: ServerCounters
  byKind: DimensionCounts
  session: SessionDimensions
  crash: CrashDimensions
  installs: HllState
}

export function emptyMutableAggregate(): MutableAggregate {
  return {
    server: emptyServerCounters(),
    byKind: {},
    session: emptySessionDimensions(),
    crash: emptyCrashDimensions(),
    installs: { registers: '' },
  }
}

/** Register-wise max of two sketches — the standard HLL union. */
export function mergeInstallStates(a: HllState, b: HllState): HllState {
  if (a.registers === '') return b
  if (b.registers === '') return a
  const left = Hll.fromState(a)
  left.mergeIn(Hll.fromState(b))
  return left.toState()
}

export function estimateInstalls(state: HllState): number {
  return Hll.fromState(state).estimate()
}
