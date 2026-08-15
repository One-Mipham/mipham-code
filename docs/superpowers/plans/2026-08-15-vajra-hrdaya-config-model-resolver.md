# Vajra-Hṛdaya gap④ — ServiceResolver 读 config.model 传工厂 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 闭环 model 缝的 config 传播——真叶子 plan-runner 提供一个「从 bundle 行解析 Service」的 resolver 助手 `planRunnerFromLine(line)`，读 `line.config.model` 传给 `createPlanRunnerService({ model })`；`id` 非 `plan-runner` 或纯数据行返回 `undefined`。这是 compose 层「要挂的代码」由调用方注入时，plan-runner 侧的默认解析器。

**Architecture:** 在 `apps/cli/src/vajra/leaf/plan-runner.ts` 加 `planRunnerFromLine(line: BundleLine): Service | undefined`（import `BundleLine` 自 `../compose/bundle`，无环——compose 不 import leaf）。compose 层保持解耦（仍由调用方注入 resolver，不硬编码）。

**Tech Stack:** TypeScript 5.5+ strict（ESM）、Bun/Node 22+、Vitest 3。

**Spec:** `docs/superpowers/specs/2026-08-15-vajra-hrdaya-kernel-design.md`（§5 能力缝、§6 声明式组合「bundle = 配置行 + 要挂的代码」）

## Global Constraints

- TS strict + ESM；Vitest 3；不硬编码凭据；Conventional Commits；中文注释风格；不 dispatch 子代理（implementer）。
- compose 层不硬编码 leaf（`ServiceResolver` 仍由调用方注入）；`planRunnerFromLine` 是 leaf 侧的默认解析器，供生产 bootstrap/测试作 `ServiceResolver` 用。
- 测试命令：`cd apps/cli && pnpm test`；typecheck：`cd apps/cli && pnpm typecheck`。
- 分支 `feat/vajra-hrdaya-config-model-resolver`。

---

## Task 1: planRunnerFromLine resolver 助手 + config.model 传播

**Files:**
- Modify: `apps/cli/src/vajra/leaf/plan-runner.ts`
- Test: `apps/cli/test/vajra/leaf/plan-runner.test.ts`（扩展）

**Interfaces:**
- Consumes: `BundleLine`（`../compose/bundle`）、`Service`（`../index`）、`createPlanRunnerService`（本文件）。
- Produces: `planRunnerFromLine(line: BundleLine): Service | undefined`。

- [ ] **Step 1: 写失败测试**

`apps/cli/test/vajra/leaf/plan-runner.test.ts` 追加（import 补 `planRunnerFromLine` + `BundleLine` type）：

```ts
it('planRunnerFromLine reads config.model into the service', async () => {
  const ctx = new Context()
  const recorder = recordLlm(replayLlm([text('X'), text('APPROVE')]))
  ctx.provide(LLM_KEY, recorder.llm)
  const service = planRunnerFromLine({
    id: 'plan-runner',
    kind: 'service',
    config: { model: 'gpt-4o' },
  })!
  ctx.mount(service)
  const runner = ctx.get<PlanRunner>(PLAN_RUNNER_KEY)!
  await runner.run({ name: 'p', tasks: [{ id: 't1', description: 'do X' }] })
  expect(recorder.turns[0]!.req.model).toBe('gpt-4o')
})

it('planRunnerFromLine returns undefined for non-plan-runner lines', () => {
  expect(
    planRunnerFromLine({ id: 'package-info', kind: 'provider', config: {} }),
  ).toBeUndefined()
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test plan-runner`
Expected: FAIL——`planRunnerFromLine` 未导出。

- [ ] **Step 3: 最小实现**

`apps/cli/src/vajra/leaf/plan-runner.ts`：import 补 `BundleLine`（`import type { BundleLine } from '../compose/bundle'`）；文件末尾追加：

```ts
/** 从 bundle 行解析 plan-runner Service（读 config.model 传工厂；id 非 plan-runner 或纯数据行返回 undefined）。 */
export function planRunnerFromLine(line: BundleLine): Service | undefined {
  if (line.id !== 'plan-runner') return undefined
  const model = typeof line.config.model === 'string' ? line.config.model : undefined
  return createPlanRunnerService({ model })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test plan-runner`；`cd apps/cli && pnpm typecheck`。

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/vajra/leaf/plan-runner.ts apps/cli/test/vajra/leaf/plan-runner.test.ts
git commit -m "feat(vajra): planRunnerFromLine resolver — config.model propagates to the leaf"
```

---

## Self-Review

**Spec coverage（§5/§6）：** config 传播闭环（bundle 行 config.model → 工厂）→ Task 1 ✅；compose 层解耦（resolver 由调用方注入）→ `planRunnerFromLine` 是 leaf 侧助手，compose 不 import leaf ✅

**Placeholder scan：** 无 TBD；每 Step 含确切代码与测试。

**Type consistency：** `planRunnerFromLine`/`createPlanRunnerService`/`BundleLine` 命名贯穿一致；`line.config.model` 判 `typeof === 'string'` 后传参，未配置则 `undefined`（走默认 `''`）。

**Deferred（不在本轮）**：gap③ compose live startup（`--dump-config` CLI + schema 校验 + scope 清理）——下一里程碑；gap① replaceMessages 日志；gap② 生产 mount 接线。
