import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  dayKey,
  emptyMutableAggregate,
  type Aggregate,
  type MutableAggregate,
} from '../src/aggregate.js'
import { encrypt } from '../src/crypto.js'
import type { DeduperState } from '../src/dedup.js'
import { Hll } from '../src/hll.js'
import { K_ANON, main, parseArgs, pick, render, windowDays } from '../src/report.js'

const KEY = Buffer.alloc(32, 7)
const TODAY = dayKey(new Date())

/**
 * `process.stdout.write` has three overloads, so `ReturnType<typeof vi.spyOn>`
 * loses the call signature and `.mock.calls` decays to `any`. This is the part
 * of the spy the helpers below actually use.
 */
interface WriteSpy {
  mock: { calls: unknown[][] }
}

function mutate(change: (m: MutableAggregate) => void): MutableAggregate {
  const m = emptyMutableAggregate()
  change(m)
  return m
}

describe('parseArgs', () => {
  it('defaults to a 7-day window with no collapsing overrides', () => {
    expect(parseArgs([])).toEqual({ sinceDays: 7, raw: false, json: false })
  })

  it('reads --since Nd, --raw and --json in any order', () => {
    expect(parseArgs(['--raw', '--since', '3d', '--json'])).toEqual({
      sinceDays: 3,
      raw: true,
      json: true,
    })
  })

  it('rejects anything it does not understand rather than guessing', () => {
    // A silently-ignored flag is a report that answers a different question
    // than the one that was asked.
    for (const argv of [
      ['--since', '3'],
      ['--since', '0d'],
      ['--since', '-1d'],
      ['--since'],
      ['--since', 'd'],
      ['--nope'],
      ['3d'],
      ['--help'],
      ['-h'],
    ]) {
      expect(parseArgs(argv), argv.join(' ')).toBeUndefined()
    }
  })
})

describe('windowDays', () => {
  it('keeps the cutoff day itself and sorts oldest first', () => {
    const available = ['2026-09-01', '2026-09-15', '2026-09-08', '2026-08-31']
    const today = new Date('2026-09-15T12:00:00Z')
    // 7 days back is inclusive: a window that silently drops its own boundary
    // day reports a shorter period than it claims.
    expect(windowDays(available, 7, today)).toEqual(['2026-09-08', '2026-09-15'])
    expect(windowDays(available, 1, today)).toEqual(['2026-09-15'])
  })

  it('returns nothing when no day is in range', () => {
    expect(windowDays(['2026-01-01'], 7, new Date('2026-09-15T12:00:00Z'))).toEqual([])
  })
})

describe('pick', () => {
  it('keeps the family, its labels, and an unlabelled increment', () => {
    const counts = {
      'command_calls./help': 2,
      command_calls: 1,
      'tool_calls.Read': 3,
      cli_invocations: 1,
    }
    // The bare `command_calls` row is kept because dropping it would make the
    // table disagree with the counter it claims to show.
    expect(pick(counts, 'command_calls')).toEqual({ 'command_calls./help': 2, command_calls: 1 })
  })

  it('does not confuse a family with a longer family that starts the same way', () => {
    expect(pick({ command_calls_x: 1, 'tool_calls.Read': 2 }, 'command_calls')).toEqual({})
  })
})

describe('render', () => {
  it('collapses rows below K_ANON and says how much it hid', () => {
    const m = mutate((m) => {
      m.session.counters = { 'command_calls./help': 40, 'command_calls./rare': 2 }
    })
    const text = render(m, 1, false)

    expect(text).toContain('command_calls./help')
    expect(text).not.toContain('command_calls./rare')
    // Both the row count and the hidden total, so a reader can size what they
    // are not seeing. A silenced bucket that hid its own size would read as
    // "nothing was there".
    expect(text).toContain(`(<${K_ANON}: 1 rows, use --raw)`)
    expect(text).toContain('re-run with --raw before deciding anything')
  })

  it('shows the same rows at full resolution under --raw', () => {
    const m = mutate((m) => {
      m.session.counters = { 'command_calls./help': 40, 'command_calls./rare': 2 }
    })
    const text = render(m, 1, true)

    expect(text).toContain('command_calls./rare')
    expect(text).not.toContain('use --raw)')
    expect(text).toContain('(--raw: rows below K_ANON are shown)')
  })

  it('never collapses a reserved bucket, even below K_ANON', () => {
    const m = mutate((m) => {
      m.session.counters = {
        'command_calls./help': 40,
        'command_calls.__other__': 1,
        'tool_calls.__other_mcp__': 2,
        'tool_calls.Read': 30,
        'tool_calls.Bash': 3,
      }
    })
    const text = render(m, 1, false)

    // The truncation notice is exactly the row that must stay visible — and it
    // is a *prefixed* key here, so a guard that tested the whole key would miss
    // it in the two tables T4 votes on.
    expect(text).toContain('command_calls.__other__')
    expect(text).toContain('tool_calls.__other_mcp__')
    // An ordinary small row is still collapsed; the guard is not a blanket.
    expect(text).not.toContain('tool_calls.Bash')
  })

  it('prints the command and tool tables separately', () => {
    const m = mutate((m) => {
      m.session.counters = { 'command_calls./help': 20, 'tool_calls.Read': 30 }
    })
    const text = render(m, 1, false)

    // A merged table would let a busy tool mask a dead command, and these two
    // families are what T4 votes on.
    expect(text).toContain('Command calls (window total)')
    expect(text).toContain('Tool calls (window total)')
  })

  it('prints every way the numbers above can be wrong, beside them', () => {
    const m = mutate((m) => {
      m.server.unknownLabels = 7
      m.server.unknownFamilies = 3
      m.server.framesDiscarded = 4
      m.server.rateLimited = 1
      m.server.bodyTooLarge = 2
      m.server.rejected = { 'not-json': 5 }
      m.server.fieldsDropped = { counters: 6 }
    })
    const text = render(m, 1, false)

    expect(text).toContain('Observations (ways the numbers above can be wrong)')
    expect(text).toContain('labels folded (not allowlisted)')
    expect(text).toContain('unknown counter families')
    expect(text).toContain('frames discarded on receipt')
    expect(text).toContain('rate limited (503)')
    expect(text).toContain('bodies over the size limit')
    expect(text).toContain('rejected: not-json')
    expect(text).toContain('fields dropped: counters')
  })

  it('reports the crash rate against sessions, not against crashes', () => {
    const withSessions = mutate((m) => {
      m.byKind = { session: 4, crash: 9 }
      m.session.byCrashed = { true: 1, false: 3 }
    })
    expect(render(withSessions, 1, false)).toContain('(25.0% of sessions)')

    // No denominator: "n/a", never 0%. A 0% crash rate would be a claim.
    expect(render(emptyMutableAggregate(), 1, false)).toContain('n/a')
  })

  it('names the window in receipt days, which is the only date that exists', () => {
    expect(render(emptyMutableAggregate(), 7, false)).toContain('7 receipt day(s), UTC')
  })

  it('says (none) for an empty table rather than printing a bare heading', () => {
    expect(render(emptyMutableAggregate(), 1, false)).toContain('(none)')
  })
})

describe('main', () => {
  let dir: string
  let keyPath: string
  let stdout: WriteSpy
  let stderr: WriteSpy

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mipham-report-'))
    keyPath = join(dir, 'aggregate.key')
    writeFileSync(keyPath, KEY, { mode: 0o400 })
    process.env['MIPHAM_TELEMETRY_DATA_DIR'] = dir
    process.env['MIPHAM_TELEMETRY_KEY_PATH'] = keyPath
    stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
    stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    delete process.env['MIPHAM_TELEMETRY_DATA_DIR']
    delete process.env['MIPHAM_TELEMETRY_KEY_PATH']
    rmSync(dir, { recursive: true, force: true })
  })

  /** Write a day file the way the collector would, without starting one. */
  function writeDay(day: string, state: Aggregate): void {
    mkdirSync(join(dir, 'aggregate'), { recursive: true })
    writeFileSync(join(dir, 'aggregate', `${day}.json.enc`), encrypt(JSON.stringify(state), KEY))
  }

  /** A `MutableAggregate` is what the callbacks can assign to; `Aggregate` is read-only. */
  function recorded(
    day: string,
    change: (a: MutableAggregate) => void,
    dedup: DeduperState = { ids: [], evicted: 0 },
  ): Aggregate {
    const a = emptyMutableAggregate()
    change(a)
    return { day, ...a, dedup }
  }

  function out(spy: WriteSpy): string {
    return spy.mock.calls.map((call) => String(call[0])).join('')
  }

  it('renders the table for the days on disk', () => {
    // Counts above K_ANON so the default view shows them: below it they are
    // collapsed by design, which the render tests above cover.
    writeDay(
      TODAY,
      recorded(TODAY, (a) => {
        a.server.received = 42
        a.server.accepted = 42
        a.byKind = { session: 42 }
        a.session.byPlatform = { 'darwin/arm64': 40 }
        a.session.counters = { 'command_calls./help': 42 }
      }),
    )

    expect(main([])).toBe(0)
    const text = out(stdout)
    expect(text).toContain(`Mipham Code telemetry — 1 receipt day(s), UTC`)
    expect(text).toContain('darwin/arm64')
    expect(text).toContain('command_calls./help')
  })

  it('emits the merged aggregate as JSON, unsuppressed', () => {
    const hll = new Hll()
    hll.add('fixture-install-id-9f8e7d6c')
    writeDay(
      TODAY,
      recorded(TODAY, (a) => {
        a.server.received = 2
        a.server.accepted = 2
        a.byKind = { session: 2 }
        a.session.counters = { 'command_calls./help': 2, 'command_calls./rare': 1 }
        a.session.byPlatform = { 'darwin/arm64': 2 }
        a.installs = hll.toState()
      }),
    )

    expect(main(['--json'])).toBe(0)
    const parsed = JSON.parse(out(stdout)) as {
      days: string[]
      merged: MutableAggregate
      dedupTracked: number
      dedupEvicted: number
    }

    expect(parsed.days).toEqual([TODAY])
    expect(parsed.merged.session.counters).toEqual({
      'command_calls./help': 2,
      // Present even though it is below K_ANON: `--json` exists to be piped
      // into something doing its own analysis, and suppressed rows would make
      // it silently wrong rather than merely coarse.
      'command_calls./rare': 1,
    })
    expect(parsed.dedupEvicted).toBe(0)
    // The human table is not printed in this mode.
    expect(out(stdout)).not.toContain('Observations')
  })

  it('sums several days and counts only those inside the window', () => {
    const old = '2026-01-01'
    writeDay(
      TODAY,
      recorded(TODAY, (a) => (a.byKind = { session: 1 })),
    )
    writeDay(
      old,
      recorded(old, (a) => (a.byKind = { session: 99 })),
    )

    expect(main(['--since', '7d'])).toBe(0)
    expect(out(stdout)).toContain('1 receipt day(s)')
    expect(out(stdout)).not.toContain('99')

    expect(main(['--since', '400d'])).toBe(0)
    expect(out(stdout)).toContain('2 receipt day(s)')
  })

  it('flags ids evicted from the dedup window, because that inflates totals', () => {
    writeDay(
      TODAY,
      recorded(TODAY, (a) => (a.byKind = { session: 1 }), { ids: ['x'], evicted: 5 }),
    )

    expect(main([])).toBe(0)
    expect(out(stdout)).toContain('5 event id(s) were evicted')
  })

  it('says so instead of printing an empty report when there is no data', () => {
    expect(main([])).toBe(1)
    expect(out(stderr)).toContain('No aggregate files in the last 7 day(s)')
    expect(out(stdout)).toBe('')
  })

  it('prints usage and exits 2 on a flag it does not understand', () => {
    expect(main(['--bogus'])).toBe(2)
    expect(out(stderr)).toContain('Usage: node dist/report.js')
  })
})
