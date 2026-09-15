import { randomUUID } from 'node:crypto'
import { getMetrics } from '../core/metrics'
import { PACKAGE_VERSION } from '../shared/package-info'
import type { QueuedEvent } from './queue'
import { runtimeTag } from './redact'

/**
 * Payload construction.
 *
 * The counters are a **whitelist, not a whole-registry dump**. A dump would
 * silently enrol every future counter into the uploaded payload, and a future
 * counter's labels may well carry PII. A whitelist is explicit, can be written
 * into the public data dictionary, and can be locked down by a test asserting
 * the emitted key set is a subset of it.
 *
 * See `docs/telemetry.md` for the public data dictionary.
 */

/** Bumped whenever the payload shape changes, so the endpoint can evolve. */
export const SCHEMA_VERSION = 1

/**
 * Counter family names cleared for upload, as they appear in the registry.
 * Adding to this list is a privacy decision — it must be matched by a
 * data-dictionary entry in the same commit.
 */
export const COUNTER_WHITELIST = [
  'mipham_code_cli_invocations_total',
  'mipham_code_command_calls_total',
  'mipham_code_tool_calls_total',
  'mipham_code_crsi_rule_applications_total',
  'mipham_code_sis_interceptions_total',
] as const

/** Maximum length of a label value kept in the payload. */
const MAX_LABEL_LENGTH = 64

/** `Counter.toJSON()` reports `object`; this is the shape it actually returns. */
interface CounterJson {
  name: string
  series: { labels: string; value: number }[]
}

/**
 * Pull the first `="…"` value out of the registry's formatted label string
 * (e.g. `{tool_name="Bash"}` → `Bash`). Whitelisted families carry at most one
 * label, so first-value is the whole story.
 */
function firstLabelValue(labels: string): string {
  const match = /="((?:[^"\\]|\\.)*)"/.exec(labels)
  if (!match || match[1] === undefined) return ''
  return match[1]
    .replace(/\\(.)/g, '$1')
    .replace(/[^\x20-\x7e]/g, '')
    .slice(0, MAX_LABEL_LENGTH)
}

/**
 * Snapshot the whitelisted counters into a flat `Record<string, number>`.
 *
 * Keys are the family name with the `mipham_code_` prefix and `_total` suffix
 * stripped, plus the label value when there is one:
 *   `mipham_code_cli_invocations_total`              → `cli_invocations`
 *   `mipham_code_tool_calls_total{tool_name="Bash"}` → `tool_calls.Bash`
 *
 * Label cardinality: `tool_name` is closed by construction — there are only as
 * many tool names as the registry declares. `command_name` is **not**: it comes
 * from user input, so the caller is responsible for collapsing unrecognised
 * names (see `commandLabelFor` in `ui/commands.ts`). `MAX_LABEL_LENGTH` below
 * truncates a value, it does not bound how many keys there are.
 */
export function snapshotCounters(): Record<string, number> {
  const metrics = getMetrics()
  const { counters } = metrics.toJSON() as { counters: CounterJson[] }
  const out: Record<string, number> = {}

  for (const counter of counters) {
    const family = counter.name
    if (!(COUNTER_WHITELIST as readonly string[]).includes(family)) continue

    const short = family.replace(/^mipham_code_/, '').replace(/_total$/, '')

    for (const series of counter.series) {
      const value = firstLabelValue(series.labels)
      const key = value ? `${short}.${value}` : short
      out[key] = (out[key] ?? 0) + series.value
    }
  }

  return out
}

/** `darwin/arm64`, `linux/x64`, … — coarse platform identity, no hostname. */
function platformTag(): string {
  return `${process.platform}/${process.arch}`
}

export interface SessionMeta {
  installId: string
  startedAt: number
  endedAt: number
  crashed: boolean
}

/**
 * The `session` event: one per CLI launch, formed at exit.
 *
 * Contains counters and coarse environment facts only. It never carries
 * conversation content, prompts, file contents, paths, user names, hostnames,
 * API keys, or environment variable values.
 */
export function buildSessionEvent(meta: SessionMeta, now: Date = new Date()): QueuedEvent {
  return {
    id: randomUUID(),
    kind: 'session',
    payload: {
      installId: meta.installId,
      schemaVersion: SCHEMA_VERSION,
      occurredAt: now.toISOString(),
      appVersion: PACKAGE_VERSION,
      runtime: runtimeTag(),
      platform: platformTag(),
      sessionDurationMs: Math.max(0, meta.endedAt - meta.startedAt),
      crashed: meta.crashed,
      counters: snapshotCounters(),
    },
  }
}
