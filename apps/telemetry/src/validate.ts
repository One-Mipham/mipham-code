import {
  COUNTER_FAMILIES,
  CRASH_ORIGINS,
  ERROR_NAMES,
  EVENT_KINDS,
  JSON_CONTENT_TYPE_PATTERN,
  MAX_BODY_BYTES,
  MAX_COUNTER_VALUE,
  MAX_DIMENSION_LENGTH,
  MCP_TOOL_PREFIX,
  MESSAGE_HASH_PATTERN,
  OTHER,
  OTHER_MCP,
  PLATFORM_PATTERN,
  RUNTIME_PATTERN,
  SUPPORTED_SCHEMA_VERSIONS,
  type CrashOrigin,
  type EventKind,
} from './schema.js'

/**
 * Envelope parsing and field-level normalisation.
 *
 * The governing rule: **a 400 is a button that destroys data.** The client treats
 * every 4xx as permanent and deletes the event (`transport.ts:58`), and it never
 * reports that it did so. So a field this collector merely fails to recognise
 * must never be grounds for rejection — it is dropped, counted, and the rest of
 * the event is aggregated. Only a malformed *envelope* (unparsable, not an
 * object, no id, no kind) is a 400, because those cannot participate in
 * deduplication or aggregation at all.
 *
 * Two things are deliberately *not* checked, each for the same reason:
 *
 *   - `Content-Type`. Rejecting a non-JSON content type would be a 415, which is
 *     a 4xx, which is silent permanent loss — in exchange for nothing, since we
 *     are about to `JSON.parse` the body regardless.
 *   - `schemaVersion`. The collector always deploys behind the client. Rejecting
 *     a version we have not seen would erase every event from every user running
 *     a newer CLI, for as long as the deploy lagged. Unknown versions are counted
 *     and aggregated by the fields we do recognise.
 */

/** Reasons an envelope is rejected outright, each mapping to HTTP 400. */
export type RejectReason = 'not-json' | 'not-object' | 'missing-id' | 'missing-kind'

/** Observations the caller turns into server-side counters. */
export interface ValidationNotes {
  /** `schemaVersion` was absent or outside `SUPPORTED_SCHEMA_VERSIONS`. */
  unknownSchema: boolean
  /** `schemaVersion` was present but not an integer. */
  malformedSchema: boolean
  /** `kind` was a well-formed string outside `EVENT_KINDS`. Not a rejection. */
  unknownKind: boolean
  /** Body arrived with a `Content-Type` that was neither JSON nor absent. */
  contentTypeUnexpected: boolean
  /** Frame strings accepted on the wire and discarded here, never stored. */
  framesDiscarded: number
  /** Counter entries whose family is outside `COUNTER_FAMILIES`. */
  unknownFamilies: number
  /** Counter entries whose label is outside the allowlist. */
  unknownLabels: number
  /** Keys of the payload object that no rule above could use. */
  fieldsDropped: string[]
  /** Counter values that arrived above `MAX_COUNTER_VALUE` and were stored clamped. */
  countersClamped: number
}

export interface NormalizedSessionEvent {
  kind: 'session'
  id: string
  /**
   * Used for the distinct-install estimate and for nothing else.
   *
   * It is never written to a dimension, never persisted, and
   * `test/privacy.test.ts` greps the decrypted aggregate for it. It survives
   * this boundary only because the HLL sketch must be fed from somewhere.
   */
  installId: string | undefined
  schemaVersion: number | undefined
  occurredAt: string | undefined
  appVersion: string | undefined
  runtime: string | undefined
  platform: string | undefined
  sessionDurationMs: number | undefined
  crashed: boolean | undefined
  counters: Record<string, number>
}

export interface NormalizedCrashEvent {
  kind: 'crash'
  id: string
  /** See `NormalizedSessionEvent.installId`. */
  installId: string | undefined
  schemaVersion: number | undefined
  occurredAt: string | undefined
  appVersion: string | undefined
  runtime: string | undefined
  platform: string | undefined
  errorName: string
  messageHash: string | undefined
  frameCount: number | undefined
  origin: CrashOrigin | undefined
  /**
   * No `stackFrames` field, deliberately.
   *
   * The client sends them; this boundary is where they stop. "Dimensional
   * aggregates only" means a frame string has nowhere to live, so accepting it
   * further would only create the false impression that it is being collected.
   * The count of what was discarded is reported instead.
   */
}

/**
 * An event whose `kind` we do not recognise.
 *
 * Carries an id so it still participates in deduplication, and nothing else —
 * there is no dimension it could contribute to. It exists as a distinct variant
 * rather than being coerced into `session` so that no downstream code can
 * accidentally aggregate it as one.
 */
export interface NormalizedUnknownEvent {
  kind: 'unknown'
  id: string
  installId: string | undefined
}

export type NormalizedEvent = NormalizedSessionEvent | NormalizedCrashEvent | NormalizedUnknownEvent

export type ValidationResult =
  { ok: true; event: NormalizedEvent; notes: ValidationNotes } | { ok: false; reason: RejectReason }

export function emptyNotes(): ValidationNotes {
  return {
    unknownSchema: false,
    malformedSchema: false,
    unknownKind: false,
    contentTypeUnexpected: false,
    framesDiscarded: 0,
    unknownFamilies: 0,
    unknownLabels: 0,
    fieldsDropped: [],
    countersClamped: 0,
  }
}

/** Parse the raw body. `/^\s*[{[]/` is not used — `JSON.parse` is the only oracle. */
export function parseBody(raw: string): { ok: true; value: unknown } | { ok: false } {
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown }
  } catch {
    return { ok: false }
  }
}

/** A non-empty string, truncated to `max`. Anything else is `undefined`. */
function asString(value: unknown, max = MAX_DIMENSION_LENGTH): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.length > max ? value.slice(0, max) : value
}

/**
 * A finite non-negative integer, or `undefined`.
 *
 * Not clamped here: clamping is a *value* decision (it changes what is stored)
 * and belongs with the aggregation, which is also where the clamp counter lives.
 * This only rejects shapes that cannot be a count at all.
 */
function asCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined
  return value
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

/**
 * A closed-set membership test that folds rather than rejects.
 *
 * Returns `undefined` for anything not in the set, so the caller records a drop.
 * The set must be closed *by construction* — every caller below passes a literal
 * list, never a client-supplied value.
 */
function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  const s = asString(value)
  if (s === undefined) return undefined
  return (allowed as readonly string[]).includes(s) ? (s as T) : undefined
}

/**
 * Normalise the `counters` map into `family` / `family.label` keys.
 *
 * Two independent bounds, and the second is the one that matters:
 *
 *   - the **family** must be one of the five whitelisted names. A client can
 *     only ever produce those five, so this is a closed set on both sides.
 *   - the **label** is *not* closed on the client. `command_calls` is keyed by
 *     whatever the user typed at the prompt (`parseSlashCommand` lowercases
 *     arbitrary input, and `recordCommand` runs before any registry lookup), so
 *     an unpatched client can mint a new key per keystroke-mistake. Labels are
 *     therefore resolved against `allowedLabels` and folded to `__other__` when
 *     absent — never stored under their own name, however they arrive.
 *
 * Folding to `__other__` keeps the *count* while discarding the *name*, which is
 * what makes an allowlist strictly better than a numeric cardinality cap: a cap
 * can be filled by an attacker, pushing genuine labels into the overflow bucket
 * and poisoning exactly the data the dead-code review votes on.
 */
function normalizeCounters(
  value: unknown,
  allowedLabels: ReadonlyMap<string, ReadonlySet<string>>,
  notes: ValidationNotes,
): Record<string, number> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    if (value !== undefined) notes.fieldsDropped.push('counters')
    return {}
  }

  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    const dot = key.indexOf('.')
    const family = dot === -1 ? key : key.slice(0, dot)
    const label = dot === -1 ? '' : key.slice(dot + 1)

    if (!(COUNTER_FAMILIES as readonly string[]).includes(family)) {
      notes.unknownFamilies++
      continue
    }

    let resolvedLabel = label
    if (label !== '') {
      const allowed = allowedLabels.get(family)
      if (!allowed || !allowed.has(label)) {
        notes.unknownLabels++
        // MCP tool names cannot be allowlisted (see OTHER_MCP) but are expected
        // traffic, so they get a reserved bucket rather than polluting the one
        // bucket whose whole purpose is to mean "unrecognised".
        resolvedLabel =
          family === 'tool_calls' && label.startsWith(MCP_TOOL_PREFIX) ? OTHER_MCP : OTHER
      }
    }

    const count = asCount(raw)
    if (count === undefined) {
      notes.fieldsDropped.push(`counters.${family}`)
      continue
    }
    // Zero is skipped rather than stored: every counter family is a cumulative
    // total, so a zero row carries no information and only adds file size.
    if (count === 0) continue

    const outKey = resolvedLabel ? `${family}.${resolvedLabel}` : family
    const sum = (out[outKey] ?? 0) + count
    if (count > MAX_COUNTER_VALUE) notes.countersClamped++
    out[outKey] = Math.min(sum, MAX_COUNTER_VALUE)
  }
  return out
}

/** Shared normalisation of the six fields both event kinds carry. */
function normalizeCommon(payload: Record<string, unknown>, notes: ValidationNotes) {
  const rawSchema = payload.schemaVersion
  let schemaVersion: number | undefined
  if (typeof rawSchema === 'number' && Number.isSafeInteger(rawSchema)) {
    schemaVersion = rawSchema
    if (!SUPPORTED_SCHEMA_VERSIONS.includes(rawSchema)) notes.unknownSchema = true
  } else if (rawSchema !== undefined) {
    notes.malformedSchema = true
  } else {
    notes.unknownSchema = true
  }

  const runtimeRaw = asString(payload.runtime)
  const runtime =
    runtimeRaw !== undefined && RUNTIME_PATTERN.test(runtimeRaw) ? runtimeRaw : undefined
  if (runtimeRaw !== undefined && runtime === undefined) notes.fieldsDropped.push('runtime')

  const platformRaw = asString(payload.platform)
  const platform =
    platformRaw !== undefined && PLATFORM_PATTERN.test(platformRaw) ? platformRaw : undefined
  if (platformRaw !== undefined && platform === undefined) notes.fieldsDropped.push('platform')

  return {
    installId: asString(payload.installId, 64),
    schemaVersion,
    // Kept raw, not parsed: the offset bucket depends on the *receipt* time,
    // which is not known here, and an unparsable value is a bucket ('invalid')
    // rather than a drop.
    occurredAt: asString(payload.occurredAt, 40),
    appVersion: asString(payload.appVersion, 32),
    runtime,
    platform,
  }
}

/**
 * Validate and normalise one event body.
 *
 * `contentType` is passed only to *observe* it (`contentTypeUnexpected`); it can
 * never cause a rejection. `allowedLabels` is the server-side allowlist.
 */
export function validateEvent(
  value: unknown,
  allowedLabels: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
  contentType?: string | undefined,
): ValidationResult {
  const notes = emptyNotes()

  if (
    contentType !== undefined &&
    contentType !== '' &&
    !JSON_CONTENT_TYPE_PATTERN.test(contentType)
  ) {
    notes.contentTypeUnexpected = true
  }

  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'not-object' }
  }

  const envelope = value as Record<string, unknown>

  const id = asString(envelope.id, 64)
  if (id === undefined) return { ok: false, reason: 'missing-id' }

  const kindRaw = asString(envelope.kind, 32)
  if (kindRaw === undefined) return { ok: false, reason: 'missing-kind' }

  // A well-formed kind we do not recognise is *not* a 400. See the module
  // comment: rejecting it would erase events from a newer client permanently,
  // and it would buy nothing, since a 4xx and a 204 are indistinguishable to
  // the client (both ack and delete). Counting it keeps the signal.
  const payloadIsObject =
    envelope.payload !== null &&
    typeof envelope.payload === 'object' &&
    !Array.isArray(envelope.payload)
  if (envelope.payload !== undefined && !payloadIsObject) {
    notes.fieldsDropped.push('payload')
  }
  const payload = payloadIsObject ? (envelope.payload as Record<string, unknown>) : {}

  if (!(EVENT_KINDS as readonly string[]).includes(kindRaw)) {
    notes.unknownKind = true
    return {
      ok: true,
      notes,
      event: { kind: 'unknown', id, installId: asString(payload.installId, 64) },
    }
  }

  const kind = kindRaw as EventKind
  const common = normalizeCommon(payload, notes)

  if (kind === 'crash') {
    const frames = payload.stackFrames
    notes.framesDiscarded = Array.isArray(frames) ? frames.length : 0

    return {
      ok: true,
      notes,
      event: {
        kind: 'crash',
        id,
        ...common,
        // The client always sets an error name, so absence is a client bug
        // rather than attacker input; folding it keeps the dimension bounded
        // either way.
        errorName: oneOf(payload.errorName, ERROR_NAMES) ?? OTHER,
        messageHash:
          typeof payload.messageHash === 'string' && MESSAGE_HASH_PATTERN.test(payload.messageHash)
            ? payload.messageHash
            : undefined,
        frameCount: asCount(payload.frameCount),
        origin: oneOf(payload.origin, CRASH_ORIGINS),
      },
    }
  }

  return {
    ok: true,
    notes,
    event: {
      kind: 'session',
      id,
      ...common,
      sessionDurationMs: asCount(payload.sessionDurationMs),
      crashed: asBoolean(payload.crashed),
      counters: normalizeCounters(payload.counters, allowedLabels, notes),
    },
  }
}
