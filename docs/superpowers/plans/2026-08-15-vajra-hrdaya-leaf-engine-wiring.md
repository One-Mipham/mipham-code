# Vajra-Hṛdaya 真叶子真引擎接线 — plan-runner model 缝 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 拔掉真叶子 plan-runner 的 `model: 'plan-runner'` 占位——把模型 id 变成可配置的缝（`createPlanRunnerService({ model? })`），默认 `''`（「用 active model」，由 `ProviderRegistry.chat` 的 `req.model || activeModelId` 回退），并加一个真引擎（ProviderRegistry）端到端测试证明占位已被 active model 取代。

**Architecture:** `plan-runner.ts` 目前 `chatText` 硬编码 `model: 'plan-runner'`（占位，真 provider 会 model lookup 失败）。本里程碑：① `chatText` 加 `model` 参数；② `createPlanRunnerService(options?: { model?: string }): Service` 工厂捕获 `model = options.model ?? ''`，`planRunnerService = createPlanRunnerService()`（默认实例，向后兼容既有 import）；③ 测试：recordLlm 证 model 缝可配（`'X'`）与默认 `''`；④ 真引擎测试：mount 到真 `ProviderRegistry`（mock provider，active model `'real-model'`）→ 两击 chat 均收到 `'real-model'`。生产 index.tsx 接线仍推迟（同先例）。

**Tech Stack:** TypeScript 5.5+ strict（ESM）、Bun/Node 22+、Vitest 3。

**Spec:** `docs/superpowers/specs/2026-08-15-vajra-hrdaya-kernel-design.md`（§5 能力缝、§7.5 真叶子交付）

## Global Constraints

- TS strict + ESM；Vitest 3；不硬编码凭据；Conventional Commits；中文注释风格（src 文件）；不 dispatch 子代理（implementer）。
- `Llm` 缝只暴露 `chat`（模型路由/`getActiveModel` 仍留 registry，同 M2b 先例——本里程碑不扩缝）。
- `replayLlm` 忽略 `req`、`recordLlm` 记录 `req`（改 model 不影响既有断言）。
- 测试命令：`cd apps/cli && pnpm test`；typecheck：`cd apps/cli && pnpm typecheck`。
- 分支 `feat/vajra-hrdaya-leaf-engine-wiring`。

---

## Task 1: createPlanRunnerService 工厂 + model 缝

**Files:**

- Modify: `apps/cli/src/vajra/leaf/plan-runner.ts`
- Test: `apps/cli/test/vajra/leaf/plan-runner.test.ts`（扩展）

**Interfaces:**

- Consumes: `Llm`（`providers/llm`）、`Service`（`../index`）。
- Produces: `createPlanRunnerService(options?: { model?: string }): Service`；`planRunnerService: Service`（`= createPlanRunnerService()`）；`chatText(llm, prompt, model)` 私有。

- [ ] **Step 1: 写失败测试**

`apps/cli/test/vajra/leaf/plan-runner.test.ts` 追加（import 补 `createPlanRunnerService`）：

```ts
it('accepts a configured model via createPlanRunnerService', async () => {
  const ctx = new Context()
  const recorder = recordLlm(replayLlm([text('X'), text('APPROVE')]))
  ctx.provide(LLM_KEY, recorder.llm)
  ctx.mount(createPlanRunnerService({ model: 'gpt-4o' }))
  const runner = ctx.get<PlanRunner>(PLAN_RUNNER_KEY)!
  await runner.run({ name: 'p', tasks: [{ id: 't1', description: 'do X' }] })
  expect(recorder.turns[0]!.req.model).toBe('gpt-4o')
})

it('defaults to empty model (use active model via registry fallback)', async () => {
  const ctx = new Context()
  const recorder = recordLlm(replayLlm([text('X'), text('APPROVE')]))
  ctx.provide(LLM_KEY, recorder.llm)
  ctx.mount(planRunnerService)
  const runner = ctx.get<PlanRunner>(PLAN_RUNNER_KEY)!
  await runner.run({ name: 'p', tasks: [{ id: 't1', description: 'do X' }] })
  expect(recorder.turns[0]!.req.model).toBe('') // 占位 'plan-runner' 已拔
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test plan-runner`
Expected: FAIL——`createPlanRunnerService` 未导出 / `req.model` 仍为 `'plan-runner'`。

- [ ] **Step 3: 最小实现**

`apps/cli/src/vajra/leaf/plan-runner.ts` 重构（保持事件声明、类型不变）：

```ts
async function chatText(llm: Llm, prompt: string, model: string): Promise<string> {
  let text = ''
  for await (const chunk of llm.chat({
    model,
    messages: [{ role: 'user', content: prompt }],
  })) {
    if (chunk.type === 'text' && chunk.content) text += chunk.content
  }
  return text
}

/** 创建 plan-runner Service。model 缺省为空串（「用 active model」，由 ProviderRegistry 的 req.model || activeModelId 回退）；传值则锁定该模型。 */
export function createPlanRunnerService(options: { model?: string } = {}): Service {
  const model = options.model ?? ''
  return {
    inject: ['llm'],
    apply(ctx) {
      const runner: PlanRunner = {
        async run(plan) {
          const outcomes: TaskOutcome[] = []
          for (const task of plan.tasks) {
            ctx.emit('plan/task-start', { taskId: task.id })
            const taskCtx = ctx.scope(task.id) // 每任务独立作用域（继承父层 llm 缝）
            let result = ''
            let review = ''
            try {
              result = await chatText(
                taskCtx.get<Llm>('llm')!,
                `Implement: ${task.description}`,
                model,
              )
              review = await chatText(
                taskCtx.get<Llm>('llm')!,
                `Review: does the result satisfy "${task.description}"? Result: ${result}`,
                model,
              )
            } catch (e) {
              outcomes.push({ taskId: task.id, status: 'error', result, review: String(e) })
              ctx.emit('plan/task-done', { taskId: task.id, status: 'error' })
              continue
            }
            const status: TaskOutcome['status'] = review.startsWith('APPROVE')
              ? 'done'
              : 'needs-changes'
            outcomes.push({ taskId: task.id, status, result, review })
            ctx.emit('plan/task-done', { taskId: task.id, status })
          }
          return outcomes
        },
      }
      ctx.provide(PLAN_RUNNER_KEY, runner)
    },
  }
}

/** 默认 plan-runner Service（model 空串 = 用 active model）。 */
export const planRunnerService: Service = createPlanRunnerService()
```

（`PLAN_RUNNER_KEY`/类型/事件声明 declaration merging 保持原样不动。）

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test plan-runner`；`cd apps/cli && pnpm typecheck`。

- [ ] **Step 5: 提交**

```bash
git add apps/cli/src/vajra/leaf/plan-runner.ts apps/cli/test/vajra/leaf/plan-runner.test.ts
git commit -m "feat(vajra): createPlanRunnerService factory — model seam replaces 'plan-runner' placeholder"
```

---

## Task 2: 真引擎（ProviderRegistry）端到端测试

**Files:**

- Test: `apps/cli/test/vajra/leaf/plan-runner.test.ts`（扩展）

**Interfaces:**

- Consumes: Task 1 的 `planRunnerService`/`createPlanRunnerService`/`PLAN_RUNNER_KEY`/`PlanRunner`；`ProviderRegistry`/`ProviderInstance`/`ChatRequest`（`providers/registry`）；`ProviderConfig`（`../shared`）。

- [ ] **Step 1: 写失败测试**

追加（import 补 `ProviderRegistry`、`ProviderInstance`、`ChatRequest`、`ProviderConfig`）：

```ts
function makeMockProvider(
  config: ProviderConfig,
  onModel: (model: string) => void,
): ProviderInstance {
  return {
    config,
    async *chat(req: ChatRequest) {
      onModel(req.model)
      yield { type: 'text', content: 'APPROVE' }
      yield { type: 'stop' }
    },
    listModels: async () => config.models.filter((m) => m.status === 'active'),
    healthCheck: async () => true,
  }
}

it('uses the registry active model when mounted against a real engine', async () => {
  const config: ProviderConfig = {
    id: 'test-provider',
    name: 'Test Provider',
    protocol: 'openai-compatible',
    baseUrl: 'https://api.test.com/v1',
    apiKey: '${TEST_API_KEY}',
    models: [
      {
        id: 'real-model',
        name: 'Real Model',
        providerId: 'test-provider',
        contextWindow: 128_000,
        maxOutput: 32_000,
        vision: false,
        status: 'active',
      },
    ],
  }
  const seenModels: string[] = []
  const registry = new ProviderRegistry([config], 'test-provider', 'real-model')
  registry.register(
    'test-provider',
    makeMockProvider(config, (m) => seenModels.push(m)),
  )

  const ctx = new Context()
  ctx.provide(LLM_KEY, registry) // 真引擎：ProviderRegistry 作为 llm 缝
  ctx.mount(planRunnerService)
  const runner = ctx.get<PlanRunner>(PLAN_RUNNER_KEY)!
  const outcomes = await runner.run({ name: 'p', tasks: [{ id: 't1', description: 'do A' }] })

  expect(outcomes[0]!.status).toBe('done') // mock provider 一律 APPROVE
  expect(seenModels).toHaveLength(2) // implementer + reviewer 各一次
  expect(seenModels.every((m) => m === 'real-model')).toBe(true) // 占位已由 active model 取代
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd apps/cli && pnpm test plan-runner`
Expected: FAIL——`ProviderRegistry`/`ProviderConfig` 未导入，或占位 `'plan-runner'` 未拔（若 Task 1 已合，则本测试应直接过——报告 DONE_WITH_CONCERNS，注明依赖 Task 1）。

- [ ] **Step 3: 最小实现**

测试本身即实现（Task 1 已拔占位）；若 import 缺失则补。无 src 改动。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd apps/cli && pnpm test plan-runner`；`cd apps/cli && pnpm test` 全量。

- [ ] **Step 5: 提交**

```bash
git add apps/cli/test/vajra/leaf/plan-runner.test.ts
git commit -m "test(vajra): prove plan-runner uses registry active model end-to-end"
```

---

## Self-Review

**Spec coverage（§5/§7.5）：**

- 能力缝换实现（provider 换实现零 fork）→ Task 2 真 ProviderRegistry 端到端 ✅
- model 缝可配（config 传播）→ Task 1 `createPlanRunnerService({ model })` ✅
- 占位 `'plan-runner'` 拔除 → Task 1 默认 `''` + Task 2 `every === 'real-model'` ✅

**Placeholder scan：** 无 TBD；每 Step 含确切代码与测试。

**Type consistency：** `createPlanRunnerService`/`planRunnerService`/`PLAN_RUNNER_KEY`/`PlanRunner` 命名贯穿一致；`chatText(llm, prompt, model)` 三参贯穿；`ProviderConfig`/`ModelInfo` 字段对齐 `src/shared/types.ts`（local，非 @mipham/shared）。

**Deferred（不在本轮）**：生产 index.tsx 从 profile 组装（live startup）；`ctx.model` 能力缝（路由/`getActiveModel` 仍留 registry，同 M2b）；`ServiceResolver` 读 `line.config.model` 传给工厂（compose 层消费，后续里程碑接）。
