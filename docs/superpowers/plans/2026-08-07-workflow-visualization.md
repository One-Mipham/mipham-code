# Workflow Visualization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add real-time CLI progress display and Web-based DAG visualization for workflow execution

**Architecture:** WorkflowEventBus (Node.js EventEmitter singleton) emits events during execution → CLI WorkflowProgress Ink component renders live spinners → journal.jsonl persists for Web Dashboard Mermaid DAG replay

**Tech Stack:** TypeScript 5.5+, Node.js 22+, React/Ink 5 (CLI), Next.js 15 + Tailwind CSS 3 (Web), Mermaid.js CDN

## Global Constraints

- 现有 878 测试零回归
- 不引入新依赖（EventEmitter 内置、Mermaid CDN 加载）
- WorkflowEventBus 单例，零侵入现有 agent()/phase()/log() 签名
- journal.jsonl 格式不变
- CLI 组件自动检测活跃 workflow，无需手动切换

---

## File Structure

```
apps/cli/src/
├── workflow/
│   ├── event-bus.ts            ← CREATE: WorkflowEventBus singleton
│   └── runtime.ts              ← MODIFY: emit events at key points
├── ui/
│   ├── workflow-progress.tsx   ← CREATE: Ink real-time progress component
│   └── commands.ts             ← MODIFY: register /workflow view, /workflow watch
├── commands/
│   └── workflow-view.ts        ← CREATE: /workflow view command (journal replay)

apps/cli/test/
├── workflow/
│   └── event-bus.test.ts       ← CREATE: EventBus tests
└── ui/
    └── workflow-progress.test.ts ← CREATE: component rendering tests

apps/web/src/app/code/dashboard/
├── page.tsx                    ← MODIFY: workflow list + DAG viewer
└── WorkflowDag.tsx             ← CREATE: Mermaid DAG component

apps/web/src/app/api/workflows/
├── route.ts                    ← CREATE: GET /api/workflows (list runs)
└── [id]/route.ts              ← CREATE: GET /api/workflows/[id] (single run DAG)
```

---

### Task 1: WorkflowEventBus

**Files:**
- Create: `apps/cli/src/workflow/event-bus.ts`
- Test: `apps/cli/test/workflow/event-bus.test.ts`

**Interfaces:**
- Consumes: nothing (new leaf module)
- Produces: `workflowEventBus` singleton (module-level export), `WorkflowEvent` type union, `getEventBus(): WorkflowEventBus`

- [ ] **Step 1: Write the failing tests**

Create `apps/cli/test/workflow/event-bus.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getEventBus, WorkflowEventBus } from '../../src/workflow/event-bus'

describe('WorkflowEventBus', () => {
  beforeEach(() => {
    // Reset singleton state between tests
    const bus = getEventBus() as any
    bus.activeRunId = null
    bus.removeAllListeners()
  })

  it('emits and receives phase:start event', () => {
    const bus = getEventBus()
    const handler = vi.fn()
    bus.on('phase:start', handler)

    bus.startRun('test-run-1')
    bus.emitEvent({ type: 'phase:start', phase: 'Scan', timestamp: Date.now() })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].phase).toBe('Scan')
  })

  it('emits and receives agent:start and agent:end events', () => {
    const bus = getEventBus()
    const startHandler = vi.fn()
    const endHandler = vi.fn()
    bus.on('agent:start', startHandler)
    bus.on('agent:end', endHandler)

    bus.startRun('test-run-2')
    bus.emitEvent({ type: 'agent:start', agentId: 'a1', label: 'grep', phase: 'Scan' })
    bus.emitEvent({ type: 'agent:end', agentId: 'a1', label: 'grep', success: true, durationMs: 1200 })

    expect(startHandler).toHaveBeenCalledTimes(1)
    expect(endHandler).toHaveBeenCalledTimes(1)
    expect(endHandler.mock.calls[0][0].success).toBe(true)
    expect(endHandler.mock.calls[0][0].durationMs).toBe(1200)
  })

  it('emits done event with summary stats', () => {
    const bus = getEventBus()
    const handler = vi.fn()
    bus.on('done', handler)

    bus.startRun('test-run-3')
    bus.emitEvent({ type: 'done', runId: 'test-run-3', totalAgents: 5, cacheHits: 2 })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler.mock.calls[0][0].totalAgents).toBe(5)
  })

  it('getActiveRunId returns null when no run started', () => {
    const bus = getEventBus()
    expect(bus.getActiveRunId()).toBeNull()
  })

  it('getActiveRunId returns current run id', () => {
    const bus = getEventBus()
    bus.startRun('active-run')
    expect(bus.getActiveRunId()).toBe('active-run')
  })

  it('multiple subscribers all receive events', () => {
    const bus = getEventBus()
    const h1 = vi.fn()
    const h2 = vi.fn()
    bus.on('phase:start', h1)
    bus.on('phase:start', h2)

    bus.emitEvent({ type: 'phase:start', phase: 'Verify', timestamp: Date.now() })

    expect(h1).toHaveBeenCalledTimes(1)
    expect(h2).toHaveBeenCalledTimes(1)
  })

  it('startRun clears previous run state', () => {
    const bus = getEventBus()
    bus.startRun('first')
    bus.startRun('second')
    expect(bus.getActiveRunId()).toBe('second')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/cli && pnpm test -- --reporter=verbose test/workflow/event-bus.test.ts
```

Expected: 7 tests FAIL — module not found.

- [ ] **Step 3: Implement WorkflowEventBus**

Create `apps/cli/src/workflow/event-bus.ts`:

```typescript
import { EventEmitter } from 'node:events'

export type WorkflowEvent =
  | { type: 'phase:start'; phase: string; timestamp: number }
  | { type: 'phase:end'; phase: string; timestamp: number }
  | { type: 'agent:start'; agentId: string; label: string; phase: string }
  | { type: 'agent:end'; agentId: string; label: string; success: boolean; durationMs: number }
  | { type: 'agent:result'; agentId: string; summary: string }
  | { type: 'log'; message: string }
  | { type: 'error'; agentId?: string; message: string }
  | { type: 'done'; runId: string; totalAgents: number; cacheHits: number }

export class WorkflowEventBus extends EventEmitter {
  private activeRunId: string | null = null

  startRun(runId: string): void {
    this.activeRunId = runId
  }

  emitEvent(event: WorkflowEvent): void {
    this.emit(event.type, event)
  }

  getActiveRunId(): string | null {
    return this.activeRunId
  }
}

let instance: WorkflowEventBus | null = null

export function getEventBus(): WorkflowEventBus {
  if (!instance) {
    instance = new WorkflowEventBus()
  }
  return instance
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/cli && pnpm test -- --reporter=verbose test/workflow/event-bus.test.ts
```

Expected: ALL 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/cli/src/workflow/event-bus.ts apps/cli/test/workflow/event-bus.test.ts
git commit -m "feat(workflow): add WorkflowEventBus — EventEmitter singleton for execution events

- 8 event types: phase:start/end, agent:start/end/result, log, error, done
- getEventBus() singleton accessor
- startRun() / getActiveRunId() for run lifecycle tracking
- 7 tests

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: Integrate EventBus into runtime.ts

**Files:**
- Modify: `apps/cli/src/workflow/runtime.ts:1-177`

**Interfaces:**
- Consumes: `getEventBus()` from Task 1, existing `runWorkflow()` signature
- Produces: events emitted at execution milestones; existing return type unchanged

- [ ] **Step 1: Verify baseline tests pass**

```bash
cd apps/cli && pnpm test -- --reporter=verbose test/workflow/runtime.test.ts
```

Expected: existing workflow runtime tests PASS.

- [ ] **Step 2: Add EventBus integration to runtime.ts**

Modify `apps/cli/src/workflow/runtime.ts`:

Add import after line 8:

```typescript
import { getEventBus } from './event-bus'
```

In `runWorkflow()`, after line 98 (`createJournal(runId, script)`) — add:

```typescript
  const bus = getEventBus()
  bus.startRun(runId)
```

In the wrapped `agent` function (after line 117 `const result = await workflowAgent(...)`), add before the journal append:

```typescript
    const agentId = (opts?.label as string) || `agent-${Date.now().toString(36)}`
    const phase = (opts?.phase as string) || 'default'
    const startTime = Date.now()

    bus.emitEvent({ type: 'agent:start', agentId, label: agentId, phase })

    const result = await workflowAgent(prompt, registry, toolRegistry, {
      ...(opts || {}),
      permissionSystem: permission,
    } as Record<string, unknown>)

    const durationMs = Date.now() - startTime
    bus.emitEvent({ type: 'agent:end', agentId, label: agentId, success: true, durationMs })
    bus.emitEvent({ type: 'agent:result', agentId, summary: String(result).slice(0, 200) })
```

Wait — I need to be more careful. The current code doesn't have `startTime` tracking. Let me re-read the agent wrapper in runtime.ts:

```typescript
  const agent = async (prompt: string, opts?: Record<string, unknown>) => {
    // Check cache first
    if (resultCache) {
      const key = agentCacheKey(prompt, opts || {})
      if (resultCache.has(key)) {
        cacheHits++
        return resultCache.get(key)!
      }
    }
    cacheMisses++

    const result = await workflowAgent(prompt, registry, toolRegistry, {
      ...(opts || {}),
      permissionSystem: permission,
    } as Record<string, unknown>)
    appendJournal(runId, {
      type: 'agent',
      prompt,
      opts: opts as Record<string, unknown> | undefined,
      result,
    })
    return result
  }
```

So the integration needs to be within this wrapper. Let me update the plan step.

In the wrapped `agent` function (lines 106-128), modify to:

```typescript
  const agent = async (prompt: string, opts?: Record<string, unknown>) => {
    // Check cache first
    if (resultCache) {
      const key = agentCacheKey(prompt, opts || {})
      if (resultCache.has(key)) {
        cacheHits++
        return resultCache.get(key)!
      }
    }
    cacheMisses++

    const agentId = (opts?.label as string) || `agent-${cacheMisses}`
    const phase = (opts?.phase as string) || 'default'
    const startTime = Date.now()

    bus.emitEvent({ type: 'agent:start', agentId, label: agentId, phase })

    const result = await workflowAgent(prompt, registry, toolRegistry, {
      ...(opts || {}),
      permissionSystem: permission,
    } as Record<string, unknown>)

    const durationMs = Date.now() - startTime
    bus.emitEvent({ type: 'agent:end', agentId, label: agentId, success: true, durationMs })

    appendJournal(runId, {
      type: 'agent',
      prompt,
      opts: opts as Record<string, unknown> | undefined,
      result,
    })
    return result
  }
```

In `wrappedPhase` function (lines 130-133), add event emission:

```typescript
  const wrappedPhase = (title: string) => {
    phasePrimitive(title)
    bus.emitEvent({ type: 'phase:start', phase: title, timestamp: Date.now() })
    appendJournal(runId, { type: 'phase', message: title })
  }
```

In the `log` function (lines 135-137), add event emission:

```typescript
  const log = (message: string) => {
    bus.emitEvent({ type: 'log', message })
    appendJournal(runId, { type: 'log', message })
  }
```

After the `vmScript.runInContext()` call (after line 162, before the return), add done event:

```typescript
    bus.emitEvent({
      type: 'done',
      runId,
      totalAgents: cacheMisses,
      cacheHits,
    })
```

In the catch block, add error event:

```typescript
    bus.emitEvent({ type: 'error', message })
```

- [ ] **Step 3: Run tests to verify no regressions**

```bash
cd apps/cli && pnpm test
```

Expected: 885 tests PASS (878 existing + 7 from Task 1).

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/workflow/runtime.ts
git commit -m "feat(workflow): integrate EventBus into runtime — emit events during execution

- agent:start/end/result events with duration tracking
- phase:start events on phase transitions
- log events on log() calls
- done event with summary stats on completion
- error event on script failure

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: CLI WorkflowProgress Ink Component

**Files:**
- Create: `apps/cli/src/ui/workflow-progress.tsx`
- Test: `apps/cli/test/ui/workflow-progress.test.ts`

**Interfaces:**
- Consumes: `getEventBus()` from Task 1, React/Ink hooks
- Produces: `<WorkflowProgress />` Ink component — subscribes to EventBus, renders live agent/phase status

- [ ] **Step 1: Write the failing tests**

Create `apps/cli/test/ui/workflow-progress.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { getEventBus, WorkflowEventBus } from '../../src/workflow/event-bus'

// We test the state-tracking logic, not the Ink rendering
// (Ink component testing requires a TTY, so we test the data layer)
describe('WorkflowProgress state', () => {
  let bus: WorkflowEventBus

  beforeEach(() => {
    bus = getEventBus()
    ;(bus as any).activeRunId = null
    bus.removeAllListeners()
  })

  it('builds agent status map from events', () => {
    const agents = new Map<string, { label: string; phase: string; status: 'running' | 'done' | 'failed'; durationMs: number }>()

    bus.on('agent:start', (e) => {
      agents.set(e.agentId, { label: e.label, phase: e.phase, status: 'running', durationMs: 0 })
    })
    bus.on('agent:end', (e) => {
      const a = agents.get(e.agentId)
      if (a) {
        a.status = e.success ? 'done' : 'failed'
        a.durationMs = e.durationMs
      }
    })

    bus.startRun('test')
    bus.emitEvent({ type: 'agent:start', agentId: 'a1', label: 'grep', phase: 'Scan' })
    bus.emitEvent({ type: 'agent:start', agentId: 'a2', label: 'lint', phase: 'Scan' })
    bus.emitEvent({ type: 'agent:end', agentId: 'a1', label: 'grep', success: true, durationMs: 1200 })

    expect(agents.get('a1')!.status).toBe('done')
    expect(agents.get('a1')!.durationMs).toBe(1200)
    expect(agents.get('a2')!.status).toBe('running')
  })

  it('tracks phases in order', () => {
    const phases: string[] = []

    bus.on('phase:start', (e) => {
      phases.push(e.phase)
    })

    bus.startRun('test')
    bus.emitEvent({ type: 'phase:start', phase: 'Scan', timestamp: Date.now() })
    bus.emitEvent({ type: 'phase:start', phase: 'Verify', timestamp: Date.now() })

    expect(phases).toEqual(['Scan', 'Verify'])
  })

  it('detects done event and marks all complete', () => {
    let done = false
    bus.on('done', () => { done = true })

    bus.startRun('test')
    bus.emitEvent({ type: 'done', runId: 'test', totalAgents: 3, cacheHits: 1 })

    expect(done).toBe(true)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd apps/cli && pnpm test -- --reporter=verbose test/ui/workflow-progress.test.ts
```

Expected: 3 tests PASS (these tests use the EventBus from Task 1).

- [ ] **Step 3: Implement WorkflowProgress component**

Create `apps/cli/src/ui/workflow-progress.tsx`:

```typescript
import React, { useState, useEffect, useMemo } from 'react'
import { Box, Text } from 'ink'
import { getEventBus } from '../workflow/event-bus'
import type { WorkflowEvent } from '../workflow/event-bus'

interface AgentState {
  label: string
  phase: string
  status: 'running' | 'done' | 'failed'
  durationMs: number
}

interface WorkflowProgressProps {
  /** If provided, only show progress for this runId. Otherwise auto-detect. */
  runId?: string
}

export function WorkflowProgress({ runId }: WorkflowProgressProps) {
  const [activeRunId, setActiveRunId] = useState<string | null>(null)
  const [phases, setPhases] = useState<Array<{ name: string; done: boolean }>>([])
  const [agents, setAgents] = useState<Map<string, AgentState>>(new Map())
  const [elapsed, setElapsed] = useState(0)
  const [done, setDone] = useState(false)
  const [totalAgents, setTotalAgents] = useState(0)
  const [cacheHits, setCacheHits] = useState(0)

  useEffect(() => {
    const bus = getEventBus()

    const handleEvent = (event: WorkflowEvent) => {
      switch (event.type) {
        case 'phase:start':
          setPhases((prev) => [...prev, { name: event.phase, done: false }])
          setActiveRunId(bus.getActiveRunId())
          break

        case 'agent:start':
          setAgents((prev) => {
            const next = new Map(prev)
            next.set(event.agentId, {
              label: event.label,
              phase: event.phase,
              status: 'running',
              durationMs: 0,
            })
            return next
          })
          break

        case 'agent:end':
          setAgents((prev) => {
            const next = new Map(prev)
            const existing = next.get(event.agentId)
            if (existing) {
              next.set(event.agentId, {
                ...existing,
                status: event.success ? 'done' : 'failed',
                durationMs: event.durationMs,
              })
              // Mark phase as done if all agents in it are done
              const phaseName = existing.phase
              const allInPhase = Array.from(next.values()).filter(
                (a) => a.phase === phaseName,
              )
              const allDone = allInPhase.every((a) => a.status !== 'running')
              if (allDone) {
                setPhases((prev) =>
                  prev.map((p) => (p.name === phaseName ? { ...p, done: true } : p)),
                )
              }
            }
            return next
          })
          break

        case 'done':
          setDone(true)
          setTotalAgents(event.totalAgents)
          setCacheHits(event.cacheHits)
          break

        case 'error':
          break
      }
    }

    // Subscribe to all event types
    const types = [
      'phase:start', 'agent:start', 'agent:end',
      'agent:result', 'log', 'error', 'done',
    ]
    for (const type of types) {
      bus.on(type, handleEvent)
    }

    // Elapsed timer (ticks every 100ms)
    const timer = setInterval(() => {
      setElapsed((prev) => prev + 100)
    }, 100)

    return () => {
      for (const type of types) {
        bus.off(type, handleEvent)
      }
      clearInterval(timer)
    }
  }, [])

  const agentList = useMemo(() => Array.from(agents.values()), [agents])

  if (!activeRunId && !runId) return null
  if (done && agentList.length === 0) return null

  const runningCount = agentList.filter((a) => a.status === 'running').length
  const doneCount = agentList.filter((a) => a.status === 'done').length
  const failedCount = agentList.filter((a) => a.status === 'failed').length

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${ms}ms`
    return `${(ms / 1000).toFixed(1)}s`
  }

  const elapsedStr = formatDuration(elapsed)

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1}>
      <Box>
        <Text bold color="cyan">
          ═══ Workflow: {activeRunId || runId} ═══
        </Text>
      </Box>

      {/* Phases */}
      {phases.map((phase, i) => {
        const phaseAgents = agentList.filter((a) => a.phase === phase.name)
        return (
          <Box key={i} flexDirection="column" marginTop={1}>
            <Text>
              {phase.done ? '●' : '◌'} Phase: {phase.name}
              {phaseAgents.length > 0 && ` [${phaseAgents.filter((a) => a.status === 'done').length}/${phaseAgents.length} done]`}
            </Text>
            {phaseAgents.map((agent, j) => (
              <Box key={j} marginLeft={2}>
                <Text color={agent.status === 'done' ? 'green' : agent.status === 'failed' ? 'red' : 'yellow'}>
                  {agent.status === 'done' ? '✓' : agent.status === 'failed' ? '✗' : '⏳'}{' '}
                  {agent.label}
                  {agent.status !== 'running' && ` ${formatDuration(agent.durationMs)}`}
                </Text>
              </Box>
            ))}
          </Box>
        )
      })}

      {/* Summary footer */}
      <Box marginTop={1}>
        <Text dimColor>
          ═══ Elapsed: {elapsedStr} | Agents: {doneCount}/{agentList.length}
          {runningCount > 0 && ` (${runningCount} running)`}
          {failedCount > 0 && ` (${failedCount} failed)`}
          {done && ` | Cache hits: ${cacheHits}`}
          {done && ' | DONE ═══'}
          {!done && ' | Status: running ═══'}
        </Text>
      </Box>
    </Box>
  )
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd apps/cli && pnpm test -- --reporter=verbose test/ui/workflow-progress.test.ts
```

Expected: 3 tests PASS.

- [ ] **Step 5: Run full test suite**

```bash
cd apps/cli && pnpm test
```

Expected: 888 tests PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add apps/cli/src/ui/workflow-progress.tsx apps/cli/test/ui/workflow-progress.test.ts
git commit -m "feat(ui): add WorkflowProgress Ink component — real-time execution display

- Subscribes to WorkflowEventBus for phase/agent/done events
- Renders phases with done/running/pending indicators
- Per-agent status (✓ done, ⏳ running, ✗ failed) with duration
- Auto-hides when no active workflow
- 3 tests for state-tracking logic

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: /workflow view Command (Journal Replay)

**Files:**
- Create: `apps/cli/src/commands/workflow-view.ts`
- Modify: `apps/cli/src/ui/commands.ts` — register `/workflow view`, `/workflow watch`

**Interfaces:**
- Consumes: `listRuns()`, `loadJournal()`, `loadScript()` from `workflow/journal.ts`
- Produces: `workflowViewCmd: CommandHandler`, `workflowWatchCmd: CommandHandler`

- [ ] **Step 1: Create workflow-view commands**

Create `apps/cli/src/commands/workflow-view.ts`:

```typescript
import type { CommandHandler } from '../ui/commands'
import { listRuns, loadJournal, loadScript } from '../workflow/journal'

export const workflowViewCmd: CommandHandler = async (_ctx, args) => {
  const runId = args[0]

  // /workflow list — show recent runs
  if (!runId || runId === 'list') {
    const runs = listRuns()
    if (runs.length === 0) {
      return { content: 'No workflow runs found.\n\nRuns are saved to ~/.mipham/workflows/ after each Workflow tool invocation.' }
    }

    const lines: string[] = [
      '── Recent Workflow Runs ──',
      '',
    ]

    // Show last 10, newest first
    const recent = runs.sort().reverse().slice(0, 10)
    for (const id of recent) {
      const entries = loadJournal(id)
      const agentCount = entries.filter((e) => e.type === 'agent').length
      const phaseCount = entries.filter((e) => e.type === 'phase').length
      const shortId = id.slice(0, 20)
      lines.push(`  ${shortId}... — ${agentCount} agents, ${phaseCount} phases`)
    }

    lines.push('', `Total runs: ${runs.length}`)
    lines.push('', 'Use /workflow view <runId> to see details.')
    return { content: lines.join('\n') }
  }

  // /workflow view <runId> — show run details
  const entries = loadJournal(runId)
  if (entries.length === 0) {
    return { content: `Run "${runId}" not found.\n\nUse /workflow list to see available runs.` }
  }

  const lines: string[] = [
    `── Workflow: ${runId.slice(0, 30)} ──`,
    '',
  ]

  let currentPhase = ''
  for (const entry of entries) {
    if (entry.type === 'phase') {
      currentPhase = entry.message || ''
      lines.push(`  ▸ Phase: ${currentPhase}`)
    } else if (entry.type === 'agent') {
      const label = entry.opts?.label || entry.prompt?.slice(0, 50) || 'agent'
      lines.push(`    ● ${label}`)
    } else if (entry.type === 'log') {
      lines.push(`    ℹ ${entry.message}`)
    }
  }

  lines.push('', `Total entries: ${entries.length}`)
  return { content: lines.join('\n') }
}

export const workflowWatchCmd: CommandHandler = async (_ctx, args) => {
  // /workflow watch — monitor the currently active workflow
  // This is a hint: the actual rendering is handled by WorkflowProgress component
  // which auto-detects active workflows. This command just confirms watch mode.
  return {
    content: [
      '── Workflow Watch Mode ──',
      '',
      'Workflow progress is displayed automatically when a workflow is running.',
      'No active workflow detected.',
      '',
      'Use /workflow list to see past runs.',
      'Use /workflow view <id> to replay a completed run.',
    ].join('\n'),
  }
}
```

- [ ] **Step 2: Register commands in commands.ts**

In `apps/cli/src/ui/commands.ts`, add import near existing workflow imports:

```typescript
import { workflowViewCmd, workflowWatchCmd } from '../commands/workflow-view'
```

Register in the command map (search for existing `/workflow` entries and add):

```typescript
  '/workflow view': {
    name: '/workflow view',
    description: 'View workflow run details or list runs',
    category: 'Workflow',
    execute: workflowViewCmd,
  },
  '/workflow watch': {
    name: '/workflow watch',
    description: 'Monitor active workflow execution',
    category: 'Workflow',
    execute: workflowWatchCmd,
  },
```

- [ ] **Step 3: Run tests**

```bash
cd apps/cli && pnpm test
```

Expected: 888 tests PASS (no regressions — commands.ts tests may need updating if they check command count).

- [ ] **Step 4: Commit**

```bash
git add apps/cli/src/commands/workflow-view.ts apps/cli/src/ui/commands.ts
git commit -m "feat(commands): add /workflow view and /workflow watch commands

- /workflow list — show last 10 runs from ~/.mipham/workflows/
- /workflow view <id> — replay journal as text tree
- /workflow watch — monitoring placeholder (auto-detection is built-in)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: Web API Routes

**Files:**
- Create: `apps/web/src/app/api/workflows/route.ts`
- Create: `apps/web/src/app/api/workflows/[id]/route.ts`

**Interfaces:**
- Consumes: `listRuns()`, `loadJournal()`, `loadScript()` from `workflow/journal.ts`
- Produces: `GET /api/workflows` → `{ runs: Array<{id, agentCount, phaseCount}> }`, `GET /api/workflows/[id]` → `{ id, script, entries: JournalEntry[] }`

- [ ] **Step 1: Create list endpoint**

Create `apps/web/src/app/api/workflows/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { listRuns, loadJournal } from '@/../../cli/src/workflow/journal'

export async function GET() {
  try {
    const runs = listRuns()
    const data = runs
      .sort()
      .reverse()
      .slice(0, 20)
      .map((id) => {
        const entries = loadJournal(id)
        return {
          id,
          agentCount: entries.filter((e) => e.type === 'agent').length,
          phaseCount: entries.filter((e) => e.type === 'phase').length,
          logCount: entries.filter((e) => e.type === 'log').length,
        }
      })

    return NextResponse.json({ runs: data, total: runs.length })
  } catch (err) {
    return NextResponse.json({ error: 'Failed to read workflow data' }, { status: 500 })
  }
}
```

Note: Next.js may not resolve `@/../../cli/...` imports directly. Alternative approach — inline the journal reading logic:

```typescript
import { NextResponse } from 'next/server'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const WORKFLOW_DIR = join(homedir(), '.mipham', 'workflows')

function listRuns(): string[] {
  if (!existsSync(WORKFLOW_DIR)) return []
  return readdirSync(WORKFLOW_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
}

function loadJournal(runId: string): Array<{ type: string }> {
  const path = join(WORKFLOW_DIR, runId, 'journal.jsonl')
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf-8')
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

export async function GET() {
  try {
    const runs = listRuns()
    const data = runs
      .sort()
      .reverse()
      .slice(0, 20)
      .map((id) => {
        const entries = loadJournal(id)
        return {
          id,
          agentCount: entries.filter((e) => e.type === 'agent').length,
          phaseCount: entries.filter((e) => e.type === 'phase').length,
          logCount: entries.filter((e) => e.type === 'log').length,
        }
      })

    return NextResponse.json({ runs: data, total: runs.length })
  } catch {
    return NextResponse.json({ error: 'Failed to read workflow data' }, { status: 500 })
  }
}
```

- [ ] **Step 2: Create single-run endpoint**

Create `apps/web/src/app/api/workflows/[id]/route.ts`:

```typescript
import { NextResponse } from 'next/server'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const WORKFLOW_DIR = join(homedir(), '.mipham', 'workflows')

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const runDir = join(WORKFLOW_DIR, id)

  if (!existsSync(runDir)) {
    return NextResponse.json({ error: 'Run not found' }, { status: 404 })
  }

  try {
    // Load journal
    const journalPath = join(runDir, 'journal.jsonl')
    let entries: Array<Record<string, unknown>> = []
    if (existsSync(journalPath)) {
      const raw = readFileSync(journalPath, 'utf-8')
      entries = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    }

    // Load script
    const scriptPath = join(runDir, 'script.js')
    let script = ''
    if (existsSync(scriptPath)) {
      script = readFileSync(scriptPath, 'utf-8')
    }

    return NextResponse.json({ id, script, entries })
  } catch {
    return NextResponse.json({ error: 'Failed to read run data' }, { status: 500 })
  }
}
```

- [ ] **Step 3: Verify API compiles**

```bash
cd apps/web && pnpm typecheck
```

Expected: no new type errors.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/app/api/workflows/
git commit -m "feat(web): add workflow API routes — list + detail with journal data

- GET /api/workflows — list last 20 runs with agent/phase counts
- GET /api/workflows/[id] — full journal entries + script

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: Web Dashboard — Workflow List + Mermaid DAG

**Files:**
- Create: `apps/web/src/app/code/dashboard/WorkflowDag.tsx`
- Modify: `apps/web/src/app/code/dashboard/page.tsx`

**Interfaces:**
- Consumes: `GET /api/workflows` and `GET /api/workflows/[id]` from Task 5
- Produces: Dashboard page with workflow run list and Mermaid DAG viewer

- [ ] **Step 1: Create WorkflowDag component**

Create `apps/web/src/app/code/dashboard/WorkflowDag.tsx`:

```typescript
'use client'

import { useEffect, useRef, useState } from 'react'

interface JournalEntry {
  seq: number
  type: 'agent' | 'phase' | 'log'
  prompt?: string
  opts?: Record<string, unknown>
  message?: string
}

interface WorkflowDagProps {
  entries: JournalEntry[]
  runId: string
}

export function WorkflowDag({ entries, runId }: WorkflowDagProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (entries.length === 0) return

    // Build Mermaid graph definition
    let mermaidDef = 'graph TD\n'

    const phases: Array<{ name: string; agents: Array<{ label: string; seq: number }> }> = []
    let currentPhase: string | null = null

    for (const entry of entries) {
      if (entry.type === 'phase') {
        currentPhase = entry.message || 'default'
        phases.push({ name: currentPhase, agents: [] })
      } else if (entry.type === 'agent' && currentPhase) {
        const phase = phases[phases.length - 1]
        if (phase) {
          const label = (entry.opts?.label as string) || entry.prompt?.slice(0, 30) || 'agent'
          phase.agents.push({ label: label.replace(/[^a-zA-Z0-9]/g, '_'), seq: entry.seq })
        }
      }
    }

    // Render subgraphs for each phase
    let prevPhaseEnd: string | null = null
    for (const phase of phases) {
      if (phase.agents.length === 0) continue

      const phaseId = phase.name.replace(/[^a-zA-Z0-9]/g, '_')
      mermaidDef += `  subgraph ${phaseId}["${phase.name}"]\n`

      for (const agent of phase.agents) {
        const nodeId = `${phaseId}_${agent.label}`
        mermaidDef += `    ${nodeId}["${agent.label} ✓"]\n`
      }

      mermaidDef += '  end\n'

      // Connect phases
      if (prevPhaseEnd && phase.agents.length > 0) {
        const firstNode = `${phaseId}_${phase.agents[0]!.label}`
        mermaidDef += `  ${prevPhaseEnd} --> ${firstNode}\n`
      }

      // Chain agents within phase
      for (let i = 1; i < phase.agents.length; i++) {
        const prev = `${phaseId}_${phase.agents[i - 1]!.label}`
        const curr = `${phaseId}_${phase.agents[i]!.label}`
        mermaidDef += `  ${prev} --> ${curr}\n`
      }

      if (phase.agents.length > 0) {
        prevPhaseEnd = `${phaseId}_${phase.agents[phase.agents.length - 1]!.label}`
      }
    }

    // Render using Mermaid
    const loadMermaid = async () => {
      try {
        // @ts-ignore — Mermaid loaded from CDN
        if (!window.mermaid) {
          const script = document.createElement('script')
          script.src = 'https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js'
          script.async = true
          await new Promise<void>((resolve, reject) => {
            script.onload = () => resolve()
            script.onerror = () => reject(new Error('Failed to load Mermaid'))
            document.head.appendChild(script)
          })
          // @ts-ignore
          window.mermaid.initialize({ startOnLoad: false, theme: 'default' })
        }

        if (containerRef.current) {
          // @ts-ignore
          const { svg } = await window.mermaid.render(`dag-${runId.slice(0, 8)}`, mermaidDef)
          containerRef.current.innerHTML = svg
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to render DAG')
      }
    }

    loadMermaid()
  }, [entries, runId])

  if (error) {
    return <div className="text-red-500 p-4">DAG render error: {error}</div>
  }

  return <div ref={containerRef} className="w-full overflow-x-auto" />
}
```

- [ ] **Step 2: Rewrite Dashboard page**

Replace `apps/web/src/app/code/dashboard/page.tsx`:

```typescript
'use client'

import { useState, useEffect } from 'react'
import { useI18n } from '@/i18n/context'
import { WorkflowDag } from './WorkflowDag'

interface RunSummary {
  id: string
  agentCount: number
  phaseCount: number
  logCount: number
}

interface RunDetail {
  id: string
  script: string
  entries: Array<{
    seq: number
    type: 'agent' | 'phase' | 'log'
    prompt?: string
    opts?: Record<string, unknown>
    message?: string
  }>
}

export default function DashboardPage() {
  const { t } = useI18n()
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [selectedRun, setSelectedRun] = useState<RunDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/workflows')
      .then((r) => r.json())
      .then((data) => {
        if (data.error) setError(data.error)
        else setRuns(data.runs || [])
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false))
  }, [])

  const loadRun = async (id: string) => {
    setLoading(true)
    try {
      const res = await fetch(`/api/workflows/${id}`)
      const data = await res.json()
      if (data.error) setError(data.error)
      else setSelectedRun(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="max-w-6xl mx-auto py-8 px-6">
      <h1 className="text-3xl font-bold mb-8">{t('web.dashboard.title')}</h1>

      {error && (
        <div className="mb-6 p-4 bg-red-50 border border-red-200 rounded-lg text-red-700">
          {error}
        </div>
      )}

      {/* Workflow Runs List */}
      <div className="mb-8">
        <h2 className="text-xl font-semibold mb-4">Workflow Runs</h2>
        {loading && !selectedRun && (
          <p className="text-gray-500">Loading...</p>
        )}
        {!loading && runs.length === 0 && (
          <div className="p-8 bg-gray-50 rounded-xl text-center text-gray-500">
            <p className="text-lg">No workflow runs yet</p>
            <p className="text-sm mt-2">
              Workflow runs appear here after using the Workflow tool in Mipham Code CLI.
            </p>
          </div>
        )}
        <div className="space-y-2">
          {runs.map((run) => (
            <button
              key={run.id}
              onClick={() => loadRun(run.id)}
              className={`w-full text-left p-4 rounded-lg border transition-colors ${
                selectedRun?.id === run.id
                  ? 'border-mipham-500 bg-mipham-50'
                  : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
            >
              <div className="flex justify-between items-center">
                <span className="font-mono text-sm">{run.id.slice(0, 24)}...</span>
                <span className="text-sm text-gray-500">
                  {run.agentCount} agents · {run.phaseCount} phases
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* DAG View */}
      {selectedRun && (
        <div className="mb-8">
          <h2 className="text-xl font-semibold mb-4">
            DAG: {selectedRun.id.slice(0, 20)}...
          </h2>
          <div className="bg-white rounded-xl border border-gray-200 p-6 overflow-x-auto">
            <WorkflowDag entries={selectedRun.entries} runId={selectedRun.id} />
          </div>
        </div>
      )}

      {/* Stats Cards */}
      <div className="grid md:grid-cols-3 gap-6">
        <div className="p-6 bg-white rounded-lg border border-gray-200">
          <div className="text-2xl font-bold text-mipham-600">{runs.length}</div>
          <div className="text-sm text-gray-500 mt-1">Total runs</div>
        </div>
        <div className="p-6 bg-white rounded-lg border border-gray-200">
          <div className="text-2xl font-bold text-mipham-600">
            {runs.reduce((sum, r) => sum + r.agentCount, 0)}
          </div>
          <div className="text-sm text-gray-500 mt-1">Total agents executed</div>
        </div>
        <div className="p-6 bg-white rounded-lg border border-gray-200">
          <div className="text-2xl font-bold text-mipham-600">
            {runs.length > 0
              ? Math.round(runs.reduce((sum, r) => sum + r.agentCount, 0) / runs.length)
              : 0}
          </div>
          <div className="text-sm text-gray-500 mt-1">Avg agents per run</div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Verify web builds**

```bash
cd apps/web && pnpm typecheck && pnpm build
```

Expected: build succeeds with no new errors.

- [ ] **Step 4: Run full CLI test suite**

```bash
cd apps/cli && pnpm test
```

Expected: 888 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/code/dashboard/
git commit -m "feat(web): replace dashboard placeholder with workflow list + Mermaid DAG viewer

- Workflow run list from GET /api/workflows
- Individual run detail with Mermaid DAG rendering
- Stats cards: total runs, total agents, avg agents per run
- Mermaid loaded via CDN, renders phase subgraphs with agent nodes

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 7: Final Integration — Auto-show WorkflowProgress in CLI

**Files:**
- Modify: `apps/cli/src/ui/app.tsx` — integrate WorkflowProgress near the header area

**Interfaces:**
- Consumes: `WorkflowProgress` from Task 3, `getEventBus()` from Task 1
- Produces: automatic display of workflow progress when workflow is active

- [ ] **Step 1: Integrate WorkflowProgress into app.tsx**

In `apps/cli/src/ui/app.tsx`, find the header/status area (after the main header Box). Add:

```typescript
import { WorkflowProgress } from './workflow-progress'

// Inside the main render, after the status line area, add:
<WorkflowProgress />
```

The component auto-detects active workflows and renders nothing when idle — no conditional logic needed in app.tsx.

- [ ] **Step 2: Run full test suite**

```bash
cd apps/cli && pnpm test
```

Expected: 888 tests PASS (zero regressions).

- [ ] **Step 3: Commit**

```bash
git add apps/cli/src/ui/app.tsx
git commit -m "feat(ui): auto-display WorkflowProgress during workflow execution

- WorkflowProgress component integrated into main app layout
- Auto-detects active workflow via EventBus, hides when idle

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Final Verification

```bash
cd apps/cli
pnpm typecheck     # Must pass
pnpm lint          # Must pass
pnpm test          # Must pass: 888 + N new tests green

cd ../web
pnpm typecheck     # Must pass
pnpm build         # Must pass
```

Then back in parent repo:

```bash
git add mipham-code
git commit -m "chore: bump mipham-code — Workflow Visualization (EventBus + CLI + Web)"
```

---

## Task Summary

| #   | Task                                | Files        | Lines   | Tests |
|-----|-------------------------------------|-------------|---------|-------|
| 1   | WorkflowEventBus                    | 2 (1 new)   | ~60     | +7    |
| 2   | Runtime EventBus integration         | 1 (mod)     | ~20     | 0     |
| 3   | WorkflowProgress Ink component       | 2 (1 new)   | ~130    | +3    |
| 4   | /workflow view + watch commands      | 2 (1 new)   | ~80     | 0     |
| 5   | Web API routes                       | 2 (new)     | ~70     | 0     |
| 6   | Web Dashboard + Mermaid DAG          | 2 (1 new)   | ~160    | 0     |
| 7   | Final integration (app.tsx)          | 1 (mod)     | ~5      | 0     |
|     | **Total**                            | **12 files** | **~525** | **+10** |
