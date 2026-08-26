# /loop 唤醒接线（真 re-invocation）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `/loop` 从「半环」补成「全环」——ScheduleWakeup 的 timer 到期后真 re-invoke，`/loop` 在本地终端内持续循环。

**Architecture:** 进程内 re-invocation（方案 B）。ScheduleWakeup 的 timer 到期 → 调引擎注册的 `onWakeup` 回调 → prompt 入唤醒队列 → app.tsx 空闲时复用同一 `runTurn` 路径跑 `engine.process(loopPrompt)`。单 turn 锁复用 `turnIdRef`，loop 唤醒不抢占用户输入。

**Tech Stack:** TypeScript strict + Bun/Node 22 + React/Ink（UI）+ Vitest 3（`vi.useFakeTimers`）。

**Spec:** `docs/superpowers/specs/2026-08-26-loop-reinvocation-design.md`

## Global Constraints

- 运行时 Bun 1.2+/Node 22+；包管理 pnpm；测试 Vitest 3。
- 复用 `app.tsx` 的 `turnIdRef` 作单 turn 锁；loop 唤醒**只排队不抢占**，用户输入优先。
- **不接 daemon** `ScheduleManager`（那是后台 worker，非本地 `/loop` 语义）。
- 进程退出 = loop 结束（timer 不持久化）。
- 最大迭代护栏默认 `100`（journal 字段 `maxIterations`）。
- 提交信息 Conventional Commits；每 task 独立 commit。

## File Structure

| 文件                                            | 动作   | 职责                                                                        |
| ----------------------------------------------- | ------ | --------------------------------------------------------------------------- |
| `src/tools/scheduling/schedule-wakeup.ts`       | Modify | `registerWakeupHandler` + timer 到期触发回调 + `noop` 参数                  |
| `src/core/engine.ts`                            | Modify | 唤醒队列（enqueue/dequeue/hasPending）+ 构造时注册回调 + loop turn 结束钩子 |
| `src/ui/app.tsx`                                | Modify | 抽 `runTurn` + turn 结束 drain 队列 + noop 折叠                             |
| `src/commands/autoloop-journal.ts`              | Modify | `startTokens`/`totalTokens`/`maxIterations` 字段 + `recordLoopTokens`       |
| `src/ui/commands.ts`                            | Modify | `/loop` 快照 startTokens + `/usage` Loops 段                                |
| `test/tools/scheduling/schedule-wakeup.test.ts` | Create | 假 timer 触发回调 / noop 透传                                               |
| `test/commands/autoloop-journal.test.ts`        | Modify | token 字段 + recordLoopTokens                                               |
| `test/ui/loop-noop-collapse.test.ts`            | Create | noop 折叠纯函数                                                             |
| `test/ui/commands.test.ts`                      | Modify | `/usage` Loops 段                                                           |

---

## Phase 1 — 真 re-invoke（核心）

### Task 1: `schedule-wakeup.ts` — 唤醒回调注册 + timer 到期触发

**Files:**

- Modify: `src/tools/scheduling/schedule-wakeup.ts`
- Test: `test/tools/scheduling/schedule-wakeup.test.ts`（Create）

**Interfaces:**

- Produces: `registerWakeupHandler(fn: (sessionId: string, prompt: string) => void): void`（module 级导出）

- [ ] **Step 1: 写失败测试**

```ts
// test/tools/scheduling/schedule-wakeup.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  scheduleWakeupTool,
  registerWakeupHandler,
} from '../../../src/tools/scheduling/schedule-wakeup'

describe('ScheduleWakeup re-invocation', () => {
  afterEach(() => vi.useRealTimers())

  it('calls the registered wakeup handler when the timer fires', async () => {
    vi.useFakeTimers()
    const handler = vi.fn()
    registerWakeupHandler(handler)

    await scheduleWakeupTool.execute(
      { delaySeconds: 60, reason: 'poll CI', prompt: 'loop-1' },
      { cwd: '/tmp', sessionId: 'sess-1', provider: '', model: '' },
    )
    expect(handler).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60_000)
    expect(handler).toHaveBeenCalledWith('sess-1', 'loop-1')
  })

  it('does not call handler after stop:true cancels the timer', async () => {
    vi.useFakeTimers()
    const handler = vi.fn()
    registerWakeupHandler(handler)

    await scheduleWakeupTool.execute(
      { delaySeconds: 60, reason: 'poll', prompt: 'loop-1' },
      { cwd: '/tmp', sessionId: 'sess-1', provider: '', model: '' },
    )
    await scheduleWakeupTool.execute(
      { stop: true },
      { cwd: '/tmp', sessionId: 'sess-1', provider: '', model: '' },
    )
    vi.advanceTimersByTime(60_000)
    expect(handler).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/tools/scheduling/schedule-wakeup.test.ts`
Expected: FAIL（`registerWakeupHandler` 未导出 / handler 未被调用）

- [ ] **Step 3: 实现**

在 `schedule-wakeup.ts` 顶部加 module 级 handler + 注册函数，改 timer 回调：

```ts
let wakeupHandler: ((sessionId: string, prompt: string) => void) | null = null

/** 引擎在启动时注入——timer 到期后回调，把 loop prompt 交回引擎 re-invoke。 */
export function registerWakeupHandler(fn: (sessionId: string, prompt: string) => void): void {
  wakeupHandler = fn
}
```

timer 注册处（原「只删 timer」）改为：

```ts
const timeoutId = setTimeout(() => {
  activeTimers.delete(timerKey)
  wakeupHandler?.(sessionId, prompt)
}, delaySeconds * 1000)
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/tools/scheduling/schedule-wakeup.test.ts`
Expected: PASS（2 条）

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/tools/scheduling/schedule-wakeup.ts apps/cli/test/tools/scheduling/schedule-wakeup.test.ts
git commit -m "feat(loop): ScheduleWakeup timer 到期触发 onWakeup 回调（真 re-invoke 前置）"
```

---

### Task 2: `engine.ts` — 唤醒队列 + 构造时注册回调

**Files:**

- Modify: `src/core/engine.ts`
- Test: `test/core/engine-loop.test.ts`（Create，用假 timer + mock provider）

**Interfaces:**

- Consumes: `registerWakeupHandler`（Task 1）
- Produces: `engine.enqueueWakeup(prompt: string): void`、`engine.dequeueWakeup(): string | null`、`engine.hasPendingWakeup(): boolean`

- [ ] **Step 1: 写失败测试**

```ts
// test/core/engine-loop.test.ts
import { describe, it, expect, vi } from 'vitest'

// 构造一个最小 engine（mock provider 返回单个 text chunk），测队列三方法
it('enqueue/dequeue/hasPending round-trips wakeup prompts (keep latest)', () => {
  const engine = makeTestEngine()
  expect(engine.hasPendingWakeup()).toBe(false)
  engine.enqueueWakeup('loop-prompt-A')
  engine.enqueueWakeup('loop-prompt-B') // A 被丢弃（只保留最新，spec §七）
  expect(engine.hasPendingWakeup()).toBe(true)
  expect(engine.dequeueWakeup()).toBe('loop-prompt-B')
  expect(engine.dequeueWakeup()).toBeNull()
})
```

（`makeTestEngine()` 复用 `test/core/` 现有的 engine 构造 helper；若无可新写一个最小 fixture。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/core/engine-loop.test.ts`
Expected: FAIL（`enqueueWakeup`/`dequeueWakeup`/`hasPendingWakeup` 未定义）

- [ ] **Step 3: 实现**

在 `engine.ts` 加：

```ts
private wakeupQueue: string[] = []

enqueueWakeup(prompt: string): void {
  // 队列只保留最新（丢弃旧唤醒，防堆积）
  this.wakeupQueue = [prompt]
}
dequeueWakeup(): string | null {
  return this.wakeupQueue.shift() ?? null
}
hasPendingWakeup(): boolean {
  return this.wakeupQueue.length > 0
}
```

构造函数末尾注入回调（确认 `registerWakeupHandler` 已 import）：

```ts
registerWakeupHandler((_sessionId, prompt) => this.enqueueWakeup(prompt))
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/core/engine-loop.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/core/engine.ts apps/cli/test/core/engine-loop.test.ts
git commit -m "feat(loop): engine 唤醒队列 + 构造时注册 onWakeup 回调"
```

---

### Task 3: `app.tsx` — 抽 `runTurn` + turn 结束 drain 队列

**Files:**

- Modify: `src/ui/app.tsx`

**Interfaces:**

- Consumes: `engine.dequeueWakeup()`、`engine.hasPendingWakeup()`（Task 2）

- [ ] **Step 1: 定位抽取点**

`handleSubmit` 里 `engine.process(...)` 的 `for await` 段（约 L580 起）是「AI turn 主体」。抽成：

```ts
const runTurn = useCallback(
  async (input: string, source: 'user' | 'loop', controller?: AbortController) => {
    const turnId = ++turnIdRef.current
    // …原 L580 起的 for await (engine.process(...)) 渲染逻辑原样搬入…
    // turn 结束后（for await 完成 / catch 后）：
    drainLoopQueue(turnId)
  },
  [/* 依赖同原 handleSubmit */],
)
```

`handleSubmit` 末尾改为 `await runTurn(emotionPrefix ? emotionPrefix + input : input, 'user', controller)`。

- [ ] **Step 2: 加 drain 逻辑**

```ts
const drainLoopQueue = useCallback(
  async (turnId: number) => {
    // 用户 turn 优先：若期间用户又提交，turnId 已前进，本 loop 唤醒让位
    if (turnIdRef.current !== turnId) return
    const next = engine.hasPendingWakeup() ? engine.dequeueWakeup() : null
    if (next) await runTurn(next, 'loop')
  },
  [runTurn, engine],
)
```

- [ ] **Step 3: 手动验证**

Run: `cd apps/cli && pnpm dev` → `/loop 60s echo hello`，确认 60s 后自动再跑一轮（无需打字）。
Expected: 终端自动出现第二轮输出。

（React/Ink 渲染逻辑不写单测，用 dev 手动验证 + 现有 e2e 冒烟；队列/锁的纯逻辑已在 Task 2 覆盖。）

- [ ] **Step 4: 提交**

```bash
git add apps/cli/src/ui/app.tsx
git commit -m "feat(loop): app.tsx 抽 runTurn + turn 结束 drain 唤醒队列"
```

---

### Task 4: 端到端 `/loop <interval>` 真循环

**Files:**

- Test: `test/tools/scheduling/loop-e2e.test.ts`（Create，或用现有 e2e 框架）

- [ ] **Step 1: 写 e2e 测试（假 timer 驱动两轮）**

```ts
it('fixed-interval /loop re-invokes across two wakeups', async () => {
  vi.useFakeTimers()
  const engine = makeTestEngine()
  registerWakeupHandler((_s, p) => engine.enqueueWakeup(p))
  // 模拟 /loop 60s：engine.enqueueWakeup('poll'); 第一轮 drain 后，第二轮 timer 又 enqueue
  engine.enqueueWakeup('poll')
  expect(engine.dequeueWakeup()).toBe('poll')
  // …第二轮通过 scheduleWakeupTool.execute 设 timer → advance → hasPendingWakeup true
})
```

- [ ] **Step 2: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/tools/scheduling/loop-e2e.test.ts`
Expected: PASS

- [ ] **Step 3: 提交**

```bash
git add apps/cli/test/tools/scheduling/loop-e2e.test.ts
git commit -m "test(loop): 固定间隔 /loop 跨两轮 re-invoke e2e"
```

---

## Phase 2 — 迭代记录 + token 记账

### Task 5: `autoloop-journal.ts` — token 字段 + `recordLoopTokens`

**Files:**

- Modify: `src/commands/autoloop-journal.ts`
- Test: `test/commands/autoloop-journal.test.ts`（Modify）

**Interfaces:**

- Produces: `createAutoloopJournal(sessionId, prompt, startTokens?)`、`recordLoopTokens(sessionId, delta)`；journal 新增字段 `startTokens`/`totalTokens`/`maxIterations`

- [ ] **Step 1: 写失败测试**

```ts
it('records startTokens at creation and accumulates totalTokens via recordLoopTokens', () => {
  const j = createAutoloopJournal('s1', 'monitor', 1000)
  expect(j.startTokens).toBe(1000)
  expect(j.totalTokens).toBe(0)
  recordLoopTokens('s1', 250)
  recordLoopTokens('s1', 300)
  const after = readAutoloopJournal('s1')!
  expect(after.totalTokens).toBe(550)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/commands/autoloop-journal.test.ts`
Expected: FAIL（字段不存在 / `recordLoopTokens` 未导出）

- [ ] **Step 3: 实现**

`AutoloopJournal` 加字段 + `createAutoloopJournal` 签名扩展 + 新增 `recordLoopTokens`：

```ts
interface AutoloopJournal {
  // …原字段…
  startTokens?: number
  totalTokens: number
  maxIterations: number
}

export function createAutoloopJournal(
  sessionId: string,
  prompt: string,
  startTokens = 0,
): AutoloopJournal {
  ensureDir()
  const journal: AutoloopJournal = {
    sessionId,
    prompt,
    status: 'active',
    iterations: 0,
    startedAt: new Date().toISOString(),
    logs: [],
    startTokens,
    totalTokens: 0,
    maxIterations: 100,
  }
  writeFileSync(journalPath(sessionId), JSON.stringify(journal, null, 2), 'utf-8')
  return journal
}

export function recordLoopTokens(sessionId: string, delta: number): void {
  const journal = readAutoloopJournal(sessionId)
  if (!journal) return
  journal.totalTokens += delta
  writeFileSync(journalPath(sessionId), JSON.stringify(journal, null, 2), 'utf-8')
}
```

（若现有测试用 `toMatchObject` 或 deep-equal 断言 journal 结构，需同步补新字段，避免破坏既有用例。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/commands/autoloop-journal.test.ts`
Expected: 新增 PASS + 既有用例不回归

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/commands/autoloop-journal.ts apps/cli/test/commands/autoloop-journal.test.ts
git commit -m "feat(loop): autoloop-journal 加 startTokens/totalTokens/maxIterations + recordLoopTokens"
```

---

### Task 6: `commands.ts` `/loop` — 快照 startTokens + loop turn 结束钩子

**Files:**

- Modify: `src/ui/commands.ts`（`loopCmd`）、`src/core/engine.ts`（loop turn 结束钩子）

**Interfaces:**

- Consumes: `createAutoloopJournal(sessionId, prompt, startTokens)`（Task 5）、`recordLoopTokens`、`logAutoloopIteration`

- [ ] **Step 1: `/loop` 创建时快照**

`loopCmd` 里 `createAutoloopJournal(sessionId, prompt)` 改为：

```ts
const startTokens = ctx.engine.getUsageTracker().totalApiTokens
createAutoloopJournal(sessionId, prompt, startTokens)
```

（`loopCmd` 签名当前是 `(_ctx, args)`，`_ctx` 改名 `ctx`。）

- [ ] **Step 2: loop turn 结束自动记账（engine 钩子）**

在 `engine.ts` 的 turn 结束时（`runTurn` 完成后、`assistantContent` 就绪处）调用：

```ts
if (source === 'loop') {
  const delta = this.usageTracker.totalApiTokens - loopStartSnapshot
  logAutoloopIteration(activeLoopSessionId, assistantContent.slice(0, 200))
  recordLoopTokens(activeLoopSessionId, delta)
  // 最大迭代护栏（spec §七）：达到上限自动停止，防失控循环烧 token
  const journal = readAutoloopJournal(activeLoopSessionId)
  if (journal && journal.iterations >= journal.maxIterations) {
    completeAutoloopJournal(activeLoopSessionId, 'stopped')
  }
}
```

（`source`/`activeLoopSessionId`/`loopStartSnapshot` 由 `/loop` 发起时经 runTurn 传入或引擎暂存；具体接线在 Task 3 的 `runTurn` 内补一个可选参数。）

- [ ] **Step 3: 跑测试**

Run: `cd apps/cli && pnpm vitest run test/commands test/core`
Expected: 无回归

- [ ] **Step 4: 提交**

```bash
git add apps/cli/src/ui/commands.ts apps/cli/src/core/engine.ts
git commit -m "feat(loop): /loop 快照 startTokens + loop turn 结束自动 logAutoloopIteration/recordLoopTokens"
```

---

## Phase 3 — #1 `/usage` Loops + #53 noop 折叠

### Task 7: `/usage` Loops 段（#1）

**Files:**

- Modify: `src/ui/commands.ts`（`usageCmd`）、`src/commands/autoloop-journal.ts`（`listActiveAutoloops` 已存在）
- Test: `test/ui/commands.test.ts`（Modify）
- i18n: `src/i18n-core/locales/zh-CN.json`、`en-US.json`（`commands.usage.loops_*`）

**Interfaces:**

- Produces: 纯函数 `formatLoopRows(journals: AutoloopJournal[]): string[]`（便于测试）

- [ ] **Step 1: 写失败测试**

```ts
it('formatLoopRows shows iterations/totalTokens/tokensPerRun/lastRun', () => {
  const rows = formatLoopRows([
    {
      sessionId: 's1',
      prompt: 'monitor CI',
      status: 'active',
      iterations: 4,
      startedAt: new Date().toISOString(),
      logs: [],
      totalTokens: 800,
      maxIterations: 100,
    },
  ])
  expect(rows[0]).toContain('4 iterations')
  expect(rows[0]).toContain('800 tokens')
  expect(rows[0]).toContain('200 /run')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/ui/commands.test.ts`
Expected: FAIL（`formatLoopRows` 未定义）

- [ ] **Step 3: 实现**

`formatLoopRows`（放 `autoloop-journal.ts` 或 `commands.ts`）+ `usageCmd` 加 Loops 段：

```ts
export function formatLoopRows(journals: AutoloopJournal[]): string[] {
  return journals.map((j) => {
    const per = j.iterations > 0 ? Math.round(j.totalTokens / j.iterations) : 0
    const last = j.lastIteration ? new Date(j.lastIteration).toLocaleString() : 'N/A'
    return `${j.sessionId.slice(-8)}  🔄 ${j.iterations} iterations · ${j.totalTokens} tokens · ${per} /run · last ${last}`
  })
}
```

`usageCmd` 读 `listActiveAutoloops()`，非空则追加 Loops 段 + 双语键。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/ui/commands.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/ui/commands.ts apps/cli/src/commands/autoloop-journal.ts apps/cli/test/ui/commands.test.ts apps/cli/src/i18n-core/locales/zh-CN.json apps/cli/src/i18n-core/locales/en-US.json
git commit -m "feat(usage): /usage 加 Loops 分解（#1）"
```

---

### Task 8: `ScheduleWakeup` noop + UI 折叠（#53）

**Files:**

- Modify: `src/tools/scheduling/schedule-wakeup.ts`（`noop` 参数）、`src/ui/app.tsx`（折叠）
- Test: `test/ui/loop-noop-collapse.test.ts`（Create，纯函数）

**Interfaces:**

- Produces: 纯函数 `collapseNoopTicks(ticks: Array<{ noop: boolean }>): string`（连续 noop → 一行）

- [ ] **Step 1: 写失败测试**

```ts
// test/ui/loop-noop-collapse.test.ts
import { describe, it, expect } from 'vitest'
import { collapseNoopTicks } from '../../src/ui/loop-noop'

it('collapses consecutive noop ticks into one line', () => {
  const ticks = [{ noop: true }, { noop: true }, { noop: false }, { noop: true }]
  expect(collapseNoopTicks(ticks)).toBe('💤 idle ×2\n● active\n💤 idle ×1')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm vitest run test/ui/loop-noop-collapse.test.ts`
Expected: FAIL（`collapseNoopTicks` 未定义）

- [ ] **Step 3: 实现**

`src/ui/loop-noop.ts` + `ScheduleWakeup.execute` 加 `noop?: boolean` 参数（透传不改变 re-invoke 语义）+ app.tsx 连续 noop 唤醒折叠显示。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm vitest run test/ui/loop-noop-collapse.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/ui/loop-noop.ts apps/cli/src/tools/scheduling/schedule-wakeup.ts apps/cli/src/ui/app.tsx apps/cli/test/ui/loop-noop-collapse.test.ts
git commit -m "feat(loop): ScheduleWakeup noop 参数 + 连续空闲唤醒折叠（#53）"
```

---

## 验收清单

- [ ] `/loop 60s <prompt>` 固定间隔真循环（Task 1-4）
- [ ] `/loop auto <prompt>` 自定步长续跑（Task 1-4 + 已有 auto prompt）
- [ ] journal `iterations`/`totalTokens` 真递增（Task 5-6）
- [ ] `/usage` 显示 Loops 段（Task 7）
- [ ] 连续 noop 折叠一行（Task 8）
- [ ] 全量 `pnpm test` 无回归 + `pnpm typecheck` 全绿
