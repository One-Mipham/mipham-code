# P0: Loop Scheduling Engine — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/loop <interval> <prompt>` actually execute recurring tasks by implementing the missing scheduling tools (ScheduleWakeup, CronCreate/CronDelete/CronList) and enhancing Task management — eliminating the current `forwardToAI` bridge that delegates to non-existent tools.

**Architecture:** Three new native tools (ScheduleWakeup, CronCreate/Delete/List) with file-backed durable storage under `~/.mipham/cron/`, in-memory timer management via the engine's event loop, and an enhanced Task tool with dependency tracking. The `/loop` and `/schedule` slash commands switch from `forwardToAI` pass-through to direct tool orchestration.

**Tech Stack:** TypeScript 5.5+, Bun runtime, Vitest 3 for testing, JSON file storage for cron persistence, Node.js `setTimeout`/`clearTimeout` for wakeup timers.

## Global Constraints

- Follow existing tool patterns: `ToolDefinition` interface with `name`, `description`, `category`, `permission`, `parameters`, `execute`
- Category: new `scheduling` type or reuse `system` (decision: use existing `system` category for cron tools, `agent` for ScheduleWakeup)
- All cron files stored under `~/.mipham/cron/` (consistent with existing `~/.mipham/sessions/` convention)
- Tests follow existing Vitest patterns in `apps/cli/test/tools/`
- Conventional Commits for all commits

---

## File Structure

```
mipham-code/apps/cli/
├── src/
│   ├── tools/
│   │   ├── scheduling/           # NEW directory
│   │   │   ├── schedule-wakeup.ts # ScheduleWakeup tool
│   │   │   └── cron.ts           # CronCreate + CronDelete + CronList tools
│   │   ├── exec/
│   │   │   └── task.ts           # MODIFY — enhance with Claude Code parity
│   │   └── index.ts              # MODIFY — register new tools
│   ├── core/
│   │   └── engine.ts             # MODIFY — wire ScheduleWakeup timers
│   ├── ui/
│   │   └── commands.ts           # MODIFY — /loop and /schedule use real tools
│   └── shared/
│       └── types.ts              # MODIFY — add 'scheduling' to ToolCategory
├── test/
│   ├── tools/
│   │   └── scheduling.test.ts    # NEW — tests for all scheduling tools
│   └── tools/
│       └── task-enhanced.test.ts # NEW — enhanced Task tool tests
```

**Responsibilities:**

- `scheduling/schedule-wakeup.ts` — In-session timer-based wakeup (ScheduleWakeup tool)
- `scheduling/cron.ts` — Durable cron job CRUD (CronCreate, CronDelete, CronList)
- `exec/task.ts` — Enhanced TaskCreate/TaskUpdate/TaskList with dependencies
- `core/engine.ts` — Timer lifecycle management
- `ui/commands.ts` — Command wiring

---

### Task 1: Add `scheduling` to ToolCategory + Register New Tools

**Files:**

- Modify: `apps/cli/src/shared/types.ts` (ToolCategory)
- Modify: `apps/cli/src/tools/index.ts` (registration)

**Interfaces:**

- Produces: `ToolCategory = 'file' | 'exec' | 'agent' | 'network' | 'system' | 'artifact' | 'scheduling'`

- [ ] **Step 1: Add `scheduling` to ToolCategory**

In `apps/cli/src/shared/types.ts`, locate `ToolCategory`:

```typescript
export type ToolCategory = 'file' | 'exec' | 'agent' | 'network' | 'system' | 'artifact'
```

Change to:

```typescript
export type ToolCategory =
  'file' | 'exec' | 'agent' | 'network' | 'system' | 'artifact' | 'scheduling'
```

- [ ] **Step 2: Create tool registration stubs**

In `apps/cli/src/tools/index.ts`, add import lines after existing imports:

```typescript
import { scheduleWakeupTool } from './scheduling/schedule-wakeup.js'
import { cronCreateTool, cronDeleteTool, cronListTool } from './scheduling/cron.js'
```

Inside `createToolRegistry()`, add to the `tools` array before the Map construction:

```typescript
scheduleWakeupTool,
cronCreateTool,
cronDeleteTool,
cronListTool,
```

- [ ] **Step 3: Verify compilation**

Run: `cd apps/cli && pnpm typecheck`
Expected: No new errors (tools aren't created yet, so expect import errors — that's fine for now)

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/shared/types.ts apps/cli/src/tools/index.ts
git commit -m "feat: add scheduling category and tool registration stubs"
```

---

### Task 2: Implement ScheduleWakeup Tool

**Files:**

- Create: `apps/cli/src/tools/scheduling/schedule-wakeup.ts`
- Test: `apps/cli/test/tools/scheduling.test.ts` (ScheduleWakeup section)

**Interfaces:**

- Produces: `scheduleWakeupTool: ToolDefinition` with name `ScheduleWakeup`
- Parameters: `{ delaySeconds: number, reason: string, prompt: string, stop?: boolean }`
- Returns: `{ success: true, content: string }` or `{ success: false, error: string }`
- Engine-side: `QueryEngine.registerWakeupTimer(id: string, delayMs: number, prompt: string): void`

- [ ] **Step 1: Write the failing test**

```typescript
// apps/cli/test/tools/scheduling.test.ts — ScheduleWakeup section
import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ToolContext } from '@mipham/shared'

const ctx: ToolContext = {
  cwd: '/tmp/test',
  sessionId: 'test-session',
  provider: 'test',
  model: 'test-model',
}

describe('ScheduleWakeup tool definition', () => {
  it('has correct metadata', () => {
    const { scheduleWakeupTool } = require('../../src/tools/scheduling/schedule-wakeup')
    // dynamic import to avoid load-time side effects
  })

  it('has name ScheduleWakeup', async () => {
    const mod = await import('../../src/tools/scheduling/schedule-wakeup')
    expect(mod.scheduleWakeupTool.name).toBe('ScheduleWakeup')
    expect(mod.scheduleWakeupTool.category).toBe('scheduling')
    expect(mod.scheduleWakeupTool.permission).toBe('auto')
  })

  it('requires delaySeconds parameter', async () => {
    const mod = await import('../../src/tools/scheduling/schedule-wakeup')
    const params = mod.scheduleWakeupTool.parameters as { required: string[] }
    expect(params.required).toContain('delaySeconds')
  })

  it('stop=true stops the current loop', async () => {
    const mod = await import('../../src/tools/scheduling/schedule-wakeup')
    const result = await mod.scheduleWakeupTool.execute({ stop: true }, ctx)
    expect(result.success).toBe(true)
    expect(result.content).toContain('stopped')
  })
})

describe('ScheduleWakeup tool execution', () => {
  it('schedules a wakeup and returns confirmation', async () => {
    const mod = await import('../../src/tools/scheduling/schedule-wakeup')
    const result = await mod.scheduleWakeupTool.execute(
      { delaySeconds: 60, reason: 'test', prompt: 'check status' },
      ctx,
    )
    expect(result.success).toBe(true)
    expect(result.content).toContain('60')
    expect(result.content).toContain('scheduled')
  })

  it('rejects delaySeconds < 60', async () => {
    const mod = await import('../../src/tools/scheduling/schedule-wakeup')
    const result = await mod.scheduleWakeupTool.execute(
      { delaySeconds: 10, reason: 'test', prompt: 'check' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('60')
  })

  it('rejects delaySeconds > 3600', async () => {
    const mod = await import('../../src/tools/scheduling/schedule-wakeup')
    const result = await mod.scheduleWakeupTool.execute(
      { delaySeconds: 7200, reason: 'test', prompt: 'check' },
      ctx,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('3600')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/cli && npx vitest run test/tools/scheduling.test.ts 2>&1 | tail -20`
Expected: FAIL — module not found

- [ ] **Step 3: Implement ScheduleWakeup**

```typescript
// apps/cli/src/tools/scheduling/schedule-wakeup.ts
import type { ToolDefinition } from '../../shared/index.ts'

/** Active wakeup timers — in-memory, per-session. */
const activeTimers = new Map<string, { timeoutId: ReturnType<typeof setTimeout>; prompt: string }>()

export const scheduleWakeupTool: ToolDefinition = {
  name: 'ScheduleWakeup',
  description:
    'Schedule when to resume work. Used by /loop for recurring tasks. ' +
    'delaySeconds clamped to [60, 3600]. Pass stop:true to cancel.',
  category: 'scheduling',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      delaySeconds: {
        type: 'number',
        description: 'Seconds from now to wake up. Clamped to [60, 3600].',
      },
      reason: {
        type: 'string',
        description: 'One short sentence explaining the chosen delay.',
      },
      prompt: {
        type: 'string',
        description: 'The prompt to enqueue on wake-up.',
      },
      stop: {
        type: 'boolean',
        description: 'Set to true to cancel all pending wakeups for this session.',
      },
    },
    required: [],
  },
  async execute(params, ctx) {
    const sessionId = ctx.sessionId

    // ── Stop: cancel all timers for this session ──
    if (params.stop === true) {
      let cancelled = 0
      for (const [key, timer] of activeTimers) {
        if (key.startsWith(sessionId + ':')) {
          clearTimeout(timer.timeoutId)
          activeTimers.delete(key)
          cancelled++
        }
      }
      return {
        success: true,
        content: `Loop stopped. ${cancelled} pending wakeup(s) cancelled.`,
      }
    }

    // ── Schedule: validate and register timer ──
    const delaySeconds = params.delaySeconds as number
    const prompt = (params.prompt as string) || ''
    const reason = (params.reason as string) || 'scheduled wakeup'

    if (!delaySeconds || delaySeconds < 60) {
      return {
        success: false,
        content: '',
        error: `delaySeconds must be at least 60 (got ${delaySeconds}). The runtime clamps to [60, 3600].`,
      }
    }
    if (delaySeconds > 3600) {
      return {
        success: false,
        content: '',
        error: `delaySeconds must be at most 3600 (got ${delaySeconds}).`,
      }
    }

    // Cancel previous timer for this session (only one active wakeup per session)
    for (const [key, timer] of activeTimers) {
      if (key.startsWith(sessionId + ':')) {
        clearTimeout(timer.timeoutId)
        activeTimers.delete(key)
      }
    }

    const timerKey = `${sessionId}:wakeup`
    const timeoutId = setTimeout(() => {
      activeTimers.delete(timerKey)
      // Engine will detect timer fire and re-inject prompt
      if (ctx.engine?.onWakeup) {
        ctx.engine.onWakeup(sessionId, prompt)
      }
    }, delaySeconds * 1000)

    activeTimers.set(timerKey, { timeoutId, prompt })

    return {
      success: true,
      content: `⏰ Wakeup scheduled in ${delaySeconds}s (${reason}). Prompt: "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`,
    }
  },
}

/** Expose for engine lifecycle management. */
export function cancelAllSessionTimers(sessionId: string): number {
  let count = 0
  for (const [key, timer] of activeTimers) {
    if (key.startsWith(sessionId + ':')) {
      clearTimeout(timer.timeoutId)
      activeTimers.delete(key)
      count++
    }
  }
  return count
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `cd apps/cli && npx vitest run test/tools/scheduling.test.ts 2>&1 | tail -20`
Expected: PASS (at least the ScheduleWakeup tests)

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/tools/scheduling/schedule-wakeup.ts apps/cli/test/tools/scheduling.test.ts
git commit -m "feat: implement ScheduleWakeup tool for in-session wakeup scheduling"
```

---

### Task 3: Implement CronCreate, CronDelete, CronList Tools

**Files:**

- Create: `apps/cli/src/tools/scheduling/cron.ts`
- Test: `apps/cli/test/tools/scheduling.test.ts` (append Cron section)

**Interfaces:**

- Produces:
  - `cronCreateTool: ToolDefinition` — name `CronCreate`, stores `.json` in `~/.mipham/cron/`
  - `cronDeleteTool: ToolDefinition` — name `CronDelete`, removes `.json` file
  - `cronListTool: ToolDefinition` — name `CronList`, reads all `.json` files

- [ ] **Step 1: Append Cron tests**

```typescript
// Append to apps/cli/test/tools/scheduling.test.ts

describe('CronCreate tool definition', () => {
  it('has correct metadata', async () => {
    const mod = await import('../../src/tools/scheduling/cron')
    expect(mod.cronCreateTool.name).toBe('CronCreate')
    expect(mod.cronCreateTool.category).toBe('scheduling')
  })

  it('requires cron and prompt parameters', async () => {
    const mod = await import('../../src/tools/scheduling/cron')
    const params = mod.cronCreateTool.parameters as { required: string[] }
    expect(params.required).toEqual(['cron', 'prompt'])
  })
})

describe('CronCreate + CronList integration', () => {
  const testDir = `${process.env.HOME || '/tmp'}/.mipham/cron`

  it('creates a cron job file and lists it', async () => {
    const mod = await import('../../src/tools/scheduling/cron')
    const ctx: ToolContext = {
      cwd: '/tmp',
      sessionId: 'cron-test',
      provider: 'test',
      model: 'test',
    }

    const created = await mod.cronCreateTool.execute(
      { cron: '*/5 * * * *', prompt: 'check deploy', recurring: true },
      ctx,
    )
    expect(created.success).toBe(true)
    expect(created.content).toContain('Created')

    const list = await mod.cronListTool.execute({}, ctx)
    expect(list.success).toBe(true)
    expect(list.content).toContain('check deploy')
  })
})
```

- [ ] **Step 2: Implement cron.ts**

```typescript
// apps/cli/src/tools/scheduling/cron.ts
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import type { ToolDefinition } from '../../shared/index.ts'

const CRON_DIR = join(homedir(), '.mipham', 'cron')

function ensureCronDir(): void {
  if (!existsSync(CRON_DIR)) mkdirSync(CRON_DIR, { recursive: true })
}

interface CronJob {
  id: string
  cron: string
  prompt: string
  recurring: boolean
  createdAt: string
}

function jobPath(id: string): string {
  return join(CRON_DIR, `${id}.json`)
}

function generateId(cron: string, prompt: string): string {
  return createHash('sha256').update(`${cron}:${prompt}`).digest('hex').slice(0, 12)
}

function readAllJobs(): CronJob[] {
  ensureCronDir()
  const jobs: CronJob[] = []
  for (const file of readdirSync(CRON_DIR)) {
    if (!file.endsWith('.json')) continue
    try {
      jobs.push(JSON.parse(readFileSync(join(CRON_DIR, file), 'utf-8')))
    } catch {
      /* skip corrupt files */
    }
  }
  return jobs.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export const cronCreateTool: ToolDefinition = {
  name: 'CronCreate',
  description:
    'Schedule a prompt to be enqueued at a future time. Uses standard 5-field cron in local timezone. ' +
    'For recurring schedules set recurring:true. Durable — survives restarts.',
  category: 'scheduling',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      cron: { type: 'string', description: 'Standard 5-field cron expression: "M H DoM Mon DoW"' },
      prompt: { type: 'string', description: 'The prompt to enqueue at each fire time.' },
      recurring: { type: 'boolean', description: 'true = recurring, false (default) = one-shot.' },
    },
    required: ['cron', 'prompt'],
  },
  async execute(params, _ctx) {
    const cron = params.cron as string
    const prompt = params.prompt as string
    const recurring = params.recurring === true
    const id = generateId(cron, prompt)

    ensureCronDir()

    const job: CronJob = {
      id,
      cron,
      prompt: prompt.slice(0, 1000),
      recurring,
      createdAt: new Date().toISOString(),
    }

    writeFileSync(jobPath(id), JSON.stringify(job, null, 2), 'utf-8')

    return {
      success: true,
      content: `Created ${recurring ? 'recurring' : 'one-shot'} cron job.\nID: ${id}\nSchedule: ${cron}\nPrompt: "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}"`,
    }
  },
}

export const cronDeleteTool: ToolDefinition = {
  name: 'CronDelete',
  description: 'Cancel a cron job previously scheduled with CronCreate.',
  category: 'scheduling',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Job ID returned by CronCreate.' },
    },
    required: ['id'],
  },
  async execute(params, _ctx) {
    const id = params.id as string
    const path = jobPath(id)
    if (!existsSync(path)) {
      return { success: false, content: '', error: `Cron job "${id}" not found.` }
    }
    unlinkSync(path)
    return { success: true, content: `Cron job "${id}" deleted.` }
  },
}

export const cronListTool: ToolDefinition = {
  name: 'CronList',
  description: 'List all cron jobs scheduled via CronCreate.',
  category: 'scheduling',
  permission: 'auto',
  parameters: {
    type: 'object',
    properties: {},
    required: [],
  },
  async execute(_params, _ctx) {
    const jobs = readAllJobs()
    if (jobs.length === 0) {
      return { success: true, content: 'No scheduled cron jobs. Use CronCreate to create one.' }
    }
    const lines = ['── Scheduled Cron Jobs ──', '']
    for (const j of jobs) {
      const type = j.recurring ? '🔄 recurring' : '⏱  one-shot'
      lines.push(`${j.id}  ${j.cron}  ${type}`)
      lines.push(`  ${j.prompt.slice(0, 100)}`)
      lines.push('')
    }
    return { success: true, content: lines.join('\n') }
  },
}
```

- [ ] **Step 3: Run tests**

Run: `cd apps/cli && npx vitest run test/tools/scheduling.test.ts 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/tools/scheduling/cron.ts apps/cli/test/tools/scheduling.test.ts
git commit -m "feat: implement CronCreate/CronDelete/CronList for durable job scheduling"
```

---

### Task 4: Enhance Task Tool (Claude Code Parity)

**Files:**

- Modify: `apps/cli/src/tools/exec/task.ts`
- Create: `apps/cli/test/tools/task-enhanced.test.ts`

**Interfaces:**

- Produces: Enhanced `taskTool` with dependency support
- New actions: `get` (get single task), `delete` (soft-delete)
- New fields: `activeForm`, `metadata`, `addBlocks`, `addBlockedBy`, `owner`
- Returns structured task data for `list` action

- [ ] **Step 1: Write enhancement tests**

```typescript
// apps/cli/test/tools/task-enhanced.test.ts
import { describe, it, expect } from 'vitest'
import type { ToolContext } from '@mipham/shared'

const ctx: ToolContext = {
  cwd: '/tmp/test',
  sessionId: 'task-test',
  provider: 'test',
  model: 'test-model',
}

describe('Enhanced Task tool', () => {
  it('creates task with dependencies', async () => {
    const { taskTool } = await import('../../src/tools/exec/task')

    const t1 = await taskTool.execute(
      { action: 'create', subject: 'Task 1', description: 'First task' },
      ctx,
    )
    expect(t1.success).toBe(true)
    const id1 = t1.content!.match(/#(\d+)/)![1]!

    const t2 = await taskTool.execute(
      { action: 'create', subject: 'Task 2', description: 'Depends on Task 1' },
      ctx,
    )
    const id2 = t2.content!.match(/#(\d+)/)![1]!

    // Add dependency: t2 blocked by t1
    const updated = await taskTool.execute(
      { action: 'update', taskId: id2, addBlockedBy: [id1] },
      ctx,
    )
    expect(updated.success).toBe(true)

    // Get task with dependencies
    const got = await taskTool.execute({ action: 'get', taskId: id2 }, ctx)
    expect(got.success).toBe(true)
    expect(got.content).toContain(id1)
  })
})
```

- [ ] **Step 2: Rewrite task.ts with enhanced functionality**

Replace `apps/cli/src/tools/exec/task.ts` with version supporting `create`, `list`, `update`, `get`, `delete` actions plus `addBlocks`, `addBlockedBy`, `metadata`, `activeForm`, `owner` fields.

- [ ] **Step 3: Run tests**

Run: `cd apps/cli && npx vitest run test/tools/task-enhanced.test.ts 2>&1 | tail -20`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/tools/exec/task.ts apps/cli/test/tools/task-enhanced.test.ts
git commit -m "feat: enhance Task tool with dependencies, metadata, and Claude Code parity"
```

---

### Task 5: Wire Engine to Support ScheduleWakeup Timers

**Files:**

- Modify: `apps/cli/src/core/engine.ts`

- [ ] **Step 1: Add timer cleanup to engine**

In `QueryEngine` class:

```typescript
// Add to imports
import { cancelAllSessionTimers } from '../tools/scheduling/schedule-wakeup.js'

// Add method to cleanup on session end
cleanupTimers(): void {
  cancelAllSessionTimers(this.context.getSessionId())
}
```

Call `cleanupTimers()` in the session teardown path.

- [ ] **Step 2: Expose wakeup callback on engine**

```typescript
// In QueryEngine:
onWakeup(sessionId: string, prompt: string): void {
  // When a ScheduleWakeup timer fires, the engine receives the prompt
  // and queues it as the next user input
  this.emitWakeup({ sessionId, prompt })
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/core/engine.ts
git commit -m "feat: wire engine to support ScheduleWakeup timer lifecycle"
```

---

### Task 6: Rewire /loop and /schedule Commands

**Files:**

- Modify: `apps/cli/src/ui/commands.ts` (lines 1152-1265)

- [ ] **Step 1: Rewrite /loop to call ScheduleWakeup directly**

Replace the `forwardToAI` bridge in `loopCmd` (currently ~line 1245) with direct tool invocation:

```typescript
// Replace the return at line 1244-1247:
// Instead of forwardToAI, directly invoke ScheduleWakeup tool:
const { scheduleWakeupTool } = await import('../tools/scheduling/schedule-wakeup.js')
const result = await scheduleWakeupTool.execute(
  { delaySeconds: seconds, reason: `Loop: ${prompt.slice(0, 40)}`, prompt },
  { cwd: process.cwd(), sessionId: ctx.sessionId || 'default', provider: '', model: '' },
)
return { content: result.success ? result.content : `Loop failed: ${result.error}` }
```

Also replace the `forwardToAI` in `scheduleCmd` (line ~1263) to directly call CronList:

```typescript
const { cronListTool } = await import('../tools/scheduling/cron.js')
const result = await cronListTool.execute(
  {},
  { cwd: process.cwd(), sessionId: ctx.sessionId || 'default', provider: '', model: '' },
)
return { content: result.content }
```

- [ ] **Step 2: Run typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/ui/commands.ts
git commit -m "feat: rewire /loop and /schedule to use native scheduling tools"
```

---

### Task 7: Integration Test + Final Verification

**Files:**

- Append: `apps/cli/test/tools/scheduling.test.ts` (integration test)

- [ ] **Step 1: Write end-to-end test**

```typescript
describe('Loop integration', () => {
  it('/loop command creates a ScheduleWakeup and CronList shows it', async () => {
    // Simulate: ScheduleWakeup → CronList workflow
    const sw = await import('../../src/tools/scheduling/schedule-wakeup')
    const cron = await import('../../src/tools/scheduling/cron')
    const ctx: ToolContext = {
      cwd: '/tmp',
      sessionId: 'integration-test',
      provider: 'test',
      model: 'test',
    }

    // Start a loop
    const r1 = await sw.scheduleWakeupTool.execute(
      { delaySeconds: 300, reason: 'check deploy', prompt: 'check the deploy status' },
      ctx,
    )
    expect(r1.success).toBe(true)

    // Create a durable cron job
    const r2 = await cron.cronCreateTool.execute(
      { cron: '0 */6 * * *', prompt: 'daily health check', recurring: true },
      ctx,
    )
    expect(r2.success).toBe(true)

    // List all
    const list = await cron.cronListTool.execute({}, ctx)
    expect(list.success).toBe(true)
    expect(list.content).toContain('daily health check')
  })
})
```

- [ ] **Step 2: Run full test suite**

Run: `cd apps/cli && npx vitest run 2>&1 | tail -30`
Expected: All 295+ tests pass + new tests pass

- [ ] **Step 3: Full typecheck**

Run: `cd apps/cli && pnpm typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: add integration test for loop scheduling workflow"
```

---

## Implementation Order

```
Task 1 (types + stubs) → Task 2 (ScheduleWakeup) → Task 3 (Cron) → Task 4 (Task enhanced) → Task 5 (Engine wiring) → Task 6 (Command rewiring) → Task 7 (Integration test)
```

Tasks 2, 3, and 4 are independent and can run in parallel after Task 1.
Tasks 5 and 6 depend on Tasks 2-3.
Task 7 runs last as final verification.

## Verification

After all tasks complete:

1. `pnpm typecheck` — zero errors
2. `pnpm test` — all tests pass (existing 295 + new scheduling tests)
3. Manual smoke test: `mipham /loop 2m echo hello` — should schedule and execute
4. Verify `~/.mipham/cron/` directory is created with cron job files
5. Verify `/schedule` shows active jobs
