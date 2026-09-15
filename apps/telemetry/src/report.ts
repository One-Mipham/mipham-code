import { fileURLToPath } from 'node:url'
import {
  dayKey,
  emptyMutableAggregate,
  estimateInstalls,
  mergeInto,
  type MutableAggregate,
} from './aggregate.js'
import { loadConfig } from './config.js'
import { loadKey } from './crypto.js'
import { AggregateStore } from './store.js'

/**
 * The read path: an offline command, run over SSH. There is deliberately no
 * read endpoint.
 *
 * Three reasons, in increasing order of weight:
 *   1. There is no authentication to inherit. `docs/v02-decisions.md:46`
 *      promises a `miphamai4s telemetry-serve` with token auth; that command
 *      does not exist anywhere in the repository. Inventing auth here means new
 *      configuration and new failure modes for a report nobody reads daily.
 *   2. The read surface is far more dangerous than the write surface. Writing
 *      can only poison aggregates; reading returns all of them.
 *   3. Whoever operates this already has SSH and holds the encryption key.
 *
 * **Truncation is printed beside the data, never omitted.** Every table that
 * can lose rows says so on the same screen — `__other__`, the unknown-label
 * count, the dropped-field counts. Without that, "this command was never used"
 * and "this command's label was not allowlisted" render identically, and the
 * dead-code review votes on the difference.
 */

/** Rows below this count are collapsed in the default view. See `--raw`. */
export const K_ANON = 10

interface Options {
  readonly sinceDays: number
  readonly raw: boolean
  readonly json: boolean
}

const USAGE = `Usage: node dist/report.js [--since Nd] [--raw] [--json]

  --since Nd   Window, in receipt days, ending today (default 7d)
  --raw        Do not collapse rows below ${K_ANON} — use when acting on the numbers
  --json       Emit the merged aggregate as JSON instead of tables

This is the only read path. It runs against the encrypted daily files and needs
the same key the collector uses (MIPHAM_TELEMETRY_KEY_PATH).
`

export function parseArgs(argv: readonly string[]): Options | undefined {
  let sinceDays = 7
  let raw = false
  let json = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--raw') raw = true
    else if (arg === '--json') json = true
    else if (arg === '--since') {
      const value = argv[++i]
      const match = value === undefined ? null : /^(\d+)d$/.exec(value)
      if (match === null || match[1] === undefined) return undefined
      sinceDays = Number(match[1])
      if (!Number.isSafeInteger(sinceDays) || sinceDays <= 0) return undefined
    } else if (arg === '--help' || arg === '-h') return undefined
    else return undefined
  }
  return { sinceDays, raw, json }
}

/** Days in the window, oldest first, filtered to those that exist on disk. */
export function windowDays(
  available: readonly string[],
  sinceDays: number,
  today = new Date(),
): string[] {
  const cutoff = dayKey(new Date(today.getTime() - sinceDays * 24 * 60 * 60 * 1000))
  return available.filter((day) => day >= cutoff).sort()
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length)
}

function number(value: number): string {
  return value.toLocaleString('en-US')
}

interface Row {
  readonly key: string
  readonly value: number
}

/**
 * Select one counter family's keys, keeping the family prefix in the label.
 *
 * A bare `command_calls` key (an unlabelled increment) is kept too — it is a
 * real row, and dropping it would make the table's total disagree with the
 * counter it claims to show.
 */
export function pick(counts: Record<string, number>, family: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(counts)) {
    if (key === family || key.startsWith(`${family}.`)) out[key] = value
  }
  return out
}

function rows(counts: Record<string, number>): Row[] {
  return Object.entries(counts)
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => b.value - a.value)
}

/**
 * Render one table, collapsing small rows unless `raw`.
 *
 * The collapsed line reports both how many rows went and their total, so a
 * reader can always tell how much of the table they are not seeing. A silenced
 * bucket that also hides its own size would be indistinguishable from nothing
 * having been there.
 */
function table(title: string, counts: Record<string, number>, raw: boolean, limit = 25): string[] {
  const all = rows(counts)
  if (all.length === 0) return [`${title}\n  (none)`]

  const shown: Row[] = []
  let hiddenRows = 0
  let hiddenTotal = 0
  for (const row of all) {
    // `__other__` and friends are always shown: they are the truncation notice,
    // and collapsing them would hide exactly the thing that must stay visible.
    //
    // Matched on the last dot-segment, not the whole key. Counter rows carry
    // their family as a prefix (`command_calls.__other__`), so testing the whole
    // key would collapse the reserved buckets in precisely the two tables T4
    // votes on — turning "this command's label was not allowlisted" into "this
    // command was never used", which is the one reading this file refuses to
    // allow.
    const isBucket = row.key.split('.').pop()?.startsWith('__') === true
    if (raw || isBucket || row.value >= K_ANON) shown.push(row)
    else {
      hiddenRows++
      hiddenTotal += row.value
    }
  }

  const lines = [title]
  for (const row of shown.slice(0, limit)) {
    lines.push(`  ${pad(row.key, 40)} ${number(row.value).padStart(10)}`)
  }
  if (shown.length > limit) {
    const rest = shown.slice(limit)
    const restTotal = rest.reduce((sum, row) => sum + row.value, 0)
    lines.push(
      `  ${pad(`(+${rest.length} more rows shown-limit)`, 40)} ${number(restTotal).padStart(10)}`,
    )
  }
  if (hiddenRows > 0) {
    lines.push(
      `  ${pad(`(<${K_ANON}: ${hiddenRows} rows, use --raw)`, 40)} ${number(hiddenTotal).padStart(10)}`,
    )
  }
  return lines
}

/** Every truncation signal, printed together and always. */
function observations(m: MutableAggregate): string[] {
  const s = m.server
  const lines = [
    'Observations (ways the numbers above can be wrong)',
    `  ${pad('unknown schema version', 40)} ${number(s.unknownSchema).padStart(10)}`,
    `  ${pad('malformed schema version', 40)} ${number(s.malformedSchema).padStart(10)}`,
    `  ${pad('unknown event kind', 40)} ${number(s.unknownKind).padStart(10)}`,
    `  ${pad('unexpected content-type', 40)} ${number(s.contentTypeUnexpected).padStart(10)}`,
    `  ${pad('unknown counter families', 40)} ${number(s.unknownFamilies).padStart(10)}`,
    `  ${pad('labels folded (not allowlisted)', 40)} ${number(s.unknownLabels).padStart(10)}`,
    `  ${pad('frames discarded on receipt', 40)} ${number(s.framesDiscarded).padStart(10)}`,
    `  ${pad('counter values clamped', 40)} ${number(s.countersClamped).padStart(10)}`,
    `  ${pad('host mismatches (not refused)', 40)} ${number(s.hostMismatch).padStart(10)}`,
    `  ${pad('rate limited (503)', 40)} ${number(s.rateLimited).padStart(10)}`,
    `  ${pad('bodies over the size limit', 40)} ${number(s.bodyTooLarge).padStart(10)}`,
  ]
  for (const { key: reason, value } of rows(s.rejected)) {
    lines.push(`  ${pad(`rejected: ${reason}`, 40)} ${number(value).padStart(10)}`)
  }
  for (const { key: field, value } of rows(s.fieldsDropped)) {
    lines.push(`  ${pad(`fields dropped: ${field}`, 40)} ${number(value).padStart(10)}`)
  }
  return lines
}

export function render(m: MutableAggregate, dayCount: number, raw: boolean): string {
  const s = m.server
  const sessions = m.byKind.session ?? 0
  const crashes = m.byKind.crash ?? 0
  const crashedSessions = m.session.byCrashed.true ?? 0
  const crashRate = sessions > 0 ? ((crashedSessions / sessions) * 100).toFixed(1) : 'n/a'

  const lines = [
    `Mipham Code telemetry — ${dayCount} receipt day(s), UTC`,
    '',
    `  ${pad('bodies parsed', 40)} ${number(s.received).padStart(10)}`,
    `  ${pad('events accepted', 40)} ${number(s.accepted).padStart(10)}`,
    `  ${pad('  of which duplicates (re-counted)', 40)} ${number(s.duplicates).padStart(10)}`,
    `  ${pad('sessions', 40)} ${number(sessions).padStart(10)}`,
    `  ${pad('crash events', 40)} ${number(crashes).padStart(10)}`,
    `  ${pad('sessions flagged crashed', 40)} ${number(crashedSessions).padStart(10)}  (${crashRate}% of sessions)`,
    `  ${pad('distinct installs (HLL estimate)', 40)} ${number(estimateInstalls(m.installs)).padStart(10)}`,
    '',
    ...table('By runtime', m.session.byRuntime, raw),
    '',
    ...table('By platform', m.session.byPlatform, raw),
    '',
    ...table('By app version', m.session.byAppVersion, raw),
    '',
    // The two families T4 step 4 votes on. Printed as separate tables because
    // they answer different questions ("this command is unused" vs "this tool
    // is unused"), and a merged table would let a busy tool mask a dead command.
    ...table('Command calls (window total)', pick(m.session.counters, 'command_calls'), raw, 60),
    '',
    ...table('Tool calls (window total)', pick(m.session.counters, 'tool_calls'), raw, 40),
    '',
    ...table('Crash by error name', m.crash.byErrorName, raw),
    '',
    ...observations(m),
    '',
    raw
      ? '(--raw: rows below K_ANON are shown)'
      : `(rows below K_ANON=${K_ANON} are collapsed — re-run with --raw before deciding anything)`,
  ]
  return lines.join('\n')
}

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const options = parseArgs(argv)
  if (options === undefined) {
    process.stderr.write(USAGE)
    return 2
  }

  const config = loadConfig()
  const store = new AggregateStore({ dataDir: config.dataDir, key: loadKey(config.keyPath) })

  const days = windowDays(store.availableDays(), options.sinceDays)
  if (days.length === 0) {
    process.stderr.write(
      `No aggregate files in the last ${options.sinceDays} day(s) under ${config.dataDir}/aggregate\n`,
    )
    return 1
  }

  const merged = emptyMutableAggregate()
  let dedupTracked = 0
  let dedupEvicted = 0
  for (const day of days) {
    const state = store.readDay(day)
    mergeInto(merged, state)
    dedupTracked = Math.max(dedupTracked, state.dedup.ids.length)
    dedupEvicted += state.dedup.evicted
  }

  if (options.json) {
    // Not suppressed, deliberately: `--json` exists to be piped into something
    // that will do its own analysis, and suppressed rows would make it silently
    // wrong rather than merely coarse.
    process.stdout.write(
      JSON.stringify({ days, merged, dedupTracked, dedupEvicted }, null, 2) + '\n',
    )
    return 0
  }

  process.stdout.write(render(merged, days.length, options.raw) + '\n')
  if (dedupEvicted > 0) {
    process.stdout.write(
      `\nNote: ${number(dedupEvicted)} event id(s) were evicted from the dedup window across this ` +
        `period (peak ${number(dedupTracked)} tracked per day). Re-deliveries of evicted ids are ` +
        `counted again, so the totals above may be inflated — never deflated.\n`,
    )
  }
  return 0
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main())
}
