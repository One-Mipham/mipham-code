# Claude Code Slash Command Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add five capability-level slash commands and four CC-compatible aliases to Mipham Code, without stubs.

**Architecture:** Commands stay in the single registry (`apps/cli/src/ui/commands.ts`); each new command either calls a pure core helper (insights), an existing seam (ContextManager, preferences, App state callbacks), or the plugin-loader wiring in `index.tsx`. No new subsystem is introduced.

**Tech Stack:** TypeScript strict, React/Ink CLI, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-11-28-cc-slash-command-parity-design.md`

## Global Constraints

- Add exactly 6 commands (`/insights`, `/statusline`, `/autocompact`, `/reload-plugins`, `/subtask`, `/security-review`) and 3 aliases (`/bug`, `/plugin`, `/list-agents`). Everything else stays out; do not add empty stubs.
- `/security-review` is **not** an alias: `/code-review`'s prompt is explicitly bugs/CLAUDE.md only and never receives a security instruction, so aliasing would be a false promise. It gets its own `gitDiffBridgeCmd` handler that forwards to the existing `security-review` skill.
- User-facing command strings are plain English inline (same style as `/bg`, `/fork`, `/crsi`). No new i18n keys.
- `getCommandNames().length` goes **141 → 150**; the three `SLASH_COMMAND_COUNT` copies, `README.md`, and `CLAUDE.md` must be correct **in the same final commit** that lands the feature (repo rule: docs correct at every moment).
- Do not touch the release header/version lines in `CLAUDE.md`; only counts and the slash-command section.
- All work happens in `apps/cli` unless a path says otherwise.
- Run tests from `apps/cli` (not `--root`): `cd apps/cli && pnpm test <file>`.
- Intermediate tasks are staged; there is **one final commit** after Task 6, because count guards require the full suite's real total before any commit can be green.

## Review Focus

- Corrupt/unreadable/half-written session JSONL → `/insights` must report skipped lines and still print a report, never crash or hang.
- Multi-block tool turns (embedded `tool_use`/`tool_result` blocks) → `/insights` must count them; counting only split events under-reports tool calls. Post-crash "outcome unknown" results must be counted separately from real failures.
- `/autocompact` non-numeric/out-of-range input, or an attached (`isRemote`) session → must reject/refuse, never set a local threshold while the daemon keeps its own.
- `/statusline` unknown mode or a surface without the state callback → must persist/say what actually happened, never claim a change that did not occur.
- `/reload-plugins` when the callback is absent, the session is safe-mode / `disableAllHooks`, or the callback throws → must say unavailable/failed, never print the success line.
- `/subtask` with empty prompt or no inherited context → must print usage / let the Agent tool's own guard speak, and must pin the run to the foreground so the result comes back.

---

### Task 1: `/insights` — cross-session corpus report

**Files:**

- Create: `apps/cli/src/core/session-insights.ts`
- Create: `apps/cli/test/core/session-insights.test.ts`
- Modify: `apps/cli/src/core/session-log.ts` (export the existing `interruptedCallNotice`; no behavior change)
- Modify: `apps/cli/src/ui/commands.ts` (imports, handler, `registry.set`, `COMMAND_DESCRIPTIONS`, `catMap`)

**Interfaces:**

- Consumes: `SessionEvent`, `isValidEvent` from `src/core/session-log.ts`; `miphamHome` from `src/core/paths.ts`.
- Produces:

  ```ts
  export interface SessionInsightsInput {
    name: string
    events: SessionEvent[]
  }
  export interface InsightsReport {
    sessions: number
    events: number
    userMessages: number
    assistantMessages: number
    toolCalls: number
    toolFailures: number
    toolUnknown: number
    compactions: number
    topTools: Array<{ name: string; count: number }>
    models: Array<{ provider: string; model: string; count: number }>
    firstAt: number | null
    lastAt: number | null
  }
  export interface LoadedSessionLogs {
    inputs: SessionInsightsInput[]
    skippedFiles: number
    skippedLines: number
  }
  export function summarizeSessions(inputs: SessionInsightsInput[]): InsightsReport
  export function loadSessionLogs(
    dir?: string,
    opts?: { maxFiles?: number; maxBytes?: number },
  ): LoadedSessionLogs
  export function formatInsightsReport(
    report: InsightsReport,
    dir: string,
    loaded: { skippedFiles: number; skippedLines: number },
  ): string
  ```

- [ ] **Step 1: Write failing summarizer tests** in `apps/cli/test/core/session-insights.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  summarizeSessions,
  loadSessionLogs,
  formatInsightsReport,
} from '../../src/core/session-insights'
import { interruptedCallNotice, type SessionEvent } from '../../src/core/session-log'

const ev = (e: unknown) => e as SessionEvent

describe('summarizeSessions', () => {
  it('counts messages, tool calls, failures, compactions, models and top tools', () => {
    const report = summarizeSessions([
      {
        name: 'a',
        events: [
          ev({ type: 'session/start', at: 100, sessionId: 's1', provider: 'p', model: 'm' }),
          ev({ type: 'user/message', at: 110, message: { role: 'user', content: 'hi' } }),
          ev({ type: 'assistant/message', at: 115, message: { role: 'assistant', content: 'ok' } }),
          ev({ type: 'tool/call', at: 120, id: 't1', name: 'Read', input: {} }),
          ev({ type: 'tool/call', at: 130, id: 't2', name: 'Read', input: {} }),
          ev({ type: 'tool/result', at: 140, id: 't2', result: { success: false, content: 'x' } }),
          ev({ type: 'compaction/summary', at: 150, summary: 's', replacedCount: 3 }),
        ],
      },
    ])
    expect(report.sessions).toBe(1)
    expect(report.events).toBe(7)
    expect(report.userMessages).toBe(1)
    expect(report.assistantMessages).toBe(1)
    expect(report.toolCalls).toBe(2)
    expect(report.toolFailures).toBe(1)
    expect(report.compactions).toBe(1)
    expect(report.topTools).toEqual([{ name: 'Read', count: 2 }])
    expect(report.models).toEqual([{ provider: 'p', model: 'm', count: 1 }])
    expect(report.firstAt).toBe(100)
    expect(report.lastAt).toBe(150)
  })

  it('returns zeros (not NaN) for empty input', () => {
    const r = summarizeSessions([])
    expect(r).toMatchObject({
      sessions: 0,
      events: 0,
      toolCalls: 0,
      toolFailures: 0,
      toolUnknown: 0,
      compactions: 0,
    })
    expect(r.firstAt).toBeNull()
    expect(r.lastAt).toBeNull()
    expect(r.topTools).toEqual([])
  })

  it('counts embedded multi-block tool_use/tool_result and separates unknown outcomes', () => {
    const r = summarizeSessions([
      {
        name: 'x',
        events: [
          ev({
            type: 'assistant/message',
            at: 10,
            message: {
              role: 'assistant',
              content: [
                { type: 'tool_use', id: 'a', name: 'Bash', input: {} },
                { type: 'tool_use', id: 'b', name: 'Read', input: {} },
              ],
            },
          }),
          ev({
            type: 'user/message',
            at: 20,
            message: {
              role: 'user',
              content: [
                { type: 'tool_result', tool_use_id: 'a', content: 'x', is_error: true },
                { type: 'tool_result', tool_use_id: 'b', content: 'y' },
              ],
            },
          }),
          ev({
            type: 'tool/result',
            at: 30,
            id: 'c',
            result: { success: false, content: interruptedCallNotice() },
          }),
        ],
      },
    ])
    expect(r.toolCalls).toBe(2)
    expect(r.toolFailures).toBe(1)
    expect(r.toolUnknown).toBe(1)
    expect(r.topTools).toEqual([
      { name: 'Bash', count: 1 },
      { name: 'Read', count: 1 },
    ])
  })
})

describe('loadSessionLogs', () => {
  it('keeps valid events, skips corrupt lines and reports the count', () => {
    const dir = mkdtempSync(join(tmpdir(), 'insights-'))
    try {
      const good = JSON.stringify({ type: 'session/start', at: 1, sessionId: 's' })
      const good2 = JSON.stringify({ type: 'tool/call', at: 2, id: 't', name: 'Bash', input: {} })
      writeFileSync(join(dir, 'a.jsonl'), [good, 'not json', good2].join('\n'))
      const loaded = loadSessionLogs(dir)
      expect(loaded.inputs).toHaveLength(1)
      expect(loaded.inputs[0]!.events).toHaveLength(2)
      expect(loaded.skippedLines).toBe(1)
      expect(loaded.skippedFiles).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns an empty result for a missing directory', () => {
    const loaded = loadSessionLogs(join(tmpdir(), 'definitely-not-here-xyz'))
    expect(loaded.inputs).toEqual([])
  })

  it('stops at the total byte budget and counts the rest as skipped', () => {
    const dir = mkdtempSync(join(tmpdir(), 'insights-budget-'))
    try {
      const line = JSON.stringify({ type: 'session/start', at: 1, sessionId: 's' }) + '\n'
      writeFileSync(join(dir, 'a.jsonl'), line.repeat(50))
      writeFileSync(join(dir, 'b.jsonl'), line.repeat(50))
      const loaded = loadSessionLogs(dir, { maxTotalBytes: line.length * 50 + 10 })
      expect(loaded.inputs.length).toBe(1)
      expect(loaded.skippedFiles).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('formatInsightsReport', () => {
  it('says "No session logs found" instead of printing an empty table', () => {
    const text = formatInsightsReport(summarizeSessions([]), '/tmp/sessions', {
      skippedFiles: 0,
      skippedLines: 0,
    })
    expect(text).toContain('No session logs found')
  })
  it('prints counts and top tools', () => {
    const report = summarizeSessions([
      { name: 'a', events: [ev({ type: 'tool/call', at: 1, id: 't', name: 'Read', input: {} })] },
    ])
    const text = formatInsightsReport(report, '/tmp/sessions', { skippedFiles: 0, skippedLines: 0 })
    expect(text).toContain('1 sessions')
    expect(text).toContain('Read')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/cli && pnpm test test/core/session-insights.test.ts`
Expected: FAIL — cannot resolve `../../src/core/session-insights`.

- [ ] **Step 3: Implement the module** `apps/cli/src/core/session-insights.ts`

Signatures exactly as in Interfaces. Rules:

- `summarizeSessions`: iterate events once; count message/typing events by `type`; `firstAt/lastAt` = min/max finite `at > 0`, else null; `models` from `session/start` (`provider ?? 'unknown'`, `model ?? 'unknown'`), sort count desc then key asc.
- Tool accounting must cover **both storage shapes** (`messageToEvents` only splits single-block turns):
  - `toolCalls` = `tool/call` events **plus** every `tool_use` block inside `assistant/message.content` arrays.
  - `toolFailures` = `tool/result` events with `result.success === false` **plus** `tool_result` blocks inside `user/message.content` arrays with `is_error === true`, **excluding** unknown-outcome results.
  - `toolUnknown` = `tool/result` events whose `result.content === interruptedCallNotice()` (synthesized on resume); do not count them as failures.
  - `topTools` aggregates from both event names and `tool_use` block names; sort count desc then name asc, slice 10.
- `loadSessionLogs`: signature `(dir = miphamHome('sessions'), opts: { maxFiles?: number; maxBytes?: number; maxTotalBytes?: number } = {})`, defaults `200` files, `20 MiB` per file, `64 MiB` total. If `readdirSync` throws, return empty. Sort `.jsonl` by `statSync().mtimeMs` desc; skip files over `maxBytes`; once cumulative bytes would exceed `maxTotalBytes`, stop and count the remaining files in `skippedFiles`. Read UTF-8, split `\n`, `JSON.parse` each non-empty line, keep `isValidEvent` results, count invalid parses in `skippedLines`. Any read error counts as one `skippedFiles`.
- `formatInsightsReport`: when `report.sessions === 0`, return `No session logs found at ${dir}.`; otherwise print counts (`toolFailures` labelled to include unknown outcomes as a separate line), range (ISO or `unknown`), models and top tools; append `Skipped: X file(s), Y line(s).` only when either is non-zero.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/cli && pnpm test test/core/session-insights.test.ts`
Expected: PASS.

- [ ] **Step 5: Wire the command** in `apps/cli/src/ui/commands.ts`

Add the import: `import { loadSessionLogs, summarizeSessions, formatInsightsReport } from '../core/session-insights'`.

Add near other session commands:

```ts
const insightsCmd: CommandHandler = (ctx) => {
  const dir = miphamHome('sessions')
  const loaded = loadSessionLogs(dir)
  const note =
    (ctx.engine as { isRemote?: boolean }).isRemote === true
      ? "Attached to a daemon: this covers local CLI sessions only; the attached session's audit log is not included.\n\n"
      : ''
  return { content: note + formatInsightsReport(summarizeSessions(loaded.inputs), dir, loaded) }
}
```

Register: `registry.set('/insights', insightsCmd)`.
`COMMAND_DESCRIPTIONS`: `'/insights': 'Analyze your local session history (counts only, no message text)'`.
`catMap`: `'/insights': 'Session & Identity'`.

- [ ] **Step 6: Add a command-level test** to `apps/cli/test/core/session-insights.test.ts` (same file; no new file):

```ts
import { getCommand } from '../../src/ui/commands'

describe('/insights registration', () => {
  it('is registered and renders either the report or the no-logs line', () => {
    const handler = getCommand('/insights')
    expect(handler).toBeDefined()
    const res = handler!({ engine: {} } as never, [])
    expect(typeof res.content).toBe('string')
    expect(res.content).toMatch(/Session Insights|No session logs found/)
  })
})
```

- [ ] **Step 7: Run the targeted tests**

Run: `cd apps/cli && pnpm test test/core/session-insights.test.ts`
Expected: PASS.

---

### Task 2: `/autocompact` — compaction threshold override

**Files:**

- Modify: `apps/cli/src/core/context.ts:71-75, 217-232`
- Modify: `apps/cli/test/core/context.test.ts` (append describe block)
- Modify: `apps/cli/src/ui/commands.ts`
- Modify: `apps/cli/src/index.tsx` (startup preference application near `const engine = new QueryEngine(...)` at line ~839)

**Interfaces:**

- Produces on `ContextManager`:
  ```ts
  setCompactionThresholdOverride(threshold: number | null): void
  ```
- `calculateThresholds()` uses the override when non-null and leaves `config.compactionThreshold` untouched by the window formula until cleared.
- Command `/autocompact [<percent>|default]`.

- [ ] **Step 1: Write failing ContextManager tests** in `apps/cli/test/core/context.test.ts`

```ts
describe('compaction threshold override', () => {
  it('survives calculateThresholds and model changes until cleared', () => {
    const cm = new ContextManager({
      maxTokens: 100000,
      compactionThreshold: 0.9,
      contextWindow: 200000,
    })
    cm.setCompactionThresholdOverride(0.6)
    expect(cm.getCompactionThreshold()).toBe(0.6)
    cm.updateMaxTokens(120000, 500000)
    expect(cm.getCompactionThreshold()).toBe(0.6)
    cm.setCompactionThresholdOverride(null)
    expect(cm.getCompactionThreshold()).toBeCloseTo(0.9)
  })
})
```

- [ ] **Step 2: Run it, expect FAIL** (`setCompactionThresholdOverride is not a function`)

Run: `cd apps/cli && pnpm test test/core/context.test.ts -t "compaction threshold override"`

- [ ] **Step 3: Implement the override** in `apps/cli/src/core/context.ts`

Add `private compactionThresholdOverride: number | null = null` next to the log field, and:

```ts
setCompactionThresholdOverride(threshold: number | null): void {
  this.compactionThresholdOverride = threshold
  this.calculateThresholds()
}
```

In `calculateThresholds()`, first: if override non-null, set `config.compactionThreshold = override` and return (before the window formula). Keep the existing window formula in the null branch.

- [ ] **Step 4: Run tests, expect PASS**

Run: `cd apps/cli && pnpm test test/core/context.test.ts -t "compaction threshold override"`

- [ ] **Step 5: Write failing command tests** in `apps/cli/test/ui/cc-command-parity.test.ts` (create the file; it is extended by later tasks)

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../src/config/preferences', () => ({
  getPreference: vi.fn((_k: string, d: string) => d),
  setPreference: vi.fn(),
}))

import { getCommand } from '../../src/ui/commands'
import { ContextManager } from '../../src/core/context'
import { setPreference } from '../../src/config/preferences'

beforeEach(() => {
  vi.clearAllMocks()
})

const mkCtx = (over: Record<string, unknown> = {}) =>
  ({
    engine: {
      getContext: () =>
        new ContextManager({ maxTokens: 100000, compactionThreshold: 0.9, contextWindow: 200000 }),
    },
    config: {},
    providerId: 'p',
    modelId: 'm',
    version: '0',
    sessionId: 's',
    setSessionTitle: () => {},
    setEffort: () => {},
    setFocusMode: () => {},
    setGoal: () => {},
    setUltracodeMode: () => {},
    setUpdateStatus: () => {},
    t: (k: string) => k,
    ...over,
  }) as never

describe('/autocompact', () => {
  it('sets an override and persists it', () => {
    const cm = new ContextManager({
      maxTokens: 100000,
      compactionThreshold: 0.9,
      contextWindow: 200000,
    })
    const res = getCommand('/autocompact')!(mkCtx({ engine: { getContext: () => cm } }), ['85%'])
    expect(res.content).toContain('85%')
    expect(cm.getCompactionThreshold()).toBe(0.85)
    expect(setPreference).toHaveBeenCalledWith('autocompactThreshold', '0.85')
  })
  it('rejects out-of-range input without setting or persisting', () => {
    const cm = new ContextManager({
      maxTokens: 100000,
      compactionThreshold: 0.9,
      contextWindow: 200000,
    })
    const res = getCommand('/autocompact')!(mkCtx({ engine: { getContext: () => cm } }), ['10%'])
    expect(res.content).toContain('0.50')
    expect(cm.getCompactionThreshold()).toBe(0.9)
    expect(setPreference).not.toHaveBeenCalledWith('autocompactThreshold', '0.1')
  })
  it('default clears the override and the preference', () => {
    const cm = new ContextManager({
      maxTokens: 100000,
      compactionThreshold: 0.9,
      contextWindow: 200000,
    })
    cm.setCompactionThresholdOverride(0.7)
    getCommand('/autocompact')!(mkCtx({ engine: { getContext: () => cm } }), ['default'])
    expect(cm.getCompactionThreshold()).toBeCloseTo(0.9)
    expect(setPreference).toHaveBeenCalledWith('autocompactThreshold', '')
  })
  it('refuses in an attached (remote) session without touching preferences', () => {
    const res = getCommand('/autocompact')!(
      mkCtx({
        engine: {
          isRemote: true,
          getContext: () => {
            throw new Error('remote must not read local context')
          },
        },
      }),
      ['85%'],
    )
    expect(res.content).toContain('Attached to a daemon')
    expect(setPreference).not.toHaveBeenCalledWith('autocompactThreshold', '0.85')
  })
})
```

- [ ] **Step 6: Run, expect FAIL** (`getCommand('/autocompact')` undefined)

- [ ] **Step 7: Implement the command** in `commands.ts`

```ts
const autocompactCmd: CommandHandler = (ctx, args) => {
  if ((ctx.engine as { isRemote?: boolean }).isRemote === true) {
    return {
      content:
        'Attached to a daemon: the daemon owns context compaction; this session cannot change its threshold.',
    }
  }
  const cm = ctx.engine.getContext()
  const arg = (args[0] ?? '').toLowerCase()
  const current = cm.getCompactionThreshold()
  if (!arg) {
    return {
      content: `Auto-compaction (hard) threshold: ${(current * 100).toFixed(0)}% of context (window ${cm.getMaxTokens().toLocaleString()} tokens). Microcompaction still fires earlier on its own window-derived schedule.\n\nUsage: /autocompact <50-95%> | default`,
    }
  }
  if (arg === 'default' || arg === 'off') {
    cm.setCompactionThresholdOverride(null)
    setPreference('autocompactThreshold', '')
    return {
      content: `Auto-compaction threshold cleared; using the window-derived value (${(cm.getCompactionThreshold() * 100).toFixed(0)}%).`,
    }
  }
  const pct = arg.endsWith('%') ? Number.parseFloat(arg) / 100 : Number.parseFloat(arg)
  if (!Number.isFinite(pct) || pct < 0.5 || pct > 0.95) {
    return {
      content: `Invalid threshold "${arg}". Use a value between 0.50 and 0.95 (or "default").`,
    }
  }
  cm.setCompactionThresholdOverride(pct)
  setPreference('autocompactThreshold', String(pct))
  return { content: `Auto-compaction threshold set to ${(pct * 100).toFixed(0)}%.` }
}
```

Register + description + `catMap: '/autocompact': 'Session & Identity'`.

- [ ] **Step 8: Wire startup application** in `apps/cli/src/index.tsx`

Import `getPreference` from `./config/preferences`. Immediately after `const engine = new QueryEngine(...)`:

```ts
const savedAutocompact = Number.parseFloat(getPreference('autocompactThreshold', ''))
if (Number.isFinite(savedAutocompact) && savedAutocompact >= 0.5 && savedAutocompact <= 0.95) {
  engine.getContext().setCompactionThresholdOverride(savedAutocompact)
}
```

- [ ] **Step 9: Run targeted tests** (`test/core/context.test.ts`, `test/ui/cc-command-parity.test.ts`), expect PASS.

---

### Task 3: `/statusline` — footer mode

**Files:**

- Modify: `apps/cli/src/ui/commands.ts` (type, handler, `CommandContext`, registry, description, `catMap`)
- Modify: `apps/cli/src/ui/app.tsx` (state init, `CommandContext` callback, conditional rendering)
- Modify: `apps/cli/test/ui/cc-command-parity.test.ts`

**Interfaces:**

- Produces in `commands.ts`:
  ```ts
  export type StatuslineMode = 'full' | 'compact' | 'off'
  export const STATUSLINE_MODES: readonly StatuslineMode[]
  export function statuslineVisibility(mode: StatuslineMode): {
    graft: boolean
    hints: boolean
    git: boolean
  }
  ```
- `CommandContext` gains `setStatuslineMode?: (mode: StatuslineMode) => void`.
- `StatuslineMode` is a union; permission label is never hidden.

- [ ] **Step 1: Write failing tests**

```ts
import { statuslineVisibility, getCommand } from '../../src/ui/commands'
import { setPreference } from '../../src/config/preferences'

describe('/statusline', () => {
  it('maps modes to visible segments; permission label is always kept', () => {
    expect(statuslineVisibility('full')).toEqual({ graft: true, hints: true, git: true })
    expect(statuslineVisibility('compact')).toEqual({ graft: false, hints: false, git: true })
    expect(statuslineVisibility('off')).toEqual({ graft: false, hints: false, git: false })
  })
  it('sets the mode, calls the callback and persists', () => {
    const setStatuslineMode = vi.fn()
    const res = getCommand('/statusline')!(mkCtx({ setStatuslineMode }), ['compact'])
    expect(res.content).toContain('compact')
    expect(setStatuslineMode).toHaveBeenCalledWith('compact')
    expect(setPreference).toHaveBeenCalledWith('statuslineMode', 'compact')
  })
  it('rejects an unknown mode without persisting or calling back', () => {
    const setStatuslineMode = vi.fn()
    const res = getCommand('/statusline')!(mkCtx({ setStatuslineMode }), ['huge'])
    expect(res.content).toContain('Unknown')
    expect(setStatuslineMode).not.toHaveBeenCalled()
    expect(setPreference).not.toHaveBeenCalledWith('statuslineMode', 'huge')
  })
})
```

- [ ] **Step 2: Run, expect FAIL** (exports missing).

- [ ] **Step 3: Implement type + visibility + command** in `commands.ts`

```ts
export type StatuslineMode = 'full' | 'compact' | 'off'
export const STATUSLINE_MODES: readonly StatuslineMode[] = ['full', 'compact', 'off']

export function statuslineVisibility(mode: StatuslineMode) {
  return {
    graft: mode === 'full',
    hints: mode === 'full',
    git: mode !== 'off',
  }
}

const statuslineCmd: CommandHandler = (ctx, args) => {
  const requested = (args[0] ?? '').toLowerCase()
  const current = getPreference('statuslineMode', 'full')
  if (!requested) {
    return {
      content: `Statusline mode: ${current}\n\nUsage: /statusline <full|compact|off>\n  full    graft line + hints + git branch\n  compact permission + git branch only\n  off     permission line only (never hides the permission mode)`,
    }
  }
  if (!STATUSLINE_MODES.includes(requested as StatuslineMode)) {
    return { content: `Unknown statusline mode "${requested}". Choose full, compact, or off.` }
  }
  const mode = requested as StatuslineMode
  setPreference('statuslineMode', mode)
  ctx.setStatuslineMode?.(mode)
  return { content: `Statusline mode set to ${mode}.` }
}
```

Register + description (`'Configure the footer status line (full|compact|off)'`) + `catMap: '/statusline': 'Environment'`.

- [ ] **Step 4: Implement App state**

- Import `getPreference` alongside `setPreference`.
- Import `type StatuslineMode` from `./commands`.
- Add state:
  ```ts
  const [statuslineMode, setStatuslineMode] = useState<StatuslineMode>(() => {
    const saved = getPreference('statuslineMode', 'full')
    return saved === 'compact' || saved === 'off' ? saved : 'full'
  })
  ```
- Add `setStatuslineMode` to the `CommandContext` object passed to commands.
- Compute `const sl = statuslineVisibility(statuslineMode)` before render.
- Wrap the `GraftStatusLine` block in `{sl.graft && (...)}`; wrap the hint sentence inside the permission row in `{sl.hints && (...)}`; wrap the git-branch block in `{sl.git && ...}`. The permission glyph/label and Ctrl+C warning stay unconditional.

- [ ] **Step 5: Run targeted tests**, expect PASS.

---

### Task 4: `/reload-plugins` — session-local plugin reload

**Files:**

- Modify: `apps/cli/src/index.tsx` (define callback after the `loadPlugins(...)` block; pass through `SetupGateProps` and the `App` createElement)
- Modify: `apps/cli/src/ui/app.tsx` (`AppProps` + destructure + `CommandContext`)
- Modify: `apps/cli/src/ui/commands.ts` (`CommandContext.reloadPlugins`, handler, registry, description, `catMap`)
- Modify: `apps/cli/test/ui/cc-command-parity.test.ts`

**Interfaces:**

- `reloadPlugins?: () => { plugins: number; skills: number }` added to `SetupGateProps`, `AppProps`, and `CommandContext`.

- [ ] **Step 1: Write failing tests**

```ts
describe('/reload-plugins', () => {
  it('calls the callback and reports counts plus boundaries', () => {
    const reloadPlugins = vi.fn(() => ({ plugins: 2, skills: 30 }))
    const res = getCommand('/reload-plugins')!(mkCtx({ reloadPlugins }), [])
    expect(res.content).toContain('2')
    expect(res.content).toContain('30')
    expect(res.content).toContain('MCP')
  })
  it('says unavailable when the callback is missing', () => {
    const res = getCommand('/reload-plugins')!(mkCtx(), [])
    expect(res.content).toContain('not available')
  })
  it('reports failure instead of success when the callback throws', () => {
    const res = getCommand('/reload-plugins')!(
      mkCtx({
        reloadPlugins: () => {
          throw new Error('boom')
        },
      }),
      [],
    )
    expect(res.content).toContain('failed')
    expect(res.content).not.toContain('Reloaded')
  })
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement the callback in `index.tsx`**

After the `if (!safeMode) { loadPlugins(...) }` block, add:

```ts
const reloadBlocked = safeMode || settingsJson.disableAllHooks
const reloadPlugins = reloadBlocked
  ? undefined
  : () => {
      for (const plugin of pluginManager.list()) {
        hookEngine.unregisterSource(plugin.name)
      }
      loadPlugins(
        pluginManager,
        agentRegistry,
        skillsLoader,
        hookEngine,
        McpClient.getInstance(),
        tools,
      )
      return {
        plugins: pluginManager.getEnabled().length,
        skills: skillsLoader.countByType().total,
      }
    }
```

**Why both flags yield `undefined`:** `--safe-mode` deliberately skips plugin loading, and `disableAllHooks` deliberately suppresses plugin hooks. `loadPlugins` has no internal gate — re-running it inside either session would register hooks/MCP/agents the operator asked to be off, then report success. With `undefined`, `/reload-plugins` takes its "not available" branch. (A per-hook skip inside `loadPlugins` would be the alternative; it changes a startup loader for one command, so it is out of scope.)

Add `reloadPlugins?: () => { plugins: number; skills: number }` to `SetupGateProps`, pass `reloadPlugins: props.reloadPlugins` to `App`, and include it in the `SetupGate` createElement call.

- [ ] **Step 4: Implement the command and prop plumbing** in `app.tsx` / `commands.ts`

Handler:

```ts
const reloadPluginsCmd: CommandHandler = (ctx) => {
  if (!ctx.reloadPlugins) {
    return { content: 'Plugin reload is not available in this session.' }
  }
  try {
    const r = ctx.reloadPlugins()
    return {
      content: `✓ Reloaded ${r.plugins} enabled plugin(s); ${r.skills} skills loaded.\n\nBoundaries: already-connected MCP servers stay connected; skills/agents loaded from plugins that are now disabled remain until restart.`,
    }
  } catch (err) {
    return { content: `Plugin reload failed: ${String(err)}` }
  }
}
```

Register + description + `catMap: '/reload-plugins': 'Plugins'`.

- [ ] **Step 5: Run targeted tests**, expect PASS.

---

### Task 5: `/subtask`, `/security-review`, three aliases, `/commands` categories

**Files:**

- Modify: `apps/cli/src/ui/commands.ts`
- Modify: `apps/cli/test/ui/cc-command-parity.test.ts`

**Interfaces:**

- Consumes: `bugReportCmd`, `pluginsCmd`, `agentsCmd`, `gitDiffBridgeCmd` (existing).
- Produces: registry keys `/bug`, `/plugin`, `/list-agents`, `/security-review`, `/subtask`.

- [ ] **Step 1: Write failing tests**

```ts
describe('CC-compatible aliases', () => {
  it.each([
    ['/bug', '/bug-report'],
    ['/plugin', '/plugins'],
    ['/list-agents', '/agents'],
  ])('%s points at the same handler as %s', (alias, target) => {
    expect(getCommand(alias)).toBeDefined()
    expect(getCommand(alias)).toBe(getCommand(target))
  })
  it('/security-review is NOT an alias of /code-review', () => {
    expect(getCommand('/security-review')).toBeDefined()
    expect(getCommand('/security-review')).not.toBe(getCommand('/code-review'))
  })
})

describe('/subtask', () => {
  it('forwards a foreground fork-agent directive containing the task', () => {
    const res = getCommand('/subtask')!(mkCtx(), ['audit', 'src/'])
    expect(res.forwardToAI).toContain('fork')
    expect(res.forwardToAI).toContain('run_in_background')
    expect(res.forwardToAI).toContain('audit src/')
  })
  it('prints usage and forwards nothing when empty', () => {
    const res = getCommand('/subtask')!(mkCtx(), [])
    expect(res.content).toContain('Usage')
    expect(res.forwardToAI).toBeUndefined()
  })
})
```

For `/security-review`, assert the exported prompt (no temp git repo, no `process.chdir`):

```ts
import { SECURITY_REVIEW_PROMPT } from '../../src/ui/commands'

it('forwards a security-specific instruction, not the generic code-review one', () => {
  expect(SECURITY_REVIEW_PROMPT).toContain('security-review skill')
  expect(SECURITY_REVIEW_PROMPT).toContain('security')
  expect(SECURITY_REVIEW_PROMPT).not.toContain('CLAUDE.md violations only')
})
```

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement**

```ts
const subtaskCmd: CommandHandler = (_ctx, args) => {
  const prompt = args.join(' ').trim()
  if (!prompt) {
    return {
      content:
        "Usage: /subtask <task>\n\nSends a fork subagent with this conversation's full context; its result returns to this chat.",
    }
  }
  return {
    forwardToAI: `Use the Agent tool with subagent_type "fork", run_in_background: false, and description "subtask" to complete this task with the full conversation context, then report its result in this conversation:\n\n${prompt}`,
  }
}

export const SECURITY_REVIEW_PROMPT =
  'Use the security-review skill to review all uncommitted changes for security vulnerabilities only: ' +
  'injection, auth/permission bypass, secret exposure, unsafe deserialization, path traversal, and dependency risk. ' +
  'Do not report general style or simplification issues — /simplify owns those. ' +
  'For each finding give file:line, severity, and a concrete fix. ' +
  'If there is nothing to report, write exactly: "Security review found no issues."'

const securityReviewCmd = gitDiffBridgeCmd({
  label: 'Security Review',
  noChangesKey: 'commands.code_review.no_changes',
  runningKey: 'commands.code_review.running',
  errorKey: 'commands.code_review.error',
  forwardToAI: SECURITY_REVIEW_PROMPT,
})
```

Register:

```ts
registry.set('/subtask', subtaskCmd)
registry.set('/bug', bugReportCmd)
registry.set('/plugin', pluginsCmd)
registry.set('/list-agents', agentsCmd)
registry.set('/security-review', securityReviewCmd)
```

Descriptions:

```ts
'/subtask': 'Send a fork subagent with full context; its result returns here',
'/bug': 'Report a bug (alias of /bug-report)',
'/plugin': 'List plugins (alias of /plugins; use /install-plugin, /remove-plugin, /plugin-enable, /plugin-disable to manage)',
'/list-agents': 'List background agent sessions (alias of /agents)',
'/security-review': 'Review pending changes for security issues (security-review skill)',
```

`catMap`: `/subtask` + `/list-agents` → `Agents`; `/bug` → `Session & Identity`; `/plugin` → `Plugins`; `/security-review` → `Code Quality`.

- [ ] **Step 4: Run targeted tests**, expect PASS.

---

### Task 6: Counts, docs, full verification, single commit

**Files:**

- Modify: `packages/shared/package-info.json`, `packages/shared/src/package-info.ts`, `apps/cli/src/shared/package-info.ts` (via script)
- Modify: `README.md` (141 → 150)
- Modify: `CLAUDE.md` (lines 8, 208 slash count; lines 75, 112, 138, 349 test counts; test table core/ui rows)

- [ ] **Step 1: Run the full suite with a JSON report**

Run: `cd apps/cli && pnpm coverage`
Expected: 0 failed; produces `apps/cli/coverage/vitest-report.json`.

- [ ] **Step 2: Sync count constants**

Run: `cd apps/cli && bun run scripts/sync-counts.ts --test-report coverage/vitest-report.json`
Expected: writes `SLASH_COMMAND_COUNT = 150`, `TEST_COUNT = <report total>`, provider/tool unchanged.

- [ ] **Step 3: Update human-readable counts**

All of these are scanned by `test/integrity/published-counts.test.ts` (live docs + four i18n carriers); miss one and the guard is red:

- `README.md`: `/help` row `(141)` → `(150)`.
- `apps/cli/README.md`: line 3 `141 commands` and line 19 `141 Slash Commands` → `150`.
- `packages/shared/src/i18n/locales/en-US.json`: `web.features.slash_commands.title` + `.desc` (`141` → `150`).
- `packages/shared/src/i18n/locales/zh-CN.json`: same two strings (`141` → `150`).
- `apps/cli/src/i18n-core/locales/*.json`: no count claims today, but the guard scans them — confirm no `141` remains.
- `CLAUDE.md` line 8 and line 208: `141 → 150`.
- `CLAUDE.md`: replace every `5,449` / `5449` with the new total in the three guarded spellings (head line, tree line, `pnpm test` comment, table total).
- `CLAUDE.md` test table: recompute the `core` and `ui` rows from the report, not by hand-counting:

```bash
cd apps/cli && node -e "const r=require('./coverage/vitest-report.json'); const by={}; for (const t of r.testResults){const m=t.name.match(/test\/([^/]+)\//); const k=m?m[1]:'?'; by[k]=(by[k]||0)+t.assertionResults.length}; const keys=['core','ui']; for (const k of keys) console.log(k, by[k]); console.log('files', r.testResults.filter(t=>/test\/(core|ui)\//.test(t.name)).length)"
```

Update the `core` and `ui` 测试数 cells and their 文件数 cells. Two new files land (`test/core/session-insights.test.ts`, `test/ui/cc-command-parity.test.ts`), so each directory's 文件数 +1. Keep the 合计 row equal to `TEST_COUNT`.

- Do not touch the release header/version narrative.

- [ ] **Step 4: Regenerate the telemetry allowlist (nine new command labels)**

The receiver allowlist is compared element-for-element with `getCommandLabelNames()`:

```bash
cd apps/cli && UPDATE_TELEMETRY_ALLOWLIST=1 pnpm test test/integrity/telemetry-contract.test.ts
git diff --stat apps/telemetry/src/allowlist.json
```

Expected: `allowlist.json` gains exactly the 9 new labels. Re-run the same test **without** the env var to confirm it passes against the written file.

- [ ] **Step 5: Run integrity + typecheck + lint + format**

Run:

```bash
cd apps/cli && pnpm test test/integrity
cd apps/cli && pnpm typecheck
cd ../.. && pnpm lint && pnpm format:check
```

Expected: all pass. If `format:check` fails on edited markdown/tables, run `pnpm format` and re-run the integrity set.

- [ ] **Step 6: Verify the command surface**

Run: `cd apps/cli && bun run bin/mipham.ts /commands` is interactive; instead assert from the registry:

```bash
cd apps/cli && bun -e "import('./src/ui/commands.ts').then(m => console.log(m.getCommandNames().length, m.getCommandNames().filter(n => ['/insights','/statusline','/autocompact','/reload-plugins','/subtask','/bug','/plugin','/list-agents','/security-review'].includes(n)).join(' ')))"
```

Expected: `150` and all nine names.

- [ ] **Step 7: Commit (single commit for the batch)**

```bash
cd /Users/sarvadaya/Rismed_Ronxin_Capital/One_Mipham_Corporation/mipham-code
git add apps/cli apps/telemetry docs/superpowers/specs docs/superpowers/plans packages/shared README.md CLAUDE.md packages/shared/package-info.json
git commit -m "feat(cli): add 5 CC-parity slash commands and 4 aliases" -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
```
