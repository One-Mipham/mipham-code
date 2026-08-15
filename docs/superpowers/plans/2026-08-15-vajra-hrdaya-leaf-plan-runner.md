# Vajra-Hṛdaya 真叶子 — 内核原生 plan-runner 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 内核第一个「真叶子」——把 SDD 编排（逐任务派子代理 → 评审 → 收尾）做成一个 Vajra Service（`plan-runner`），消耗 `ctx.llm` 缝，用 scope 隔离每任务、用 emit 派发进度事件。证明「装下一片真叶子」：Service + inject + scope + emit + llm 缝在同一特性上协同。

**Architecture:** `apps/cli/src/vajra/leaf/plan-runner.ts`——`planRunnerService: Service` 声明 `inject: ['llm']`，`apply(ctx)` 提供 `plan-runner` 键。`run(plan)` 逐任务：`ctx.scope(task.id)` 开作用域 → 派「implementer」一次 llm 调用（`ctx.get<Llm>('llm')`）→ 派「reviewer」一次 llm 调用 → `ctx.emit('plan/task-*')` 进度事件。事件经 declaration merging 扩展 `EventMap`（内核首例）。用 `llm-replay` 回放器驱动，确定性、无需真实 API key。

**Tech Stack:** TypeScript 5.5+ strict（ESM）、Bun/Node 22+、Vitest 3。

**Spec:** `docs/superpowers/specs/2026-08-15-vajra-hrdaya-kernel-design.md`（§3.1 事件契约 declaration merging、§7.1「装下一片真叶子即停」、§11 成功标准）

## Global Constraints

- TS strict + ESM；Vitest 3；不硬编码凭据；Conventional Commits；中文注释风格；不 dispatch 子代理（implementer）。
- 测试命令：`cd apps/cli && pnpm test`；typecheck：`cd apps/cli && pnpm typecheck`。
- 子代理「implementer/reviewer」是一击 llm 调用（无多轮工具执行——那是 engine 职责）；真叶子证明编排 + 缝 + 作用域 + 事件协同，不重造引擎 agent loop。
- 事件用 declaration merging 扩展 `EventMap`（`apps/cli/src/vajra/events.ts` 的 `EventMap` 为空 interface，按注释「里程碑通过 declaration merging 扩展，无需改内核」）。
- 分支 `feat/vajra-hrdaya-leaf`。

---

## Task 1: plan-runner Service 核心

**Files:**
- Create: `apps/cli/src/vajra/leaf/plan-runner.ts`
- Test: `apps/cli/test/vajra/leaf/plan-runner.test.ts`

**Interfaces:**
- Produces: `PlanTask`/`Plan`/`TaskOutcome`/`PlanRunner` 类型；`PLAN_RUNNER_KEY = 'plan-runner'`；`planRunnerService: Service`（`inject: ['llm']`）；事件 `plan/task-start` / `plan/task-done`（declaration merging）。

- [ ] **Step 1: 写失败测试**

`apps/cli/test/vajra/leaf/plan-runner.test.ts`：

```ts
import { describe, it, expect, vi } from 'vitest'
import { Context } from '../../../src/vajra'
import type { Llm } from '../../../src/providers/llm'
import { replayLlm, type RecordedTurn } from '../../../src/providers/llm-replay'
import { planRunnerService, PLAN_RUNNER_KEY, type PlanRunner } from '../../../src/vajra/leaf/plan-runner'
import { LLM_KEY } from '../../../src/providers/llm'

const text = (s: string): RecordedTurn => ({
  req: { model: 'm', messages: [] },
  chunks: [{ type: 'text', content: s }, { type: 'stop' }],
})

describe('plan-runner leaf', () => {
  it('runs a plan via the injected llm seam and emits events', async () => {
    const ctx = new Context()
    ctx.provide(LLM_KEY, replayLlm([
      text('implemented A'),
      text('APPROVE — good'),
      text('implemented B'),
      text('REJECT — needs work'),
    ]))

    const started: string[] = []
    ctx.on('plan/task-start', (e) => started.push(e.taskId))
    const done: string[] = []
    ctx.on('plan/task-done', (e) => done.push(e.taskId))

    ctx.mount(planRunnerService)
    const runner = ctx.get<PlanRunner>(PLAN_RUNNER_KEY)!
    const outcomes = await runner.run({ name: 'p', tasks: [
      { id: 't1', description: 'do A' },
      { id: 't2', description: 'do B' },
    ] })

    expect(outcomes.map((o) => o.status)).toEqual(['done', 'needs-changes'])
    expect(started).toEqual(['t1', 't2'])
    expect(done).toEqual(['t1', 't2'])
  })

  it('service waits for the llm dependency (mount before provide)', () => {
    const ctx = new Context()
    const mounted = ctx.mount(planRunnerService)
    expect(mounted.status()).toBe('inactive') // 依赖未就位
    ctx.provide(LLM_KEY, replayLlm([]))
    expect(mounted.status()).toBe('active') // 依赖到位后激活
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test plan-runner`
Expected: FAIL——模块未定义。

- [ ] **Step 3: 最小实现**

`apps/cli/src/vajra/leaf/plan-runner.ts`：

```ts
import type { Service } from '../index'
import type { Llm } from '../../providers/llm'

export type PlanTask = { id: string; description: string }
export type Plan = { name: string; tasks: PlanTask[] }
export type TaskOutcome = {
  taskId: string
  status: 'done' | 'needs-changes' | 'error'
  result: string
  review: string
}

export const PLAN_RUNNER_KEY = 'plan-runner'

export interface PlanRunner {
  run(plan: Plan): Promise<TaskOutcome[]>
}

// 事件契约：declaration merging 扩展 EventMap（内核首例，不改内核）
declare module '../events' {
  interface EventMap {
    'plan/task-start': { mode: 'emit'; in: { taskId: string } }
    'plan/task-done': { mode: 'emit'; in: { taskId: string; status: string } }
  }
}

async function chatText(llm: Llm, prompt: string): Promise<string> {
  let text = ''
  for await (const chunk of llm.chat({
    model: 'plan-runner',
    messages: [{ role: 'user', content: prompt }],
  })) {
    if (chunk.type === 'text' && chunk.content) text += chunk.content
  }
  return text
}

export const planRunnerService: Service = {
  inject: ['llm'],
  apply(ctx) {
    const llm = ctx.get<Llm>('llm')!
    const runner: PlanRunner = {
      async run(plan) {
        const outcomes: TaskOutcome[] = []
        for (const task of plan.tasks) {
          ctx.emit('plan/task-start', { taskId: task.id })
          const taskCtx = ctx.scope(task.id) // 每任务独立作用域（继承父层 llm 缝）
          let result = ''
          let review = ''
          try {
            result = await chatText(taskCtx.get<Llm>('llm')!, `Implement: ${task.description}`)
            review = await chatText(taskCtx.get<Llm>('llm')!, `Review: does the result satisfy "${task.description}"? Result: ${result}`)
          } catch (e) {
            outcomes.push({ taskId: task.id, status: 'error', result, review: String(e) })
            ctx.emit('plan/task-done', { taskId: task.id, status: 'error' })
            continue
          }
          const status: TaskOutcome['status'] = review.startsWith('APPROVE') ? 'done' : 'needs-changes'
          outcomes.push({ taskId: task.id, status, result, review })
          ctx.emit('plan/task-done', { taskId: task.id, status })
        }
        return outcomes
      },
    }
    ctx.provide(PLAN_RUNNER_KEY, runner)
  },
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test plan-runner`；`cd apps/cli && pnpm typecheck`。

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/vajra/leaf/plan-runner.ts apps/cli/test/vajra/leaf/plan-runner.test.ts
git commit -m "feat(vajra): plan-runner leaf — SDD orchestration as kernel service (llm seam + scope + emit)"
```

---

## Task 2: 换 provider 零 fork 测试（recordLlm 断言缝被消费）

**Files:**
- Test: `apps/cli/test/vajra/leaf/plan-runner.test.ts`（扩展）

**Interfaces:**
- Consumes: Task 1 的 `planRunnerService`/`PLAN_RUNNER_KEY`。

- [ ] **Step 1: 写失败测试**

追加：

```ts
  it('consumes the injected llm (recordLlm proves the seam, not a default)', async () => {
    const ctx = new Context()
    const recorder = recordLlm(replayLlm([text('X'), text('APPROVE')]))
    ctx.provide(LLM_KEY, recorder.llm)
    ctx.mount(planRunnerService)
    const runner = ctx.get<PlanRunner>(PLAN_RUNNER_KEY)!
    await runner.run({ name: 'p', tasks: [{ id: 't1', description: 'do X' }] })
    // implementer + reviewer 各一次 → 2 次 chat 走注入的缝
    expect(recorder.turns).toHaveLength(2)
    expect(recorder.turns[0]!.req.messages[0]!.content).toContain('Implement:')
    expect(recorder.turns[1]!.req.messages[0]!.content).toContain('Review:')
  })
```

（import 补 `recordLlm`。）

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test plan-runner`
Expected: FAIL——`recordLlm` 未导入或断言不成立（若已有 import 则断言失败）。

- [ ] **Step 3: 最小实现**

测试本身即实现（Task 1 的 `chatText` 已走 `ctx.get<Llm>('llm')`）；若 `recordLlm` 未导入则补 import。无 src 改动（除非断言暴露实现 gap）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test plan-runner`；`cd apps/cli && pnpm test` 全量。

- [ ] **Step 5: 提交**

```bash
git add apps/cli/test/vajra/leaf/plan-runner.test.ts
git commit -m "test(vajra): prove plan-runner consumes the injected llm seam (recordLlm)"
```

---

## Self-Review

**Spec coverage（§3.1/§7.1/§11）：**
- 事件契约 declaration merging（内核首例，不改内核）→ Task 1 `declare module '../events'` ✅
- 「装下一片真叶子」——Service + inject + scope + emit + llm 缝协同 → Task 1 ✅
- 换 provider 零 fork（llm-replay 替真 API）→ Task 2 ✅
- 依赖挂起/唤醒（mount 前 provide 后）→ Task 1 第二个测试 ✅

**Placeholder scan：** 无 TBD；每 Task 含确切代码。

**Type consistency：** `PlanTask`/`Plan`/`TaskOutcome`/`PlanRunner`/`PLAN_RUNNER_KEY`/`planRunnerService` 命名贯穿一致；事件名 `plan/task-start`/`plan/task-done` 一致。

**Deferred（不在本轮）**：子代理多轮工具执行（engine 职责）；plan-runner 经 profile bundle 挂载（composition 演示，后续）。
